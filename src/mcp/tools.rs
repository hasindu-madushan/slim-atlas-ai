use std::sync::Arc;
use std::time::Instant;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::ErrorData as McpError;
use rmcp::schemars::JsonSchema;
use rmcp::{tool, tool_router};
use serde::{Deserialize, Serialize};

use crate::error::{BrowserError, IntoMcpError};
use crate::session::id;
use crate::session::{CurrentPage, HistoryEntry};
use crate::state::AppState;
use crate::tiers::HtmlPage;
use crate::utils::{all_matches, extract_text, first_match};

// =====================================================================
// Input / output schemas
// =====================================================================
//
// Input structs derive `JsonSchema` so the `#[tool]` macro can publish the
// tool's input schema to MCP clients. Output structs are plain `Serialize`
// return types for `_impl`; the wire shims serialize them with
// `serde_json::to_string` and return `String`. This keeps the wire payload
// to a single `content[0].text` JSON string — no `structuredContent`
// duplicate.

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavigateInput {
    /// Optional. Omit on the first call to create a new session; pass back the
    /// returned `session_id` on subsequent calls.
    pub session_id: Option<String>,
    /// The URL to fetch.
    pub url: String,
    /// Force a specific tier. Phase 1 accepts only `1`; values 2+ return `TierDisabled`.
    pub force_tier: Option<u8>,
    /// Phase 1: accepted but ignored (logs a warning if set).
    pub wait_for: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NavigateOutput {
    pub session_id: String,
    pub title: String,
    pub url: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetTextInput {
    pub session_id: String,
    /// Optional CSS selector. When set, returns the cleaned text of the matching
    /// sub-tree. When omitted, returns the full page.
    pub selector: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GetTextOutput {
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SelectorInput {
    pub session_id: String,
    /// Optional CSS selector. When set, scopes the result to the matching
    /// sub-tree. When omitted, returns the whole page.
    pub selector: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GetHtmlOutput {
    pub html: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryInput {
    pub session_id: String,
    pub selector: String,
}

#[derive(Debug, Serialize)]
pub struct QueryElement {
    pub html: String,
    pub text: String,
    pub attrs: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct QueryOutput {
    pub elements: Vec<QueryElement>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClickInput {
    pub session_id: String,
    /// CSS selector for the element to click. Phase 1 (T1-only) requires this
    /// to match an `<a href="...">` link with a usable http(s) URL. Other
    /// elements (buttons, divs, form submits, mailto:/javascript:/#fragment
    /// links) return `SelectorNotFound`; T2 escalation handles them in Phase 3.
    pub selector: String,
    /// Optional. Phase 1 (T1-only): accepted but ignored with a warning.
    /// Phase 3 (T2): Deno polls the post-click DOM for this selector up to
    /// `wait_timeout_ms`.
    pub wait_for: Option<String>,
    /// Optional. Phase 1: ignored. Phase 3: max ms to wait for `wait_for`.
    pub wait_timeout_ms: Option<u64>,
    /// Optional. Phase 1 accepts only `Some(1)` or `None` (T1 default);
    /// `Some(2)` returns `TierDisabled` (-32003) because T2 is not yet
    /// implemented. Phase 3 will auto-escalate on `Some(2)` or `None`.
    pub force_tier: Option<u8>,
}

#[derive(Debug, Serialize)]
pub struct ClickOutput {
    /// Always `true` on success (the `<a href>` was followed and the new
    /// page was fetched). Phase 3 may return `false` if a T2 click was
    /// dispatched but the operation reported a soft failure.
    pub success: bool,
    /// `Some` iff the click caused a navigation. Phase 1 (T1 href path):
    /// always `Some(<resolved href>)`. Phase 3 (T2): `Some` only if
    /// `window.location.href` changed or `history.pushState` fired.
    pub new_url: Option<String>,
    pub elapsed_ms: u64,
}

// =====================================================================
// Server
// =====================================================================

#[derive(Clone)]
pub struct McpServer {
    pub state: Arc<AppState>,
}

impl McpServer {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

#[tool_router(server_handler)]
impl McpServer {
    // ---- public testable inner fns (no Parameters/Json wrappers) ----

    pub async fn navigate_impl(&self, input: NavigateInput) -> Result<NavigateOutput, McpError> {
        if let Some(forced) = input.force_tier {
            if forced != 1 {
                return Err(BrowserError::TierDisabled { tier: forced }.into_mcp_error());
            }
        }
        if input.wait_for.is_some() {
            tracing::warn!("navigate: wait_for is accepted but ignored in Phase 1");
        }

        let url = url::Url::parse(&input.url).map_err(BrowserError::Url)?;
        self.state.security.assert_host_allowed(&url)?;

        let started = Instant::now();

        let before_mem = self
            .state
            .memory
            .lock()
            .expect("memory probe mutex poisoned")
            .sample(&self.state.child_pids());
        tracing::info!(
            server_rss_bytes = before_mem.server_rss,
            child_rss_bytes = before_mem.child_rss,
            url = %url,
            "memory before navigate"
        );

        let id_for_lookup = input
            .session_id
            .as_deref()
            .map(parse_session_id)
            .transpose()?;
        let (session_id, cookies) = self
            .state
            .sessions
            .with_session(id_for_lookup, |s| Ok((s.id.clone(), s.cookies.jar())))?;

        let tier1 = self.state.build_tier1(cookies);
        let fetch = tier1.fetch(url.as_str()).await?;
        let page = HtmlPage::from_fetch(fetch)?;
        let framework = page.detect_framework();
        let text = page.extract_text();
        let title = page.title();
        let final_url = page.base_url().to_string();
        let html = page.html();

        let elapsed_ms = started.elapsed().as_millis() as u64;

        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let entry = HistoryEntry {
            url: final_url.clone(),
            title: title.clone(),
            tier: 1,
            timestamp_ms,
        };
        let framework_for_commit = framework.clone();
        let final_url_for_commit = final_url.clone();
        let title_for_commit = title.clone();
        let text_for_commit = text.clone();
        let html_for_commit = html.clone();

        self.state
            .sessions
            .with_session(Some(session_id.clone()), move |s| {
                s.history.push(entry);
                s.current_page = Some(CurrentPage {
                    url: final_url_for_commit,
                    title: title_for_commit,
                    text: text_for_commit,
                    html: html_for_commit,
                    framework: Some(framework_for_commit),
                });
                s.current_tier = 1;
                s.last_framework_hint = Some(framework);
                s.touch();
                Ok(())
            })?;

        let after_mem = self
            .state
            .memory
            .lock()
            .expect("memory probe mutex poisoned")
            .sample(&self.state.child_pids());
        let delta_server = after_mem.server_rss as i64 - before_mem.server_rss as i64;
        tracing::info!(
            server_rss_bytes = after_mem.server_rss,
            child_rss_bytes = after_mem.child_rss,
            delta_server_rss_bytes = delta_server,
            elapsed_ms,
            "memory after navigate"
        );

        Ok(NavigateOutput {
            session_id: session_id.clone(),
            title,
            url: final_url,
            elapsed_ms,
        })
    }

    pub fn get_text_impl(&self, input: GetTextInput) -> Result<GetTextOutput, McpError> {
        with_session(&self.state, &input.session_id, |s| {
            let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
            extract_text_for_subtree(&page.html, input.selector.as_deref())
        })
        .map(|text| GetTextOutput { text })
    }

    pub fn get_html_impl(&self, input: SelectorInput) -> Result<GetHtmlOutput, McpError> {
        with_session(&self.state, &input.session_id, |s| {
            let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
            extract_html_for_subtree(&page.html, input.selector.as_deref())
        })
        .map(|html| GetHtmlOutput { html })
    }

    pub fn query_impl(&self, input: QueryInput) -> Result<QueryOutput, McpError> {
        with_session(&self.state, &input.session_id, |s| {
            let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
            collect_query_results(&page.html, &input.selector)
        })
        .map(|elements| QueryOutput { elements })
    }

    // -----------------------------------------------------------------
    // `click` tool — T1 fast path (Phase 1)
    // -----------------------------------------------------------------
    //
    // Phase 1 only handles `<a href>` links. We parse the current page's
    // HTML in-process, look for an `<a>` matching the selector, resolve the
    // href against the current URL, run the existing T1 fetch + commit
    // pipeline. No Deno call, no JS execution. ~10-50 ms latency.
    //
    // Failure cases (all surface as `SelectorNotFound` for now):
    //   - selector matches no element
    //   - selector matches a non-`<a>` element (button, div, form, ...)
    //   - element is an `<a>` without an `href` attribute
    //   - `href` is non-http(s): mailto:, tel:, javascript:, data:,
    //     vbscript:, fragment-only (#section), or unparseable
    //
    // All of the above are T2-escalation candidates in Phase 3 (see the
    // big comment block above the `#[tool]` shim for the full plan).
    // -----------------------------------------------------------------
    pub async fn click_impl(&self, input: ClickInput) -> Result<ClickOutput, McpError> {
        // ----- TIER VALIDATION (Phase 1) -----
        if input.force_tier == Some(2) {
            // T2 isn't built yet. Phase 3 will accept this and escalate.
            return Err(BrowserError::TierDisabled { tier: 2 }.into_mcp_error());
        }
        if input.wait_for.is_some() || input.wait_timeout_ms.is_some() {
            tracing::warn!(
                "click: wait_for/wait_timeout_ms are accepted but ignored in Phase 1 (T1-only)"
            );
        }

        let session_id = parse_session_id(&input.session_id)?;

        // ----- READ SESSION STATE + COOKIES (one shard lock) -----
        let (current_url, current_html, cookies) =
            self.state
                .sessions
                .with_session(Some(session_id.clone()), |s| {
                    let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
                    Ok((page.url.clone(), page.html.clone(), s.cookies.jar()))
                })?;

        // ----- T1 FAST PATH: try to follow an `<a href>` link -----
        let base = url::Url::parse(&current_url).map_err(BrowserError::Url)?;
        let target =
            try_t1_href_click(&current_html, &input.selector, &base)?.ok_or_else(|| {
                BrowserError::SelectorNotFound {
                    selector: format!(
                        "{} (no clickable `<a href>` element matched; Phase 1 (T1) only handles \
                     `<a href>` links. Buttons, divs, forms, mailto:/javascript:/#fragment \
                     links, and any JS-driven click target require Tier 2 (Deno) — planned \
                     for Phase 3 with auto-escalation.)",
                        input.selector
                    ),
                }
            })?;

        // Host allowlist check (e.g. an `<a>` on a T1 page pointing to a
        // blocked host is a security violation, not a navigation).
        self.state.security.assert_host_allowed(&target)?;

        // ----- T1 FETCH (re-uses the navigate path's tier-1 + commit) -----
        let started = Instant::now();
        let tier1 = self.state.build_tier1(cookies);
        let fetch = tier1.fetch(target.as_str()).await?;
        let page = HtmlPage::from_fetch(fetch)?;
        let framework = page.detect_framework();
        let text = page.extract_text();
        let title = page.title();
        let final_url = page.base_url().to_string();
        let html = page.html();
        let elapsed_ms = started.elapsed().as_millis() as u64;

        // ----- COMMIT (sync, same shape as navigate) -----
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let entry = HistoryEntry {
            url: final_url.clone(),
            title: title.clone(),
            tier: 1,
            timestamp_ms,
        };
        let framework_for_commit = framework.clone();
        let final_url_for_commit = final_url.clone();
        let title_for_commit = title.clone();
        let text_for_commit = text.clone();
        let html_for_commit = html.clone();

        self.state
            .sessions
            .with_session(Some(session_id.clone()), move |s| {
                s.history.push(entry);
                s.current_page = Some(CurrentPage {
                    url: final_url_for_commit,
                    title: title_for_commit,
                    text: text_for_commit,
                    html: html_for_commit,
                    framework: Some(framework_for_commit),
                });
                s.current_tier = 1;
                s.last_framework_hint = Some(framework);
                s.touch();
                Ok(())
            })?;

        Ok(ClickOutput {
            success: true,
            new_url: Some(final_url),
            elapsed_ms,
        })
    }

    // ---- MCP transport shims (the macro generates the router from these) ----
    //
    // Shims return `String` (not `Json<OutputType>`) so the wire payload is
    // a single `content[0].text` JSON string — no `structuredContent` field
    // is emitted, no duplication. `serde_json::to_string` is infallible for
    // our types but we still map the error for defensive purposes.

    #[tool(
        name = "navigate",
        description = "Fetch a URL and return an acknowledgement: session_id, title, final URL, \
            and elapsed_ms. Content is fetched via the `get_text` / `get_html` tools in the \
            returned session. If `session_id` is omitted, a new session is created. Phase 1 \
            always uses tier 1 (plain HTTP)."
    )]
    async fn navigate(
        &self,
        Parameters(input): Parameters<NavigateInput>,
    ) -> Result<String, McpError> {
        let out = self.navigate_impl(input).await?;
        serialize_output(&out)
    }

    #[tool(
        name = "get_text",
        description = "Return cleaned text of the current page. If `selector` is given, returns \
            the cleaned text of the matching sub-tree. The page must have been navigated to \
            earlier in this session."
    )]
    fn get_text(&self, Parameters(input): Parameters<GetTextInput>) -> Result<String, McpError> {
        let out = self.get_text_impl(input)?;
        serialize_output(&out)
    }

    #[tool(
        name = "get_html",
        description = "Return the raw HTML of the current page. If `selector` is given, returns \
            the inner HTML of the first matching element."
    )]
    fn get_html(&self, Parameters(input): Parameters<SelectorInput>) -> Result<String, McpError> {
        let out = self.get_html_impl(input)?;
        serialize_output(&out)
    }

    #[tool(
        name = "query",
        description = "Run a CSS selector against the current page and return matching elements \
            with their HTML, text, and attributes."
    )]
    fn query(&self, Parameters(input): Parameters<QueryInput>) -> Result<String, McpError> {
        let out = self.query_impl(input)?;
        serialize_output(&out)
    }

    // =====================================================================
    // `click` tool — T1 fast path shim
    // =====================================================================
    //
    // PHASE 3 PLAN: T2 ESCALATION
    // ---------------------------
    // The Phase 1 implementation handles only `<a href>` links. For Phase 3
    // (Deno subprocess tier), the `click` tool needs to escalate to T2 when
    // the matched element is not an `<a href>` with a usable http(s) URL.
    //
    // Escalation trigger (cases that return `SelectorNotFound` in Phase 1):
    //   - selector matches no element           (cannot escalate — true error)
    //   - selector matches a non-`<a>` element  (button, div, form, ...)
    //   - `<a>` with no `href` attribute        (placeholder / button-styled)
    //   - `<a href="mailto:...">`, `tel:`, `data:`, `vbscript:`
    //   - `<a href="javascript:...">`           (security: prefer escalation)
    //   - `<a href="#section">` (fragment-only) (no real navigation)
    //
    // Escalation contract:
    //   - `force_tier: None`        -> try T1 fast path; on miss, escalate T2
    //   - `force_tier: Some(1)`     -> T1 only; SelectorNotFound on miss
    //   - `force_tier: Some(2)`     -> skip T1, go straight to T2
    //   - Tier 2 must be enabled in config (`tiers.enabled` contains 2);
    //     otherwise return `TierDisabled { tier: 2 }` (-32003)
    //
    // T2 click flow (planned):
    //   1. DenoPool.checkout() — get a DenoWorker (blocks if pool exhausted)
    //   2. Serialize ClickRequest to Deno stdin:
    //        { mode: "click",
    //          url, html (current_page.html, for T2 session reuse),
    //          cookies: jar.to_header_value(url),
    //          headers: session.custom_headers,
    //          selector, wait_for, wait_timeout_ms, render_timeout_ms }
    //   3. Deno: parse HTML, find selector, dispatch MouseEvent('click'),
    //      optionally poll for wait_for, detect navigation (location.href
    //      change OR history.pushState), return post-click state.
    //   4. DenoPool.checkin(worker) — return to pool, start idle timer.
    //   5. Commit to session:
    //        for sc in result.set_cookies: jar.merge_from_header(sc, url)
    //        history.push(HistoryEntry { ... tier: 2, ... })
    //        current_page = CurrentPage { ... result ... }
    //        current_tier = 2   // promote T1 session to T2
    //        last_framework_hint = result.framework
    //        touch()
    //   6. Return ClickOutput { success: true, new_url: result.new_url, ... }
    //
    // T1 → T2 promotion rules:
    //   - Called on a T1 session: T2 re-fetches the URL (using session's
    //     cookies + custom_headers) and dispatches the click. The session
    //     is promoted to `current_tier = 2`. Future get_text/get_html/query
    //     see the T2-rendered content.
    //   - Called on a T2 session: T2 reuses the current page state (no
    //     re-fetch); just dispatches the click. Session stays at T2.
    //   - T1 fast path is NOT applied to T2 sessions even for `<a href>`
    //     — preserves content quality (T1 fetch of a CSR page is an empty
    //     shell; T2 renders the JS-driven DOM).
    //
    // Edge cases (open decisions for Phase 3):
    //   - History entry: only on navigation (recommended) — matches browser
    //     back-button semantics; click on a button that doesn't navigate
    //     doesn't pollute history.
    //   - `target="_blank"`: ignore target, just follow href (recommended).
    //   - `wait_for` becomes meaningful in T2: Deno polls the post-click
    //     DOM for the selector up to `wait_timeout_ms`.
    //   - Cancellation: `Session::in_flight_render: Option<Arc<Notify>>`
    //     so `soft_reset` / eviction can abort a long-running Deno click.
    //   - Deno script: extend `deno/render.ts` with a `mode: "click"` branch
    //     (single binary, less duplication) — recommended over a separate
    //     `deno/click.ts`.
    //
    // Wire shape (unchanged between phases):
    //   {
    //     "success": true,
    //     "new_url": "https://example.com/page-two" | null,
    //     "elapsed_ms": 42
    //   }
    // =====================================================================
    #[tool(
        name = "click",
        description = "Click the first element matching `selector` on the current page. \
            Phase 1 (T1-only) only handles `<a href>` links — for those, the tool resolves \
            the href and follows it via plain HTTP. Other click targets (buttons, divs, forms, \
            mailto:/javascript:/#fragment links) return SelectorNotFound; Tier 2 (Deno) \
            escalation is planned for Phase 3. Returns `success: true` if the click was \
            dispatched. If the click caused a navigation, `new_url` is set."
    )]
    async fn click(&self, Parameters(input): Parameters<ClickInput>) -> Result<String, McpError> {
        let out = self.click_impl(input).await?;
        serialize_output(&out)
    }
}

