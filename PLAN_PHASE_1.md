# Phase 1 Implementation Plan — Tier 1 + MCP

**Project:** `browser-mcp`  
**Phase:** 1 of 5 (Weeks 1–2)  
**Scope:** Read-only Tier 1 (HTTP) path + MCP stdio server + 7 tools  
**Status:** Plan finalized; implementation deferred

---

## Scope

**In:**

- Read-only Tier 1 (plain HTTP) navigation
- MCP stdio server bootstrap via `rmcp`
- 7 tools: `navigate`, `get_text`, `get_links`, `get_html`, `query`, `get_history`, `reset`
- Session store with per-session cookie isolation
- Framework hint detection (internal, not exposed via tools)
- Tracing + header redaction deferred to Phase 5

**Out (deferred):**

- Tiers 2/3/4 and the escalation router (Phases 3–5)
- `click`, `fill`, `submit`, `run_js`, `screenshot` (need a JS engine)
- SSE transport (Phase 5)
- `get_cookies`, `set_headers` (Phase 5)
- Cookie persistence to disk (Open Q2)
- Windows support (deferred post-v1)

---

## Module structure

```
browser-mcp/
├── Cargo.toml
├── config.toml                    # default config
├── README.md
├── src/
│   ├── main.rs                    # entry: load config, init logging, build AppState, start MCP stdio
│   ├── config.rs                  # Config struct, load() with toml + env
│   ├── error.rs                   # BrowserError enum (+ McpError mapping)
│   ├── state.rs                   # AppState (Arc<SessionStore>, Arc<Tier1Http>)
│   ├── mcp/
│   │   ├── mod.rs                 # re-exports
│   │   ├── server.rs              # McpServer setup with rmcp
│   │   └── tools.rs               # 7 tool definitions + handlers
│   ├── session/
│   │   ├── mod.rs
│   │   ├── store.rs               # SessionStore (DashMap<Uuid, Session>)
│   │   └── cookie.rs              # per-session CookieJar wrapper
│   ├── tiers/
│   │   ├── mod.rs
│   │   └── tier1_http.rs          # Tier1Http + FetchResult + HtmlPage + FrameworkHint
│   └── utils/
│       ├── mod.rs
│       ├── html.rs                # text extraction, link extraction
│       └── selector.rs            # CSS selector helpers (wraps scraper)
└── tests/
    ├── tier1_tests.rs             # unit tests
    └── integration_tests.rs       # end-to-end tool handler tests
```

---

## Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Session model | **Explicit `session_id` in every tool call** (Uuid-as-string) | Agent-controlled lifecycle; forwards to SSE model in Phase 5. |
| Session creation | **`navigate` auto-creates when `session_id` is missing**; all other tools require it | Slight input asymmetry on first call only; agent threads the id back through. |
| `reqwest::Client` per session | **One `Tier1Http` per session** (one Client + one Jar each) | `cookie_provider` is a builder option, not per-request; sharing the client across sessions would break jar isolation. |
| Cargo.toml for Phase 1 | **Strip Phase-1-unused deps** | Drop `rquickjs`, `lol_html`, `regex`, `base64`, `bytes`. Re-add in their respective phases. Faster clean builds. |
| HTML cleaning | **Strip `script`/`style`/`noscript`/comments**; keep `nav`/`footer`/`header` text | LLM agents benefit from nav/footer (login links, copyright). Re-evaluate in Phase 2 if too noisy. |
| `get_text` / `get_links` target | **Current page in the named session** | No selector means "the whole current page." Optional selector filters. |
| Error responses | **`BrowserError` → `McpError` mapping** in `mcp/tools.rs`; structured `ErrorData` with code + message | Agents can pattern-match on error codes. |
| `force_tier` validation | **Accept only `Some(1)` in Phase 1**; reject `2`/`3`/`4` with `BrowserError::TierDisabled` | Sets the contract for future tiers. |
| Framework hint | **Computed in `tier1_http.rs` but not exposed**; stored in `Session::last_framework_hint` for the Phase 2 router | The agent doesn't need it; the classifier does. |
| `reset` semantics | **Soft reset** — clear cookies, history, current page, custom headers; session record stays in the store | Idempotent. TTL still reaps the session eventually. |
| Logging | `tracing` with `EnvFilter`; `RUST_LOG=info` default | Header redaction deferred to Phase 5. |

---

## Tool surface (7 tools)

