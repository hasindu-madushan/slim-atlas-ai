use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::ErrorData as McpError;
use rmcp::schemars::JsonSchema;
use rmcp::{tool, tool_router};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{BrowserError, IntoMcpError};
use crate::router::navigation::{self, ClickResult, NavigateResult};
use crate::session::id;
use crate::state::AppState;
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
    /// Wait for a CSS selector to appear in the rendered DOM before returning.
    pub wait_for: Option<String>,
    /// Max ms to wait for `wait_for` to appear.
    pub wait_timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct NavigateOutput {
    pub session_id: String,
    pub title: String,
    pub url: String,
    pub elapsed_ms: u64,
    /// RSS in bytes for the slim-atlas server process.
    pub server_rss_bytes: u64,
    /// RSS in bytes summed across tracked child PIDs (Deno subprocesses).
    pub child_rss_bytes: u64,
    /// Convenience total: `server_rss_bytes + child_rss_bytes`.
    pub total_rss_bytes: u64,
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
    /// CSS selector for the element to click. The element is clicked through
    /// Deno which handles all element types including buttons, divs,
    /// form submits, and JavaScript-driven targets.
    pub selector: String,
    /// Optional. Deno polls the post-click DOM for this selector up to
    /// `wait_timeout_ms`.
    pub wait_for: Option<String>,
    /// Optional. Max ms to wait for `wait_for`.
    pub wait_timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ClickOutput {
    /// Always `true` on success (the element was clicked and the
    /// operation completed).
    pub success: bool,
    /// `Some` iff the click caused a navigation.
    pub new_url: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FillInput {
    pub session_id: String,
    /// CSS selector for the input/textarea to fill. Deno walks the
    /// current page's DOM to find the element. Returns `SelectorNotFound`
    /// if no match.
    pub selector: String,
    /// The value to put into the field.
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct FillOutput {
    /// The selector that was filled. Echoed back so the agent can
    /// verify what was actually mutated.
    pub selector: String,
    /// The final value reported by Deno (may differ from the input if
    /// the field had a `pattern` or normalization step applied).
    pub value: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubmitInput {
    pub session_id: String,
    /// Optional CSS selector for a specific `<form>`. When omitted, the
    /// first form on the page is submitted.
    pub selector: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SubmitOutput {
    /// `Some` iff the submit caused a navigation (the form's `action`
    /// resolved to a different URL, or the response redirected).
    pub new_url: Option<String>,
    pub title: String,
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
        let url = url::Url::parse(&input.url).map_err(BrowserError::Url)?;
        self.state.security.assert_host_allowed(&url)?;

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
        let session_id = match id_for_lookup.clone() {
            Some(id) => {
                self.state.sessions.assert_exists(&id)?;
                id
            }
            None => self.state.sessions.create(),
        };

        let result: NavigateResult = navigation::navigate(
            &self.state,
            &session_id,
            &url,
            input.wait_for.as_deref(),
            input.wait_timeout_ms,
        )
        .await
        .map_err(IntoMcpError::into_mcp_error)?;

        let elapsed_ms = result.elapsed.as_millis() as u64;
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
            session_id,
            title: result.title,
            url: result.url,
            elapsed_ms,
            server_rss_bytes: after_mem.server_rss,
            child_rss_bytes: after_mem.child_rss,
            total_rss_bytes: after_mem.server_rss + after_mem.child_rss,
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
    // `click` tool
    // -----------------------------------------------------------------
    pub async fn click_impl(&self, input: ClickInput) -> Result<ClickOutput, McpError> {
        let session_id = parse_session_id(&input.session_id)?;
        let result: ClickResult = navigation::click(
            &self.state,
            &session_id,
            &input.selector,
            input.wait_for.as_deref(),
            input.wait_timeout_ms,
        )
        .await
        .map_err(IntoMcpError::into_mcp_error)?;
        let elapsed_ms = result.elapsed.as_millis() as u64;
        Ok(ClickOutput {
            success: result.new_url.is_some(),
            new_url: result.new_url,
            elapsed_ms,
        })
    }

    // -----------------------------------------------------------------
    // `fill` tool
    // -----------------------------------------------------------------
    pub async fn fill_impl(&self, input: FillInput) -> Result<FillOutput, McpError> {
        let session_id = parse_session_id(&input.session_id)?;
        let (current_url, current_html, cookies) =
            self.state
                .sessions
                .with_session(Some(session_id.clone()), |s| {
                    let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
                    Ok((page.url.clone(), page.html.clone(), s.cookies.jar()))
                })?;
        let url = Url::parse(&current_url).map_err(BrowserError::Url)?;
        let renderer = self.state.renderer().map_err(IntoMcpError::into_mcp_error)?;
        let started = std::time::Instant::now();
        let page = renderer
            .fill(&url, &cookies, &current_html, &input.selector, &input.value)
            .await
            .map_err(IntoMcpError::into_mcp_error)?;
        // The fill doesn't navigate, but the cookies may have shifted and
        // a soft re-render could have happened; commit the (possibly
        // identical) page to the session so the agent sees the post-fill
        // DOM.
        crate::router::navigation::commit_for_fill(&self.state, &session_id, &page)
            .map_err(IntoMcpError::into_mcp_error)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(FillOutput {
            selector: input.selector,
            value: input.value,
            elapsed_ms,
        })
    }

    // -----------------------------------------------------------------
    // `submit` tool
    // -----------------------------------------------------------------
    pub async fn submit_impl(&self, input: SubmitInput) -> Result<SubmitOutput, McpError> {
        let session_id = parse_session_id(&input.session_id)?;
        let (current_url, current_html, cookies) =
            self.state
                .sessions
                .with_session(Some(session_id.clone()), |s| {
                    let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
                    Ok((page.url.clone(), page.html.clone(), s.cookies.jar()))
                })?;
        let url = Url::parse(&current_url).map_err(BrowserError::Url)?;
        let renderer = self.state.renderer().map_err(IntoMcpError::into_mcp_error)?;
        let started = std::time::Instant::now();
        let page = renderer
            .submit(&url, &cookies, &current_html, input.selector.as_deref())
            .await
            .map_err(IntoMcpError::into_mcp_error)?;
        crate::router::navigation::commit_for_fill(&self.state, &session_id, &page)
            .map_err(IntoMcpError::into_mcp_error)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(SubmitOutput {
            new_url: page.new_url,
            title: page.title,
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
            returned session. If `session_id` is omitted, a new session is created. \
            Uses Deno + happy-dom for full JavaScript support."
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

    #[tool(
        name = "click",
        description = "Click the first element matching `selector` on the current page. \
            The click is dispatched through Deno which handles all element types \
            including buttons, divs, form submits, and JavaScript-driven targets. \
            Returns `success: true` if the click was dispatched. If the \
            click caused a navigation, `new_url` is set."
    )]
    async fn click(&self, Parameters(input): Parameters<ClickInput>) -> Result<String, McpError> {
        let out = self.click_impl(input).await?;
        serialize_output(&out)
    }

    #[tool(
        name = "fill",
        description = "Set the value of an `<input>` or `<textarea>` matching `selector` on \
            the current page. Uses Deno for full JavaScript support. Returns the selector and value, \
            plus elapsed_ms. The session's current page is updated with the post-fill DOM."
    )]
    async fn fill(&self, Parameters(input): Parameters<FillInput>) -> Result<String, McpError> {
        let out = self.fill_impl(input).await?;
        serialize_output(&out)
    }

    #[tool(
        name = "submit",
        description = "Submit a `<form>` on the current page. If `selector` is given, the \
            matching form is submitted; otherwise the first form is submitted. Uses Deno for \
            full JavaScript support. Returns the new URL (if the form action redirected), title, and \
            elapsed_ms. The session is updated with the response page."
    )]
    async fn submit(&self, Parameters(input): Parameters<SubmitInput>) -> Result<String, McpError> {
        let out = self.submit_impl(input).await?;
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