// =====================================================================
// Helpers
// =====================================================================

fn serialize_output<T: Serialize>(value: &T) -> Result<String, McpError> {
    serde_json::to_string(value)
        .map_err(|e| BrowserError::Parse(format!("serialize tool output: {e}")).into_mcp_error())
}

fn with_session<F, R>(state: &AppState, raw_id: &str, f: F) -> Result<R, McpError>
where
    F: FnOnce(&mut crate::session::Session) -> Result<R, BrowserError>,
{
    let id = parse_session_id(raw_id)?;
    state.sessions.assert_exists(&id)?;
    state
        .sessions
        .with_session(Some(id), f)
        .map_err(IntoMcpError::into_mcp_error)
}

fn parse_session_id(s: &str) -> Result<String, BrowserError> {
    id::validate(s)
}

fn extract_text_for_subtree(html: &str, selector: Option<&str>) -> Result<String, BrowserError> {
    let document = scraper::Html::parse_document(html);
    match selector {
        Some(sel) => {
            let el = first_match(&document, sel)?;
            let inner = el.inner_html();
            let wrapped = format!("<html><body>{inner}</body></html>");
            let sub = scraper::Html::parse_document(&wrapped);
            Ok(extract_text(&sub))
        }
        None => Ok(extract_text(&document)),
    }
}