| Tool | Input | Output |
|---|---|---|
| `navigate` | `session_id?: string, url: string, force_tier?: 1` | `session_id, text, title, url, tier_used, escalation_path, elapsed_ms` |
| `get_text` | `session_id: string` | `text: string` |
| `get_links` | `session_id: string, selector?: string` | `[{ text, href, absolute }]` |
| `get_html` | `session_id: string, selector?: string` | `html: string` |
| `query` | `session_id: string, selector: string` | `[{ html, text, attrs }]` |
| `get_history` | `session_id: string` | `[{ url, title, tier, timestamp_ms }]` |
| `reset` | `session_id: string` | `{ success: true }` |

### `navigate` response shape

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Example Domain ...",
  "title": "Example Domain",
  "url": "https://example.com/",
  "tier_used": 1,
  "escalation_path": [1],
  "elapsed_ms": 42
}
```

---

## File-by-file implementation order

Order is dependency-first so we can compile at each step.

### Step 1 — Scaffold + error

**`Cargo.toml`** (modified from §14 of DESIGN.md)

Drop (re-add in later phases):

- `rquickjs` (Phase 3)
- `lol_html` (not needed; html5ever suffices)
- `regex` (not needed; scraper's selectors cover Phase 1)
- `base64` (Phase 4 for screenshot)
- `bytes` (reqwest re-exports)

Keep:

- `rmcp = "0.1"` with `["server", "transport-io"]` (defer `transport-sse` to Phase 5)
- `tokio`, `reqwest` (with `cookies`, `rustls-tls`, `json`, `gzip`, `brotli`, `deflate`)
- `html5ever`, `scraper`
- `url`, `serde`, `serde_json`, `toml`, `config`
- `anyhow`, `thiserror`
- `dashmap`, `uuid` (v4), `tracing`, `tracing-subscriber`
- dev: `tokio-test`, `wiremock`, `pretty_assertions`

Verify `rmcp` 0.1 API on crates.io before implementation; pin via `Cargo.lock`. `rmcp` 0.1 was a moving target — `#[tool]` macro, `Server::new()`, `transport::stdio()` should be the surface; if drifted, use latest 0.x with lockfile.

**`src/error.rs`**

```rust
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("HTTP error: {status} for {url}")]
    Http { status: u16, url: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("No current page in session")]
    NoCurrentPage,

    #[error("Selector not found: {selector}")]
    SelectorNotFound { selector: String },

    #[error("Security: host not in allowlist: {host}")]
    SecurityViolation { host: String },

    #[error("Tier {tier} disabled in config or not yet implemented")]
    TierDisabled { tier: u8 },

    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

pub type Result<T> = std::result::Result<T, BrowserError>;
```

Add `McpError` newtype in this file (or in `mcp/tools.rs`) carrying the `rmcp::ErrorData` shape.

### Step 2 — Config

**`src/config.rs`**

- `Config` struct with sub-structs: `HttpConfig`, `TiersConfig`, `SessionConfig`, `ServerConfig`, `SecurityConfig`
- `Config::load() -> Result<Self>` — reads optional `config.toml`, overlays env vars per §11 of DESIGN.md
- Phase 1 honors `[http]`, `[session]`, `[server]`, `[security]`. `[tiers]`, `[tier2]`, `[tier3]`, `[tier4]` parse but log a "not yet implemented" warning and use defaults.

**`config.toml`** (default)

```toml
[http]
user_agent = "Mozilla/5.0 (compatible; AgentBrowser/1.0)"
timeout_secs = 30
max_redirects = 10
max_body_bytes = 10_485_760   # 10MB

[tiers]
enabled = [1]                  # only tier 1 in Phase 1
max_tier = 1
escalate_on_empty_dom = false  # no escalation yet
escalate_threshold_bytes = 500
escalate_skip_quickjs = false

[session]
ttl_minutes = 30
max_sessions = 50
persist = false

[security]
allowed_hosts = []             # empty = no filter (dev)
block_third_party_cookies = true

[server]
transport = "stdio"
sse_port = 3000
log_level = "info"
```

Env overrides per §11: `MCP_TRANSPORT`, `MCP_MAX_TIER`, `MCP_LOG_LEVEL`.

### Step 3 — Session

**`src/session/cookie.rs`**

```rust
pub struct SessionCookies {
    jar: Arc<reqwest::cookie::Jar>,
}

impl SessionCookies {
    pub fn new() -> Self;
    pub fn to_header_value(&self, url: &Url) -> Option<String>;
    pub fn merge_from_header(&self, set_cookie: &str, url: &Url);
    pub fn clear(&self);
}
```

The `to_header_value` / `merge_from_header` methods are forward-compat for Tier 3+ cookie round-trip; not used in Phase 1.

**`src/session/store.rs`**

