# Headless Browser MCP Server — Design Document

**Project:** `slim-atlas`  
**Stack:** Rust (core) + Deno (JS tier)  
**Target:** Lightweight headless browser for AI agents via MCP protocol  
**Platforms:** Linux x86_64, macOS (aarch64 + x86_64)  
**Goal:** <20MB RAM per session, <50ms median response time for static pages

---

## Revision History

| Version | Date       | Notes |
|---------|------------|-------|
| v1      | 2026-06-06 | Initial draft with 5 tiers (T2 API detection), Lightpanda-compatible scope |
| v2      | 2026-06-06 | Removed Lightpanda entirely; dropped Tier 2 (API detection) — too fragile; renumbered to 4 tiers; gated Tier 2 (QuickJS) on feature flag for fallback to Tier 3; v1 scope is read + write; targets Linux + macOS |
| v3      | 2026-06-06 | Rebranded: this is `slim-atlas`, not a successor. Dropped Tier 2 (QuickJS + DOM shim) and Tier 4 (Remote fallback). Renumbered: original Tier 3 (Deno subprocess) is now Tier 2. Two tiers total: HTTP → Deno. |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tier System](#2-tier-system)
3. [Project Structure](#3-project-structure)
4. [MCP Interface](#4-mcp-interface)
5. [Tier 1 — Plain HTTP](#5-tier-1--plain-http)
6. [Tier 2 — Deno Subprocess](#6-tier-2--deno-subprocess)
7. [Session & Cookie Management](#7-session--cookie-management)
8. [Data Flow & State](#8-data-flow--state)
9. [Configuration](#9-configuration)
10. [Error Handling Strategy](#10-error-handling-strategy)
11. [Resource Budgets](#11-resource-budgets)
12. [Cargo.toml](#12-cargotoml)
13. [Implementation Phases](#13-implementation-phases)
14. [Testing Strategy](#14-testing-strategy)
15. [Open Questions](#15-open-questions)
16. [Security](#16-security)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent (Claude / GPT)                   │
└────────────────────────────┬────────────────────────────────┘
                             │ MCP protocol (stdio / SSE)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     MCP Server (Rust)                        │
│                                                             │
│   tools: navigate, get_text, get_links, click, fill,        │
│           query, run_js, screenshot, get_cookies, reset      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  Tier Router                          │   │
│  │  classifies each request → dispatches to right tier  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────┐  ┌────────────────┐                       │
│  │   Tier 1    │  │    Tier 2      │                       │
│  │    HTTP     │  │     Deno       │                       │
│  │   reqwest   │  │  subprocess    │                       │
│  └─────────────┘  └────────────────┘                       │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Session Store (in-memory)                  │   │
│  │         cookies · headers · history · DOM cache       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Tier System

The router evaluates each request and selects the cheapest tier that can satisfy it. Tiers are tried in order; escalation happens automatically on detection of an empty DOM or JS-dependent content.

The system has two tiers. Tier 1 handles the common case (plain HTML, SSR pages) at minimal cost. Anything that looks like a client-rendered SPA escalates to Tier 2 (Deno subprocess) for full Web API execution.

```
Request
  │
  ▼
┌──────────────────────────────────┐
│ Tier 1: Plain HTTP + HTML parse  │  ~3MB RAM  |  <10ms
│  reqwest + html5ever + scraper   │
│                                  │
│  ✅ pass if: DOM has real content │
│  ❌ escalate if: root div empty  │
└────────────────┬─────────────────┘
                 │ escalate
                 ▼
┌──────────────────────────────────┐
│ Tier 2: Deno + happy-dom subproc │  ~3MB+ RAM | <150ms
│  happy-dom runs inlined scripts  │
│  scripts pre-fetched via Deno's  │
│  allowlisted fetch, then inlined │
│  → sandbox preserved end-to-end  │
│                                  │
│  ✅ pass if: SPA renders          │
│  ✅ always: interactive tools     │
└──────────────────────────────────┘
```

### Escalation detection heuristics

| Signal | Action |
|--------|--------|
| `<div id="root"></div>` is empty | escalate T1 → T2 |
| `<app-root></app-root>` is empty | escalate T1 → T2 |
| `window.__NEXT_DATA__` present in HTML | stay T1 if SSR, else escalate |
| Response body < 500 bytes with `<script>` | escalate T1 → T2 |
| Deno returns non-zero exit | return error to caller (no further tier) |

---

## 3. Project Structure

```
slim-atlas/
├── Cargo.toml
├── Cargo.lock
├── config.toml                    # default config
├── deno/
│   ├── render.ts                  # Deno SPA renderer (tier 2)
│   ├── dom_shim.ts                # minimal DOM helpers
│   └── fetch_proxy.ts             # route fetch → Rust HTTP
├── src/
│   ├── main.rs                    # entry point, MCP bootstrap
│   ├── config.rs                  # Config struct, load from toml/env
│   ├── error.rs                   # BrowserError enum
│   ├── state.rs                   # AppState (Arc<SessionStore>, Arc<Tier1Http>)
│   ├── mcp/
│   │   ├── mod.rs
│   │   ├── server.rs              # MCP server setup (rmcp)
│   │   └── tools.rs               # all tool definitions + handlers
│   ├── router/
│   │   ├── mod.rs
│   │   ├── classifier.rs          # heuristics to pick tier
│   │   └── escalator.rs           # retry logic between tiers
│   ├── session/
│   │   ├── mod.rs
│   │   ├── store.rs               # SessionStore (Arc<DashMap<...>>)
│   │   └── cookie.rs              # cookie jar wrapper
│   ├── tiers/
│   │   ├── mod.rs
│   │   ├── tier1_http.rs          # reqwest + html5ever
│   │   └── tier2_deno.rs          # Deno subprocess manager
│   └── utils/
│       ├── html.rs                # HTML cleaning, text extraction
│       └── selector.rs            # CSS selector helpers
└── tests/
    ├── tier1_tests.rs
    ├── tier2_tests.rs
    └── integration_tests.rs
```

---

## 4. MCP Interface

### Transport

Supports both MCP transport modes:

- **stdio** — default, used when spawned by Claude Desktop / agent
- **SSE** — optional, for HTTP-based agent frameworks

```rust
// main.rs
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::load()?;
    let state = AppState::new(config).await?;

    let transport = match std::env::var("MCP_TRANSPORT").as_deref() {
        Ok("sse") => Transport::Sse { port: 3000 },
        _         => Transport::Stdio,
    };

    McpServer::new(state)
        .register_tools(all_tools())
        .serve(transport)
        .await
}
```

### Tool Definitions

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `navigate` | `url: string` | `{ session_id, title, url, elapsed_ms }` | fetches page, returns acknowledgement only — content via `get_text` / `get_html` |
| `get_text` | — | `string` | clean text of current page |
| `get_html` | `selector?: string` | `string` | raw HTML, full or scoped |
| `get_links` | `selector?: string` | `[{ text, href, absolute }]` | all anchor tags |
| `query` | `selector: string` | `[{ html, text, attrs }]` | CSS selector query |
| `click` | `selector: string` | `{ success, new_url? }` | simulate click, follow navigation — tier 2+ |
| `fill` | `selector: string, value: string` | `{ success }` | fill input/textarea — tier 2+ |
| `submit` | `selector?: string` | `{ success, new_url? }` | submit nearest form — tier 2+ |
| `run_js` | `code: string` | `string` | execute JS, return serialized result — tier 2+ |
| `screenshot` | `selector?: string` | `base64 PNG` | tier 2 only (Deno) |
| `get_cookies` | — | `[{ name, value, domain }]` | session cookies |
| `set_headers` | `headers: object` | `{ success }` | set custom request headers |
| `reset` | — | `{ success }` | clear session, cookies, history |
| `get_history` | — | `[{ url, title, tier }]` | navigation history |

### Tool schema example (navigate)

```rust
#[derive(Deserialize, JsonSchema)]
struct NavigateInput {
    url: String,
    /// Wait for a CSS selector to appear (tier 2 only — Deno)
    wait_for: Option<String>,
    /// Force a specific tier (1-2). Default: auto.
    force_tier: Option<u8>,
}

#[derive(Serialize)]
struct NavigateOutput {
    session_id: String,
    title: String,
    url: String,         // final URL after redirects
    elapsed_ms: u64,
}
```

### Wire format — single `content[0].text`, no `structuredContent`

Tool handlers return `Result<String, McpError>` (not `Result<Json<Output>, _>`). The transport shim serializes the output struct with `serde_json::to_string` and returns the JSON string. The wire shape is:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "{\"session_id\":\"...\",\"title\":\"...\",...}" }
    ],
    "isError": false
  }
}
```

No `structuredContent` field is emitted. Both fields are optional in the MCP spec, so this is fully compliant and keeps the payload minimal. Clients parse `content[0].text` as JSON.

---

## 5. Tier 1 — Plain HTTP

### Responsibilities

- Fetch URL with full redirect following
- Parse HTML into DOM tree
- Extract clean text, links, metadata
- Detect SSR content vs empty shell

### Implementation

```rust
// src/tiers/tier1_http.rs

pub struct Tier1Http {
    client: reqwest::Client,
    cookie_jar: Arc<reqwest::cookie::Jar>,
}

impl Tier1Http {
    pub fn new(config: &Config) -> Self {
        let cookie_jar = Arc::new(reqwest::cookie::Jar::default());
        let client = reqwest::Client::builder()
            .cookie_provider(cookie_jar.clone())
            .user_agent(&config.user_agent)
            .timeout(Duration::from_secs(config.timeout_secs))
            .redirect(reqwest::redirect::Policy::limited(10))
            .use_rustls_tls()
            .build()
            .unwrap();
        Self { client, cookie_jar }
    }

    pub async fn fetch(&self, url: &str) -> Result<FetchResult> {
        let response = self.client.get(url).send().await?;
        let final_url = response.url().to_string();
        let status = response.status();
        let html = response.text().await?;

        Ok(FetchResult { html, final_url, status })
    }
}

pub struct HtmlPage {
    document: Html,  // scraper::Html
    base_url: Url,
}

impl HtmlPage {
    pub fn is_empty_shell(&self) -> bool {
        // Check for common SPA root patterns
        let spa_roots = ["#root", "#app", "#__next", "app-root", "ng-app"];
        for selector_str in &spa_roots {
            if let Ok(sel) = Selector::parse(selector_str) {
                if let Some(el) = self.document.select(&sel).next() {
                    let inner = el.inner_html();
                    if inner.trim().len() < 50 {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub fn extract_text(&self) -> String {
        // Remove script, style, nav, footer noise
        // Walk text nodes, join with newlines
        // Collapse whitespace
    }

    pub fn extract_links(&self) -> Vec<Link> {
        // Resolve relative hrefs against base_url
        // Filter mailto:, javascript:, #fragment-only
    }

    pub fn detect_framework(&self) -> FrameworkHint {
        // Scan for __NEXT_DATA__, ng-version, __vue__, etc.
        // Return: NextSSR | NextCSR | React | Angular | Vue | Unknown
    }
}
```

### SSR detection logic

```rust
pub enum FrameworkHint {
    NextSsr,      // has __NEXT_DATA__ + real content  → stay tier 1
    NextCsr,      // has __NEXT_DATA__ + empty shell   → tier 2/3
    ReactCsr,     // empty #root                       → tier 2/3
    AngularUniv,  // has ng-server-context             → stay tier 1
    AngularCsr,   // empty app-root                    → tier 2/3
    VueSsr,       // has data-server-rendered          → stay tier 1
    Static,       // no SPA markers                    → stay tier 1
}
```

---

## 6. Tier 2 — Deno Subprocess

Full Web API coverage. Spawned as a sandboxed subprocess only when tier 1 fails (empty shell / SPA detected by the classifier).

### Deno subprocess design

```rust
// src/tiers/tier2_deno.rs

pub struct DenoRenderer {
    deno_path: PathBuf,
    script_path: PathBuf,
    timeout: Duration,
}

impl DenoRenderer {
    pub async fn render(&self, request: &DenoRenderRequest) -> Result<DenoRenderResult> {
        let input_json = serde_json::to_string(request)?;

        let mut child = Command::new(&self.deno_path)
            .args([
                "run",
                // Deno requires explicit host:port; bare hostnames are rejected
                &format!("--allow-net={}", request.allowed_host_with_port),
                "--allow-env=false",
                "--allow-read=false",
                "--allow-write=false",
                "--allow-run=false",
                "--no-prompt",
                "--quiet",
                self.script_path.to_str().unwrap(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        // write request as JSON to stdin
        child.stdin.take().unwrap().write_all(input_json.as_bytes()).await?;

        // await with timeout
        let output = timeout(self.timeout, child.wait_with_output()).await??;

        if !output.status.success() {
            return Err(BrowserError::DenoFailed(
                String::from_utf8_lossy(&output.stderr).to_string()
            ));
        }

        Ok(serde_json::from_slice(&output.stdout)?)
    }
}
```

### Deno render script (`deno/render.ts`)

The script is the boundary between Rust (which owns the network,
cookies, and security) and JavaScript (which owns the DOM). It
reads one JSON request from stdin, runs the requested action,
writes one JSON response to stdout, exits.

```typescript
import { Window } from "happy-dom";

interface DenoRequest {
  protocol_version: number;        // must equal PROTOCOL_VERSION (1)
  mode: "render" | "click" | "fill" | "submit";
  url: string;
  html?: string;                   // required for click/fill/submit
  cookies: CookieEntry[];
  headers: Record<string, string>;
  selector?: string;               // click/fill
  value?: string;                  // fill
  wait_for?: string;               // render only
  wait_timeout_ms?: number;
  render_timeout_ms: number;
}

// 1. Parse request from stdin; verify protocol_version.
// 2. If mode === "render", fetch the URL with Deno's allowlisted
//    `fetch`; else use req.html directly.
// 3. Walk the HTML; for each <script src="..."> tag, fetch the URL
//    with Deno's allowlisted `fetch`, then replace the tag with
//    <script>body</script>. This preserves the --allow-net=host:port
//    sandbox for all subresource loads.
// 4. Construct a happy-dom Window with disableJavaScriptFileLoading:
//    true (we already inlined) and disableCSSFileLoading: true.
// 5. document.write(inlined_html); document.close(); await
//    window.happyDOM.waitUntilComplete().
// 6. Seed cookies onto document.cookie.
// 7. Dispatch the action (click/fill/submit/render).
// 8. Optionally wait for `wait_for` selector.
// 9. Serialize document.documentElement.outerHTML + body.textContent
//    (excluding <script>/<style> content) + title + anchor links +
//    set_cookies to JSON, write to stdout.
```

The key choice is to **pre-fetch and inline** external scripts
rather than rely on happy-dom's own subresource loader. happy-dom
16's `Browser.goto` path uses node:http internally, which bypasses
Deno's permission system — meaning with `--allow-net=host:port` set,
external `<script src>` requests would be silently blocked. By
doing the fetches ourselves with Deno's `fetch` (which is
permission-checked), we keep the sandbox intact and the script
bodies land in happy-dom as regular inline scripts, which it
executes during parse. Production React / Vue / Angular SPA bundles
(usually shipped as `<script src="/_next/static/chunks/main.js">`)
are loaded and executed this way, which is what lets frameworks
mount into the DOM tree. (The previous `deno_dom` was a parser
only and never ran external scripts — SPA shells came back empty.)

Cookies are round-tripped via `document.cookie`: the Rust side
seeds the cookies (filtered by origin) by setting `document.cookie`
on the constructed Window, and after the action runs we read
`document.cookie` back and synthesize `Set-Cookie` header strings
from the page's URL.

### Why happy-dom and not Playwright?

Tradeoff table (current decision: happy-dom):

| | happy-dom (current) | Playwright (future) |
|---|---|---|
| SPA compat | ~85% (runs scripts) | ~100% (real Chromium) |
| Bundle size | ~3 MB npm deps | ~250 MB Chromium binary |
| Cold start per call | ~50 ms | ~1.5 s |
| WebGL / Canvas | ❌ (no layout) | ✅ |
| Bot detection | ❌ (UA-flagged) | ⚠️ (depends) |
| Maintenance | low (npm:happy-dom) | low (npm:playwright) |

The path forward: when happy-dom returns an empty shell (text
length below `tiers.escalate_threshold_bytes` AND no useful DOM),
the Rust escalator can retry with Playwright. That's Phase 3 work.

### Deno process pool

To avoid cold-start overhead on repeated requests, maintain a small pool of warm Deno processes:

```rust
pub struct DenoPool {
    pool: Vec<DenoWorker>,
    max_size: usize,       // default: 2 (keeps RAM low)
    idle_timeout: Duration, // kill idle workers after 30s
}
```

### Permissions granted to Deno

| Permission | Granted | Scope |
|------------|---------|-------|
| `--allow-net` | Yes | Origin + form actions + script/link/img/iframe hosts (max 16) |
| `--allow-env` | Yes (no value list) | Required by happy-dom's npm transitive deps at import time |
| `--allow-read` | No | — |
| `--allow-write` | No | — |
| `--allow-run` | No | — |
| `--allow-ffi` | No | — |

---

## 7. Session & Cookie Management

Sessions are per-agent-connection and held in memory. No persistence across MCP server restarts by default (opt-in via config).

**Cookie isolation:** every session owns its own `CookieStore`. Cookies are never shared across sessions — two concurrent agents cannot leak credentials to each other even if they hit the same host.

```rust
// src/session/store.rs

pub struct Session {
    pub id: String,                   // 4-char Crockford base32
    pub cookies: CookieStore,         // cookie_store crate
    pub custom_headers: HeaderMap,
    pub history: Vec<HistoryEntry>,
    pub current_page: Option<ParsedPage>,
    pub current_tier: u8,
    pub created_at: Instant,
    pub last_active: Instant,
}

pub struct SessionStore {
    sessions: Arc<DashMap<String, Session>>,
    ttl: Duration,   // default: 30 minutes
    max_sessions: usize,
}

impl SessionStore {
    pub fn create(&self) -> String { ... }    // returns a new 4-char id
    pub fn with_session<F, R>(&self, id: Option<String>, f: F) -> R { ... }
    pub fn cleanup_expired(&self) { ... }     // called by background task
}
```

### Session ID format

Session IDs are 4 characters from the Crockford base32 alphabet
`0123456789abcdefghjkmnpqrstvwxyz` (32 chars, no `I`/`L`/`O`/`U` to avoid
visual ambiguity with `1`/`1`/`0`/`V`). IDs are case-insensitive on input and
normalized to lowercase for storage. 32^4 = 1,048,576 unique IDs.

Entropy is sourced from `Uuid::new_v4()` (cryptographically strong, OS RNG)
and packed as 20 bits across 4 base32 chars (5 bits each). With the default
`max_sessions = 50`, collision probability is ~0.005% per `create()` call;
the 50% birthday-paradox threshold is ~1024 items, so the store is well
within the safe zone and `create()`'s retry loop is effectively a no-op.

The `src/session/id.rs` module exposes `generate()` and `validate(&str)` for
this format; `tools::parse_session_id` is a thin wrapper around `validate`.

### Cookie sharing between tiers

All tiers within the same session share that session's cookie jar. Tier 1 sets cookies via reqwest's jar. Tier 2 (Deno) receives cookies as serialized JSON and returns any new cookies it received, which are merged back.

---

## 8. Data Flow & State

### navigate() call flow

```
agent calls navigate(url)
       │
       ▼
SessionStore.get_or_create(session_id)   // or create() if id is None
       │
       ▼
Tier Router
  │
  ├─ Tier1Http.fetch(url)
  │    ├── success + content?  →  HtmlPage.extract_text()  →  return result
  │    └── empty shell?
  │         │
  │         └─ Tier2Deno.render(request)
  │              ├── success?  →  return result
  │              └── fails?    →  return error (no further tier)
  │
  └── SessionStore.update(page, history, cookies)
```

### PageResult type

```rust
pub struct PageResult {
    pub url: String,
    pub title: String,
    pub text: String,              // clean text for LLM
    pub html: Option<String>,      // raw HTML if requested
    pub links: Vec<Link>,
    pub elapsed_ms: u64,
}
```

---

## 9. Configuration

### `config.toml`

```toml
[http]
user_agent = "Mozilla/5.0 (compatible; AgentBrowser/1.0)"
timeout_secs = 30
max_redirects = 10
max_body_bytes = 10_485_760   # 10MB

[tiers]
enabled = [1, 2]               # tier 2 (Deno) is required for interactive tools
max_tier = 2
escalate_on_empty_dom = true
escalate_threshold_bytes = 500  # escalate if body text < this

[tier2]
deno_path = "/usr/local/bin/deno"     # or "deno" if on PATH
script_path = "./deno/render.ts"
pool_size = 2
idle_timeout_secs = 30
render_timeout_ms = 10000

[security]
allowed_hosts = []                # empty = no host filter; populate for prod
block_third_party_cookies = true  # reject Set-Cookie from cross-origin pages

[session]
ttl_minutes = 30
max_sessions = 50                 # per server instance
persist = false                   # experimental

[server]
transport = "stdio"               # or "sse"
sse_port = 3000
log_level = "info"                # debug | info | warn | error
```

### Environment variable overrides

| Env var | Config key |
|---------|-----------|
| `DENO_PATH` | `tier2.deno_path` |
| `MCP_TRANSPORT` | `server.transport` |
| `MCP_MAX_TIER` | `tiers.max_tier` |
| `MCP_LOG_LEVEL` | `server.log_level` |

---

## 10. Error Handling Strategy

```rust
// src/error.rs

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("HTTP error: {status} for {url}")]
    Http { status: u16, url: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Deno subprocess failed: {stderr}")]
    DenoFailed { stderr: String },

    #[error("Deno not found at path: {path}")]
    DenoNotFound { path: String },

    #[error("Tier {tier} disabled in config")]
    TierDisabled { tier: u8 },

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("No current page in session")]
    NoCurrentPage,

    #[error("Selector not found: {selector}")]
    SelectorNotFound { selector: String },

    #[error("Security: host not in allowlist: {host}")]
    SecurityViolation { host: String },

    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}
```

### MCP error mapping

All `BrowserError` variants are mapped to structured MCP error responses via the `IntoMcpError` extension trait (see `PLAN_PHASE_1.md`). The mapping uses JSON-RPC standard codes (`InvalidParams` -32602, `InternalError` -32603) plus a small set of custom application codes in the -32000 to -32099 range for domain cases.

---

## 11. Resource Budgets

### RAM targets

| State | Target |
|-------|--------|
| Server idle (0 sessions) | <5MB |
| 1 active session, tier 1 | <10MB |
| 1 active session, tier 2 (Deno) | <40MB (TBD — pending baseline benchmark) |
| 10 concurrent sessions, tier 1 | <50MB |
| 10 concurrent sessions, tier 2 | <200MB (TBD) |

### CPU targets

| Operation | Target |
|-----------|--------|
| Tier 1 fetch + parse | <5ms CPU |
| Tier 2 Deno spawn + render | <200ms CPU |

### Binary size targets

| Build | Target |
|-------|--------|
| Debug binary | <50MB |
| Release binary | <15MB |
| Release + UPX compressed | <6MB |

---

## 12. Cargo.toml

```toml
[package]
name = "slim-atlas"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "slim-atlas"
path = "src/main.rs"

[dependencies]
# MCP
rmcp = { version = "1.7", features = ["server", "macros", "transport-io", "schemars"] }

# Async runtime
tokio = { version = "1", features = ["full"] }

# HTTP
reqwest = { version = "0.13", features = [
    "cookies",
    "rustls-tls",
    "json",
    "gzip",
    "brotli",
    "deflate",
] }

# HTML parsing
html5ever = "0.27"
scraper = "0.20"

# URL handling
url = "2"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Config
toml = "0.8"
config = "0.14"

# Error handling
anyhow = "1"
thiserror = "2"

# Utilities
dashmap = "6"      # concurrent hashmap for session store
uuid = { version = "1", features = ["v4"] }

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[dev-dependencies]
tokio-test = "0.4"
wiremock = "0.6"
pretty_assertions = "1"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true
```

---

## 13. Implementation Phases

**v1 ships at the end of Phase 3.** Phase 4 is optional post-v1 polish.

### Phase 1 — Core HTTP + MCP (Week 1–2)

- [ ] Project scaffold, Cargo.toml, module structure
- [ ] `Config` loading from toml + env
- [ ] `BrowserError` enum + `IntoMcpError` extension trait
- [ ] `SessionStore` with TTL cleanup, per-session cookie isolation
- [ ] `Tier1Http` — reqwest client with per-session cookie jar
- [ ] `HtmlPage` — text/link extraction, empty shell detection, framework hints
- [ ] MCP server bootstrap with `rmcp` (stdio transport)
- [ ] `navigate`, `get_text` (with optional selector), `get_links`, `get_html`, `query`, `get_history`, `reset` tools
- [ ] Basic integration tests via wiremock
- [ ] Baseline RAM benchmark: Tier 1 path

### Phase 2 — Router + Classifier (Week 3, ~3-4 days)

- [ ] `Classifier` — framework detection heuristics (`FrameworkHint`)
- [ ] `Escalator` — T1 → T2 (Deno) escalation
- [ ] Unit tests for classifier heuristics
- [ ] Configurable `escalate_threshold_bytes`

### Phase 3 — Deno Tier + Interactive Tools (Week 4–5) — **gates v1**

- [x] `deno/render.ts` — SPA renderer script using happy-dom (pinned via `deno.lock`); pre-fetches `<script src>` URLs with Deno's allowlisted `fetch` and inlines the bodies so happy-dom executes them during parse
- [x] `deno/dom_shim.ts` — DOM helpers (framework-agnostic, works with happy-dom)
- [x] `Tier2Deno` — subprocess spawn with permission flags (explicit host:port in `--allow-net`)
- [x] `DenoPool` — concurrency-bounded dispatcher (spawn-per-call in v1, warm pool deferred)
- [x] Cookie round-trip: Rust → Deno (`document.cookie`) → Rust (synthesized `Set-Cookie` strings)
- [x] `wait_for` selector support
- [ ] `click`, `fill`, `submit`, `run_js` tools
- [ ] `screenshot` tool (Deno only)
- [ ] Tests: Next.js CSR, Angular SPA, Vue SPA
- [ ] Cross-platform smoke: Linux x86_64, macOS aarch64, macOS x86_64

### Phase 4 — Polish (Week 6, optional)

- [ ] SSE transport option
- [ ] `set_headers`, `get_cookies` tools
- [ ] Full escalation path logged in response metadata
- [ ] Release build + binary size check
- [ ] README + usage examples
- [ ] Distribution: decide between `cargo install`, Homebrew tap, npm wrapper

---

## 14. Testing Strategy

### Unit tests

Each tier tested in isolation with mocked HTTP responses (using `wiremock`).

```rust
#[tokio::test]
async fn test_tier1_extracts_text_from_static_page() { ... }

#[tokio::test]
async fn test_classifier_detects_next_ssr() { ... }

#[tokio::test]
async fn test_escalation_triggers_on_empty_root() { ... }
```

### Integration tests

Test full navigate() flow against real URLs (gated behind `#[ignore]`, run in CI with network access):

```rust
#[tokio::test]
#[ignore = "requires network"]
async fn test_nextjs_csr_site_escalates_to_tier2() { ... }
```

### Test matrix

| Site type | Expected tier | Test |
|-----------|--------------|------|
| `example.com` | 1 | unit |
| Next.js SSR (`nextjs.org`) | 1 | integration |
| Next.js CSR | 2 | integration |
| Create React App | 2 | integration |
| Angular Universal | 1 | integration |
| Angular CSR | 2 | integration |

---

## 15. Open Questions

1. **Deno bundling** — ✅ **Resolved (defer to Phase 4).** v1 documents `curl https://deno.land/install.sh | sh` as a prereq; revisit embedding via `deno compile` + `include_bytes!` if install friction surfaces.

2. **Cookie persistence** — should session state optionally serialize to disk (SQLite via `rusqlite`) for long-running agent tasks that outlive the MCP process?

3. **Deno script sandbox escapes** — Tier 2 currently trusts the page scripts run via Deno's `eval`. Should we add a pre-execution static analysis step to detect and strip potentially dangerous patterns, or rely entirely on Deno's `--allow-net=host` isolation? (Worth doing only if we observe abuse in the wild; defer.)

4. **Concurrent sessions** — the current design uses one cookie jar per session. For high-concurrency use (10+ agents), should we pool reqwest clients or keep one per session? **Resolved (v3): one `reqwest::Client` per session.** The original tentative answer (shared client + per-session jar) is not implementable with stock reqwest; per-session `Client` is correct and within the resource budget. Validate in Phase 1 benchmark.

5. **Deno version pinning** — ✅ **Resolved.** Pin `happy-dom` (npm) and all transitive deps in `deno.lock` from day 1; commit the lockfile. No `https://deno.land/x/.../latest` imports in `render.ts`.

6. **Form-submit in Tier 1** — currently `click`/`fill`/`submit` work only in Tier 2. Worth implementing a form-submit simulation in Tier 1 (parse form action + method, POST directly) for simple cases? **Likely no** — most real agent flows hit JS-driven forms; the engineering cost is not justified.

7. **Binary distribution** — three options:
   - (a) Document `curl install.deno.net | sh` as a prereq; `cargo install slim-atlas` (current plan, simplest)
   - (b) Embed a pre-compiled Deno binary via `include_bytes!` per platform (single binary, +~80MB)
   - (c) Bootstrap: first run downloads the right Deno, caches in `~/.cache/slim-atlas/`
   **Defer to Phase 4** — pick based on user feedback from v1.

8. **Distribution channel (new)** — where does the end user get the binary?
   - `cargo install` (CLI users)
   - Homebrew tap (macOS users)
   - npm wrapper that downloads the binary (Claude Desktop users)
   - All of the above
   **Defer to Phase 4** but discuss with users early.

---

## 16. Security

Because `slim-atlas` executes arbitrary page-supplied JavaScript (Tier 2) and can issue arbitrary network requests (all tiers), it is a non-trivial attack surface when an untrusted agent prompt is processed. The following are baseline protections; expand as we learn from real-world use.

### Domain allowlist (`[security].allowed_hosts`)

- Empty list = no filter (development default).
- Populated list = reject all navigation/fetch/proxy requests to hosts not in the list. The check applies at:
  - Tier 1: `reqwest` request URL
  - Tier 2: enforced as the `--allow-net=host:port` arg when spawning Deno
- Pattern matching supports exact host (`example.com`) and wildcard subdomains (`*.example.com`); `*.example.com` does NOT match the bare `example.com`. Port-sensitive (`example.com:8080` matches only that port).

### Cookie isolation

- One `CookieStore` per session. Sessions are keyed by MCP connection ID; never by URL or host.
- Cookies set during a session are not visible to other concurrent sessions, even when both hit the same domain.

### Third-party cookie blocking (`[security].block_third_party_cookies`)

- When `true` (default), `Set-Cookie` headers from cross-origin responses are dropped before being merged into the session jar. This matches browser default behavior since 2023.

### Subprocess sandboxing (Tier 2 Deno)

- `--allow-net=host:port` — only the target host, never wildcard
- `--allow-env=false`, `--allow-read=false`, `--allow-write=false`, `--allow-run=false`, `--allow-ffi=false`
- No persistent state between invocations; stdin/stdout are the only IO channels

### Force-tier advisory

When an agent calls `navigate` with `force_tier: 2`, the server logs which tier was used in the response metadata. The `max_tier` config cap (default 2) prevents accidental escalation beyond the intended tier in production.

### Secret redaction

- `Authorization`, `Cookie`, and `Set-Cookie` headers are redacted from `tracing` output at all log levels.