fn extract_html_for_subtree(html: &str, selector: Option<&str>) -> Result<String, BrowserError> {
    let document = scraper::Html::parse_document(html);
    match selector {
        Some(sel) => {
            let el = first_match(&document, sel)?;
            Ok(el.inner_html())
        }
        None => Ok(document.html()),
    }
}

fn collect_query_results(html: &str, selector: &str) -> Result<Vec<QueryElement>, BrowserError> {
    let document = scraper::Html::parse_document(html);
    let matches = all_matches(&document, selector)?;
    let mut out = Vec::with_capacity(matches.len());
    for el in matches {
        let html = el.inner_html();
        let text = el.text().collect::<Vec<_>>().join(" ");
        let attrs: std::collections::HashMap<String, String> = el
            .value()
            .attrs()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        out.push(QueryElement { html, text, attrs });
    }
    Ok(out)
}

/// T1 fast path for `click`: extract the resolved href from an `<a>` element
/// matching `selector`. Returns `Some(url)` if the matched element is an
/// `<a>` with a usable http(s) href, `None` if the click must be escalated
/// to T2 (Phase 3).
///
/// Returns `Err(SelectorNotFound)` only if `selector` itself is
/// syntactically invalid. The "element doesn't match" case is `Ok(None)` —
/// the caller decides whether that's a true error (no element to click) or
/// an escalation candidate (element is not an `<a href>` link).
///
/// The full Phase 1 (T1) set of "T2 escalation candidates" lives in the
/// comment block above the `#[tool]` shim for `click`; this helper encodes
/// the "is this an `<a href>` with an http(s) URL?" half of that decision.
fn try_t1_href_click(
    html: &str,
    selector: &str,
    base: &url::Url,
) -> Result<Option<url::Url>, BrowserError> {
    let doc = scraper::Html::parse_document(html);
    let sel = scraper::Selector::parse(selector).map_err(|_| BrowserError::SelectorNotFound {
        selector: selector.to_string(),
    })?;
    let Some(el) = doc.select(&sel).next() else {
        return Ok(None);
    };
    if el.value().name() != "a" {
        return Ok(None);
    }
    let Some(href) = el.value().attr("href") else {
        return Ok(None);
    };
    // Fragment-only hrefs (`<a href="#section">`) resolve to the same URL
    // with a fragment, which T1 would happily re-fetch (no-op navigation).
    // Reject them — they require T2 to dispatch the click and (eventually)
    // scroll to the anchor. See Phase 3 plan.
    if href.starts_with('#') {
        return Ok(None);
    }
    let Ok(resolved) = base.join(href) else {
        return Ok(None);
    };
    if !matches!(resolved.scheme(), "http" | "https") {
        return Ok(None);
    }
    Ok(Some(resolved))
}