```rust
pub struct Session {
    pub id: Uuid,
    pub cookies: SessionCookies,
    pub custom_headers: HeaderMap,
    pub history: Vec<HistoryEntry>,
    pub current_page: Option<CurrentPage>,
    pub current_tier: u8,
    pub last_framework_hint: Option<FrameworkHint>,
    pub created_at: Instant,
    pub last_active: Instant,
}

pub struct CurrentPage {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub framework: Option<FrameworkHint>,
}

pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub tier: u8,
    pub timestamp_ms: u64,   // unix millis
}

pub struct SessionStore {
    sessions: Arc<DashMap<Uuid, Session>>,
    ttl: Duration,
}

impl SessionStore {
    pub fn new(ttl: Duration) -> Self;
    pub fn create(&self) -> Uuid;                                  // new id, inserted
    pub fn assert_exists(&self, id: &Uuid) -> Result<(), BrowserError>;
    pub fn get_mut(&self, id: Uuid) -> ...;                        // returns guard
    pub fn with_session<F, R>(&self, id: Uuid, f: F) -> Result<R>;
    pub fn cleanup_expired(&self);                                 // drops stale entries
    pub fn spawn_cleanup_task(self: Arc<Self>);                    // tokio::spawn loop
}
```

Background task: `tokio::spawn` calls `cleanup_expired()` every `ttl / 2`.

**`src/session/mod.rs`** — re-exports.

### Step 4 — Utilities

**`src/utils/html.rs`**

```rust
pub fn extract_text(html: &scraper::Html) -> String;
pub fn extract_links(html: &scraper::Html, base: &url::Url) -> Vec<Link>;

pub struct Link {
    pub text: String,
    pub href: String,
    pub absolute: String,   // resolved against base
}
```

- `extract_text`: walks DOM, drops `script`/`style`/`noscript`/comments, joins text nodes with `\n`, collapses whitespace runs to single space.
- `extract_links`: collects `<a href>`, resolves against base, filters `mailto:`, `javascript:`, pure-fragment.

**`src/utils/selector.rs`**

```rust
pub fn first_match<'a>(html: &'a scraper::Html, selector: &str)
    -> Result<scraper::ElementRef<'a>, BrowserError>;

pub fn all_matches<'a>(html: &'a scraper::Html, selector: &str)
    -> Result<Vec<scraper::ElementRef<'a>>, BrowserError>;
```

- Selector parse failure → `BrowserError::SelectorNotFound`.

### Step 5 — Tier 1

**`src/tiers/tier1_http.rs`**

```rust
pub struct Tier1Http {
    client: reqwest::Client,
    cookies: Arc<reqwest::cookie::Jar>,
}

pub struct FetchResult {
    pub html: String,
    pub final_url: url::Url,
    pub status: reqwest::StatusCode,
}

pub struct HtmlPage {
    document: scraper::Html,
    base_url: url::Url,
}

pub enum FrameworkHint {
    NextSsr,
    NextCsr,
    ReactCsr,
    AngularUniv,
    AngularCsr,
    VueSsr,
    Static,
}

impl Tier1Http {
    pub fn new(config: &HttpConfig) -> Self;
    pub async fn fetch(&self, url: &str) -> Result<FetchResult>;
}

impl HtmlPage {
    pub fn from_fetch(result: FetchResult) -> Result<Self>;
    pub fn is_empty_shell(&self) -> bool;
    pub fn extract_text(&self) -> String;
    pub fn extract_links(&self) -> Vec<Link>;
    pub fn title(&self) -> String;
    pub fn detect_framework(&self) -> FrameworkHint;
}
```

Implementation details per §5 of DESIGN.md:

- `client` builder: `.cookie_provider(jar)`, `.user_agent(ua)`, `.timeout(...)`, `.redirect(Policy::limited(10))`, `.use_rustls_tls()`
- `is_empty_shell`: checks 5 SPA root selectors (`#root`, `#app`, `#__next`, `app-root`, `ng-app`); empty if inner `< 50` bytes
- `detect_framework`: scans HTML text for marker strings (`__NEXT_DATA__`, `ng-server-context`, `data-server-rendered`, etc.) and combines with `is_empty_shell()` to distinguish SSR vs CSR variants

### Step 6 — State

**`src/state.rs`**

```rust
pub struct AppState {
    pub config: Arc<Config>,
    pub sessions: Arc<SessionStore>,
    pub tier1: Arc<Tier1Http>,
    pub security: Arc<SecurityPolicy>,
}

impl AppState {
    pub async fn new(config: Config) -> Result<Self>;
}

pub struct SecurityPolicy {
    pub allowed_hosts: Vec<HostPattern>,
    pub block_third_party_cookies: bool,
}

impl SecurityPolicy {
    pub fn assert_host_allowed(&self, url: &url::Url) -> Result<(), BrowserError>;
}
```

`assert_host_allowed` supports exact host (`example.com`) and wildcard subdomain (`*.example.com`); empty list = no filter.

`AppState::new` builds `SessionStore::new`, calls `spawn_cleanup_task`, builds `Tier1Http::new`, wraps in `Arc`s.

### Step 7 — MCP server + tools

**`src/mcp/tools.rs`** — 7 tool structs, each `#[rmcp::tool]` with `Input`/`Output` types deriving `JsonSchema`, `Serialize`, `Deserialize`. Each tool holds `Arc<AppState>` and exposes `async fn handle(...) -> Result<Output, McpError>`.

```rust
#[derive(Deserialize, JsonSchema)]
struct NavigateInput {
    session_id: Option<String>,
    url: String,
    #[schemars(description = "Force a specific tier (1-4). Phase 1 accepts only 1.")]
    force_tier: Option<u8>,
    wait_for: Option<String>,    // accepted, ignored in Phase 1
}

#[derive(Serialize)]
struct NavigateOutput {
    session_id: String,
    text: String,
    title: String,
    url: String,
    tier_used: u8,
    escalation_path: Vec<u8>,
    elapsed_ms: u64,
}
```

Tool list and handler responsibilities:

| Tool | Handler responsibilities |
|---|---|
| `navigate` | Validate `force_tier` (must be 1 or None). Parse URL. Check host allowlist. Resolve/create session id. `tier1.fetch(url)`, build `HtmlPage`, extract text/title/framework. Update session (history, current_page, last_active, last_framework_hint). Return `session_id` + page. |
| `get_text` | `assert_exists(session_id)`. Return `current_page.text` or `NoCurrentPage`. |
| `get_links` | `assert_exists`. Return `current_page.html`-derived links, optionally filtered by selector. |
| `get_html` | `assert_exists`. Return inner HTML of `current_page.html`, scoped by optional selector. |
| `query` | `assert_exists`. Parse `current_page.html` to `scraper::Html`, run `all_matches(selector)`, serialize each as `{ html, text, attrs }` where `attrs` is `HashMap<String, String>`. |
| `get_history` | `assert_exists`. Return `session.history` cloned. |
| `reset` | `assert_exists`. Clear cookies, history, current_page, custom_headers. Keep session record. Return `{ success: true }`. |

**`src/mcp/server.rs`**

```rust
pub fn build_server(state: Arc<AppState>) -> impl ServerHandler;

pub async fn serve_stdio(server: impl ServerHandler) -> Result<()>
```

`build_server` uses `rmcp::Server::new().with_tool(NavigateTool { state: state.clone() })...with_tool(ResetTool { state })`.

`serve_stdio` installs `tracing-subscriber` with `EnvFilter` (respecting `RUST_LOG` and `config.server.log_level`), then `server.serve(rmcp::transport::stdio()).await`.

**`src/mcp/mod.rs`** — re-exports.

### Step 8 — Entry point

**`src/main.rs`**

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::load()?;
    let state = Arc::new(AppState::new(config).await?);
    let server = build_server(state);
    serve_stdio(server).await
}
```

### Step 9 — Tests

**Unit tests** (in `#[cfg(test)] mod tests` blocks inside each module):

- `tiers::tier1_http::tests::test_extract_text_strips_script_style`
- `tiers::tier1_http::tests::test_extract_text_collapses_whitespace`
- `tiers::tier1_http::tests::test_extract_links_resolves_relative`
- `tiers::tier1_http::tests::test_extract_links_filters_mailto_javascript`
- `tiers::tier1_http::tests::test_is_empty_shell_detects_empty_root`
- `tiers::tier1_http::tests::test_is_empty_shell_passes_ssr`
- `tiers::tier1_http::tests::test_detect_framework_next_ssr`
- `tiers::tier1_http::tests::test_detect_framework_react_csr`
- `utils::html::tests::test_link_absolute_url_with_subpath`
- `session::store::tests::test_session_ttl_eviction`
- `config::tests::test_env_overrides_toml`

**Integration tests** (`tests/integration_tests.rs`, `wiremock`-based):

- `test_navigate_static_site` — mock example.com, call `NavigateTool::handle`, assert text contains "Example Domain"
- `test_navigate_creates_session_when_id_missing` — no session_id in input, assert response has a Uuid
- `test_navigate_respects_force_tier` — `force_tier: Some(2)` returns `BrowserError::TierDisabled`
- `test_navigate_rejects_disallowed_host` — populate `allowed_hosts = ["example.com"]`, navigate to `evil.com` → `BrowserError::SecurityViolation`
- `test_other_tools_error_on_missing_session` — `get_text` with random Uuid → `BrowserError::SessionNotFound`
- `test_session_reuse_preserves_cookies` — first navigate sets cookie, second navigate with same session_id sends `Cookie:` header
- `test_get_text_returns_current_page` — navigate then `get_text` returns same text
- `test_get_links_with_selector_filter` — `get_links("nav a")` returns nav-only
- `test_get_html_with_selector` — `get_html(session_id, "h1")` returns inner H1 HTML
- `test_get_html_no_selector_returns_body` — full page inner HTML
- `test_query_returns_matching_elements` — multi-match
- `test_get_history_appends_per_navigate` — 3 navigates, history has 3 entries with timestamps
- `test_reset_clears_session` — navigate, reset, `get_text` returns `NoCurrentPage`

**Real-network tests** (`#[ignore]`, gated):

- `test_navigate_example_com`
- `test_navigate_nextjs_org_ssr` — assert `tier_used == 1`

**Memory benchmark** (in `tests/integration_tests.rs` or separate `benches/`):

- Measure RSS delta across 100 navigations to a local `wiremock`; assert < 5MB delta.

**Test command sequence:**

```bash
cargo build
cargo test
cargo test -- --ignored
cargo clippy -- -D warnings
cargo fmt --check
```

---

## Time estimate

| Step | Days | Cumulative |
|---|---|---|
| 1. Scaffold + error | 0.5 | 0.5 |
| 2. Config | 0.5 | 1.0 |
| 3. Session (with `create` / `assert_exists` / `get_mut`) | 1.5 | 2.5 |
| 4. Utilities | 0.5 | 3.0 |
| 5. Tier 1 | 1.5 | 4.5 |
| 6. State | 0.5 | 5.0 |
| 7. MCP server + 7 tools | 2.5 | 7.5 |
| 8. Entry + integration | 0.5 | 8.0 |
| 9. Tests + benchmark | 2.0 | 10.0 |
| Buffer (rmcp API drift, debugging) | 1.0 | **11.0** |

11 working days = ~2.2 weeks. Slight overrun vs §15 budget of 2 weeks (10 days) due to the 3 extra tools (vs 4) and 7 extra test cases. Absorbed by the shortened Phase 2 (3-4 days in v2 design).

---

## Risks

1. **`rmcp` API churn** — 0.1 was a moving target in 2024-2025. Verify the API surface (`#[tool]` macro, `Server::new()`, `transport::stdio()`) against crates.io before committing. If drifted, use latest 0.x with `Cargo.lock` pinning.
2. **Cookie jar + reqwest quirks** — reqwest's jar is "smart" about domain matching; test cases with subdomains / IPs may behave unexpectedly.
3. **scraper `ElementRef` lifetimes** — returning `ElementRef<'a>` across function boundaries is fragile. Plan stores them in `HtmlPage` which owns the `scraper::Html`; tool handlers borrow within their async scope and serialize before returning.
4. **Empty-shell threshold** — 50 bytes is a guess. May miss real shells or false-positive on sparse pages. Phase 1 keeps it; Phase 2 tunes based on classifier metrics.
5. **Stdio transport buffering** — on Windows ConPTY (out of scope) and some macOS stdio edge cases, partial reads can deadlock. Use `BufReader`/`BufWriter` and `flush().await` after every JSON-RPC response.

---

## Resolved open questions

- **Session model** → explicit `session_id` in every call, auto-create on first `navigate`
- **Cargo.toml** → strip Phase-1-unused deps
- **Tool count** → 7 tools (navigate, get_text, get_links, get_html, query, get_history, reset)
- **`get_cookies` / `set_headers`** → Phase 5
- **Header redaction** → Phase 5
- **Windows** → out of v1 scope

## Still open (deferred)

- `rmcp` exact version to pin (verify at start of Step 1)
- `lol_html` reintroduction: not needed for Phase 1; revisit if HTML cleaning proves insufficient
- Cookie persistence to disk (DESIGN.md §17 Q2) — Phase 5+
- Distributed tracing / metrics — post-v1

---

## Implementation command

When the user signals to start implementation, the entry point is:

```bash
cargo init --name browser-mcp
# then apply Cargo.toml, config.toml, src/ tree per Step 1-8
cargo build
cargo test
```

Do not run `cargo init` or write source files until the user says so.
