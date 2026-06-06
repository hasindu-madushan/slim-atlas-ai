# Headless Browser MCP Server — Design Document

**Project:** `browser-mcp` (successor to `slim-atlas`)  
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

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tier System](#2-tier-system)
3. [Project Structure](#3-project-structure)
4. [MCP Interface](#4-mcp-interface)
5. [Tier 1 — Plain HTTP](#5-tier-1--plain-http)
6. [Tier 2 — QuickJS + DOM Shim](#6-tier-2--quickjs--dom-shim)
7. [Tier 3 — Deno Subprocess](#7-tier-3--deno-subprocess)
8. [Tier 4 — Remote Fallback](#8-tier-4--remote-fallback)
9. [Session & Cookie Management](#9-session--cookie-management)
10. [Data Flow & State](#10-data-flow--state)
11. [Configuration](#11-configuration)
12. [Error Handling Strategy](#12-error-handling-strategy)
13. [Resource Budgets](#13-resource-budgets)
14. [Cargo.toml](#14-cargotoml)
15. [Implementation Phases](#15-implementation-phases)
16. [Testing Strategy](#16-testing-strategy)
17. [Open Questions](#17-open-questions)
18. [Security](#18-security)

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
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Tier 1  │  │ Tier 2   │  │  Tier 3    │  │  Tier 4    │ │
│  │  HTTP   │  │ QuickJS  │  │   Deno     │  │  Remote    │ │
│  │ reqwest │  │ +DOM shim│  │ subprocess │  │  fallback  │ │
│  └─────────┘  └──────────┘  └────────────┘  └────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Session Store (in-memory)                  │   │
│  │         cookies · headers · history · DOM cache       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                             │
                     Tier 4 (remote fallback)
                             │
                     ┌────────▼────────┐
                     │ Browserless.io  │
                     │  or self-hosted │
                     │  Chrome remote  │
                     └─────────────────┘
```

---

## 2. Tier System

The router evaluates each request and selects the cheapest tier that can satisfy it. Tiers are tried in order; escalation happens automatically on detection of an empty DOM or JS-dependent content.

Tier 2 (QuickJS) is **optional** — it can be disabled via `escalate_skip_quickjs` in config. When disabled, escalation goes directly T1 → T3 (Deno). This is a safety valve: if the QuickJS DOM shim turns out to be unmaintainable in practice, we lose Tier 2 savings but keep the rest of the design intact.

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
│ Tier 2: QuickJS + DOM shim       │  ~15MB RAM |  <100ms
│  rquickjs + minimal DOM impl     │
│  fetch routed back to reqwest    │
│  (skippable: T1 → T3 directly)   │
│                                  │
│  ✅ pass if: simple JS renders   │
│  ❌ escalate if: browser API miss │
└────────────────┬─────────────────┘
                 │ escalate
                 ▼
┌──────────────────────────────────┐
│ Tier 3: Deno subprocess          │  ~30MB+ RAM | <300ms
│  full Web APIs + deno_dom        │
│  sandboxed with --allow-net=host │
│                                  │
│  ✅ pass if: SPA renders          │
│  ❌ escalate if: needs canvas/GPU │
└────────────────┬─────────────────┘
                 │ escalate
                 ▼
┌──────────────────────────────────┐
│ Tier 4: Remote Browserless       │  ~0MB local|  <1000ms
│  HTTP call to Chrome remote API  │
│  configurable endpoint           │
└──────────────────────────────────┘
```

### Escalation detection heuristics

| Signal | Action |
|--------|--------|
| `<div id="root"></div>` is empty | escalate T1 → T2 (or T1 → T3 if `escalate_skip_quickjs`) |
| `<app-root></app-root>` is empty | escalate T1 → T2 (or T1 → T3) |
| `window.__NEXT_DATA__` present in HTML | stay T1 if SSR, else escalate |
| Response body < 500 bytes with `<script>` | escalate T1 → T2 (or T1 → T3) |
| QuickJS throws `ReferenceError: window` | escalate T2 → T3 |
| QuickJS throws `canvas is not defined` | escalate T2 → T3 |
| Deno returns non-zero exit | escalate T3 → T4 |

---

## 3. Project Structure

```
browser-mcp/
├── Cargo.toml
├── Cargo.lock
├── config.toml                    # default config
├── deno/
│   ├── render.ts                  # Deno SPA renderer (tier 3)
│   ├── dom_shim.ts                # minimal DOM helpers
│   └── fetch_proxy.ts             # route fetch → Rust HTTP
├── js/
│   └── dom_shim.js                # QuickJS DOM shim (tier 2)
├── src/
│   ├── main.rs                    # entry point, MCP bootstrap
│   ├── config.rs                  # Config struct, load from toml/env
│   ├── error.rs                   # BrowserError enum
│   ├── mcp/
│   │   ├── mod.rs
│   │   ├── server.rs              # MCP server setup (rmcp)
│   │   └── tools.rs               # all tool definitions + handlers
│   ├── router/
│   │   ├── mod.rs
│   │   ├── classifier.rs          # heuristics to pick tier
│   │   └── escalator.rs          # retry logic between tiers
│   ├── session/
│   │   ├── mod.rs
│   │   ├── store.rs               # SessionStore (Arc<Mutex<...>>)
│   │   └── cookie.rs              # cookie jar wrapper
│   ├── tiers/
│   │   ├── mod.rs
│   │   ├── tier1_http.rs          # reqwest + html5ever
│   │   ├── tier2_quickjs.rs       # rquickjs + DOM shim
│   │   ├── tier3_deno.rs          # Deno subprocess manager
│   │   └── tier4_remote.rs        # browserless.io client
│   └── utils/
│       ├── html.rs                # HTML cleaning, text extraction
│       └── selector.rs            # CSS selector helpers
└── tests/
    ├── tier1_tests.rs
    ├── tier2_tests.rs
    ├── tier3_tests.rs
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
| `navigate` | `url: string` | `{ text, title, url, tier_used }` | fetches page, returns clean text |
| `get_text` | — | `string` | clean text of current page |
| `get_html` | `selector?: string` | `string` | raw HTML, full or scoped |
| `get_links` | `selector?: string` | `[{ text, href, absolute }]` | all anchor tags |
| `query` | `selector: string` | `[{ html, text, attrs }]` | CSS selector query |
| `click` | `selector: string` | `{ success, new_url? }` | simulate click, follow navigation — tier 2+ |
| `fill` | `selector: string, value: string` | `{ success }` | fill input/textarea — tier 2+ |
| `submit` | `selector?: string` | `{ success, new_url? }` | submit nearest form — tier 2+ |
| `run_js` | `code: string` | `string` | execute JS, return serialized result — tier 2+ |
| `screenshot` | `selector?: string` | `base64 PNG` | tier 3+ only (Deno) |
| `get_cookies` | — | `[{ name, value, domain }]` | session cookies |
| `set_headers` | `headers: object` | `{ success }` | set custom request headers |
| `reset` | — | `{ success }` | clear session, cookies, history |
| `get_history` | — | `[{ url, title, tier }]` | navigation history |

### Tool schema example (navigate)

```rust
#[derive(Deserialize, JsonSchema)]
struct NavigateInput {
    url: String,
    /// Wait for a CSS selector to appear (tier 3+ only — Deno)
    wait_for: Option<String>,
    /// Force a specific tier (1-4). Default: auto.
    force_tier: Option<u8>,
}

#[derive(Serialize)]
struct NavigateOutput {
    text: String,
    title: String,
    url: String,         // final URL after redirects
    tier_used: u8,
    escalation_path: Vec<u8>,
    elapsed_ms: u64,
}
```

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

## 6. Tier 2 — QuickJS + DOM Shim

For sites that need basic JS execution but not full browser APIs. QuickJS (~210KB binary) is embedded directly in the Rust process.

### DOM Shim surface

Only implement what React's render cycle actually needs:

```rust
// src/tiers/tier2_quickjs.rs

const DOM_SHIM_JS: &str = include_str!("../../js/dom_shim.js");

// Minimum DOM API to unblock React render:
// - document.createElement(tag)
// - document.createTextNode(text)
// - element.appendChild(child)
// - element.setAttribute(k, v)
// - element.getAttribute(k)
// - element.innerHTML (setter)
// - element.textContent (getter/setter)
// - document.querySelector(sel)
// - document.querySelectorAll(sel)
// - document.getElementById(id)
// - document.body, document.head
// - window.location.href
// - window.addEventListener (noop)
// - window.requestAnimationFrame (sync noop)
// - console.log (captured)
// - fetch() → proxied to reqwest via Rust callback

pub struct QuickJsRenderer {
    runtime: rquickjs::Runtime,
}

impl QuickJsRenderer {
    pub fn render(&self, html: &str, scripts: Vec<String>) -> Result<String> {
        let ctx = rquickjs::Context::full(&self.runtime)?;
        ctx.with(|ctx| {
            // inject DOM shim
            ctx.eval(DOM_SHIM_JS)?;
            // set document.documentElement from parsed HTML
            inject_html_into_dom(&ctx, html)?;
            // run each script
            for script in &scripts {
                ctx.eval(script.as_bytes())?;
            }
            // serialize final DOM back to HTML string
            extract_dom_html(&ctx)
        })
    }
}
```

### Failure signals to escalate to tier 3

```rust
fn should_escalate(err: &QuickJsError) -> bool {
    let escalate_patterns = [
        "window is not defined",
        "canvas is not defined",
        "WebGL",
        "localStorage",
        "sessionStorage",
        "Worker is not defined",
        "IntersectionObserver",
        "ResizeObserver",
        "MutationObserver",
    ];
    escalate_patterns.iter().any(|p| err.message.contains(p))
}
```

---

## 7. Tier 3 — Deno Subprocess

Full Web API coverage. Spawned as a sandboxed subprocess only when tiers 1-2 fail (or tier 1 → tier 3 directly when `escalate_skip_quickjs = true`).

### Deno subprocess design

```rust
// src/tiers/tier3_deno.rs

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

```typescript
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

interface RenderRequest {
  url: string;
  html: string;              // pre-fetched HTML from Rust
  scripts: string[];         // extracted script contents
  wait_for?: string;         // CSS selector to wait for
  timeout_ms: number;
}

interface RenderResult {
  html: string;
  text: string;
  title: string;
  links: Array<{ text: string; href: string }>;
  error?: string;
}

const request: RenderRequest = JSON.parse(
  new TextDecoder().decode(await Deno.stdin.readable
    .getReader()
    .read()
    .then(r => r.value ?? new Uint8Array()))
);

const parser = new DOMParser();
const doc = parser.parseFromString(request.html, "text/html");

// Patch fetch to use real network (allowed by --allow-net)
// Run scripts in sequence
for (const script of request.scripts) {
  try {
    await eval(script);  // sandboxed by Deno permissions
  } catch (e) {
    // log but continue
  }
}

// Wait for selector if requested
if (request.wait_for) {
  // poll up to timeout_ms
}

const result: RenderResult = {
  html: doc.documentElement?.outerHTML ?? "",
  text: doc.body?.textContent ?? "",
  title: doc.title,
  links: Array.from(doc.querySelectorAll("a[href]")).map(a => ({
    text: (a as HTMLAnchorElement).textContent?.trim() ?? "",
    href: (a as HTMLAnchorElement).href,
  })),
};

console.log(JSON.stringify(result));
```

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
| `--allow-net` | Yes | Target host only |
| `--allow-read` | No | — |
| `--allow-write` | No | — |
| `--allow-env` | No | — |
| `--allow-run` | No | — |
| `--allow-ffi` | No | — |

---

## 8. Tier 4 — Remote Fallback

For the rare case where even Deno fails (canvas, WebGL, complex WASM sites). Optional — disabled by default; opt in via `[tiers].enabled = [1, 2, 3, 4]` in config.

```rust
// src/tiers/tier4_remote.rs

pub struct RemoteBrowser {
    endpoint: String,    // e.g. "https://chrome.browserless.io"
    token: String,
}

impl RemoteBrowser {
    pub async fn render(&self, url: &str) -> Result<String> {
        let resp = reqwest::Client::new()
            .post(format!("{}/content", self.endpoint))
            .query(&[("token", &self.token)])
            .json(&serde_json::json!({
                "url": url,
                "waitFor": 2000,
                "gotoOptions": { "waitUntil": "networkidle2" }
            }))
            .send()
            .await?;

        Ok(resp.text().await?)
    }

    pub async fn screenshot(&self, url: &str) -> Result<Vec<u8>> {
        let resp = reqwest::Client::new()
            .post(format!("{}/screenshot", self.endpoint))
            .query(&[("token", &self.token)])
            .json(&serde_json::json!({ "url": url }))
            .send()
            .await?;

        Ok(resp.bytes().await?.to_vec())
    }
}
```

Configurable alternatives:
- Self-hosted `browserless/chrome` Docker container
- `rebrowser` (open source alternative)
- Any Chrome DevTools Protocol (CDP) endpoint

---

## 9. Session & Cookie Management

Sessions are per-agent-connection and held in memory. No persistence across MCP server restarts by default (opt-in via config).

**Cookie isolation:** every session owns its own `CookieStore`. Cookies are never shared across sessions — two concurrent agents cannot leak credentials to each other even if they hit the same host.

```rust
// src/session/store.rs

pub struct Session {
    pub id: Uuid,
    pub cookies: CookieStore,         // cookie_store crate
    pub custom_headers: HeaderMap,
    pub history: Vec<HistoryEntry>,
    pub current_page: Option<ParsedPage>,
    pub current_tier: u8,
    pub created_at: Instant,
    pub last_active: Instant,
}

pub struct SessionStore {
    sessions: Arc<DashMap<Uuid, Session>>,
    ttl: Duration,   // default: 30 minutes
}

impl SessionStore {
    pub fn get_or_create(&self, id: Option<Uuid>) -> Uuid { ... }
    pub fn with_session<F, R>(&self, id: Uuid, f: F) -> R { ... }
    pub fn cleanup_expired(&self) { ... }  // called by background task
}
```

### Cookie sharing between tiers

All tiers within the same session share that session's cookie jar. Tier 1 sets cookies via reqwest's jar. Tier 3 (Deno) receives cookies as serialized JSON and returns any new cookies it received, which are merged back.

---

## 10. Data Flow & State

### navigate() call flow

```
agent calls navigate(url)
       │
       ▼
SessionStore.get_or_create(session_id)
       │
       ▼
Tier Router
  │
  ├─ Tier1Http.fetch(url)
  │    ├── success + content?  →  HtmlPage.extract_text()  →  return result
  │    └── empty shell?
  │         │
  │         ├─ if escalate_skip_quickjs = true  →  jump to Tier3Deno
  │         │
  │         └─ Tier2QuickJs.render(html, scripts)
  │              ├── renders ok?  →  return result
  │              └── browser API miss?
  │                   │
  │                   ├─ Tier3Deno.render(request)
  │                   │    ├── success?  →  return result
  │                   │    └── fails?
  │                   │         │
  │                   │         └─ Tier4Remote.render(url)  →  return
  │                   │
  │                   └─ (Deno path)
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
    pub tier_used: u8,
    pub escalation_path: Vec<u8>,  // e.g. [1, 2, 3]
    pub elapsed_ms: u64,
}
```

---

## 11. Configuration

### `config.toml`

```toml
[http]
user_agent = "Mozilla/5.0 (compatible; AgentBrowser/1.0)"
timeout_secs = 30
max_redirects = 10
max_body_bytes = 10_485_760   # 10MB

[tiers]
enabled = [1, 2, 3, 4]          # disable tiers to lock down; 4 (remote) is opt-in
max_tier = 3                     # don't use remote fallback unless explicit
escalate_on_empty_dom = true
escalate_threshold_bytes = 500  # escalate if body text < this
escalate_skip_quickjs = false    # set true to skip Tier 2 (T1 → T3 directly)

[tier2]
js_heap_mb = 64
execution_timeout_ms = 5000

[tier3]
deno_path = "/usr/local/bin/deno"     # or "deno" if on PATH
script_path = "./deno/render.ts"
pool_size = 2
idle_timeout_secs = 30
render_timeout_ms = 10000

[tier4]
endpoint = "https://chrome.browserless.io"
token = ""                            # set via env: BROWSERLESS_TOKEN
screenshot_timeout_ms = 15000

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
| `BROWSERLESS_TOKEN` | `tier4.token` |
| `DENO_PATH` | `tier3.deno_path` |
| `MCP_TRANSPORT` | `server.transport` |
| `MCP_MAX_TIER` | `tiers.max_tier` |
| `MCP_LOG_LEVEL` | `server.log_level` |

---

## 12. Error Handling Strategy

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

    #[error("QuickJS execution failed: {0}")]
    QuickJs(String),

    #[error("Deno subprocess failed: {stderr}")]
    DenoFailed { stderr: String },

    #[error("Deno not found at path: {path}")]
    DenoNotFound { path: String },

    #[error("All tiers exhausted for {url}")]
    AllTiersFailed { url: String },

    #[error("Tier {tier} disabled in config")]
    TierDisabled { tier: u8 },

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("Selector not found: {selector}")]
    SelectorNotFound { selector: String },

    #[error("Remote fallback error: {0}")]
    Remote(String),

    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },
}
```

### MCP error mapping

All `BrowserError` variants are mapped to structured MCP error responses so the agent can react (e.g. retry with `force_tier: 4` if told tier 3 failed).

---

## 13. Resource Budgets

### RAM targets

| State | Target |
|-------|--------|
| Server idle (0 sessions) | <5MB |
| 1 active session, tier 1 | <10MB |
| 1 active session, tier 2 (QuickJS) | <20MB |
| 1 active session, tier 3 (Deno) | <40MB (TBD — pending baseline benchmark) |
| 10 concurrent sessions, tier 1 | <50MB |
| 10 concurrent sessions, tier 3 | <200MB (TBD) |

### CPU targets

| Operation | Target |
|-----------|--------|
| Tier 1 fetch + parse | <5ms CPU |
| Tier 2 QuickJS render | <50ms CPU |
| Tier 3 Deno spawn + render | <200ms CPU |

### Binary size targets

| Build | Target |
|-------|--------|
| Debug binary | <50MB |
| Release binary | <15MB |
| Release + UPX compressed | <6MB |

---

## 14. Cargo.toml

```toml
[package]
name = "browser-mcp"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "browser-mcp"
path = "src/main.rs"

[dependencies]
# MCP
rmcp = { version = "0.1", features = ["server", "transport-io", "transport-sse"] }

# Async runtime
tokio = { version = "1", features = ["full"] }

# HTTP
reqwest = { version = "0.12", features = [
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
lol_html = "2.0"

# JS engine (tier 2)
rquickjs = { version = "0.6", features = ["full"] }

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
thiserror = "1"

# Utilities
dashmap = "6"      # concurrent hashmap for session store
uuid = { version = "1", features = ["v4"] }
regex = "1"
base64 = "0.22"
bytes = "1"

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

## 15. Implementation Phases

**v1 ships at the end of Phase 4.** Phase 5 is optional post-v1 polish.

### Phase 1 — Core HTTP + MCP (Week 1–2)

- [ ] Project scaffold, Cargo.toml, module structure
- [ ] `Config` loading from toml + env
- [ ] `BrowserError` enum
- [ ] `SessionStore` with TTL cleanup, per-session cookie isolation
- [ ] `Tier1Http` — reqwest client with per-session cookie jar
- [ ] `HtmlPage` — text/link extraction, empty shell detection
- [ ] MCP server bootstrap with `rmcp` (stdio transport)
- [ ] `navigate`, `get_text`, `get_links`, `reset` tools wired up
- [ ] Basic integration test: fetch static site
- [ ] Baseline RAM benchmark: Tier 1 path

### Phase 2 — Router + Classifier (Week 3, ~3-4 days)

- [ ] `Classifier` — framework detection heuristics (`FrameworkHint`)
- [ ] `Escalator` — retry logic between tiers (T1 → T2 → T3 → T4)
- [ ] `query`, `get_html`, `get_history` tools
- [ ] Unit tests for classifier heuristics
- [ ] Verify `escalate_skip_quickjs` flag correctly bypasses Tier 2

### Phase 3 — QuickJS Tier + Interactive Tools (Week 4–5) — **gates v1**

- [ ] `js/dom_shim.js` — minimal DOM surface for React/Vue render cycle
- [ ] `Tier2QuickJs` — runtime setup, script injection
- [ ] fetch proxy — route JS `fetch()` calls back to reqwest
- [ ] escalation signal detection from QuickJS errors
- [ ] `click`, `fill`, `submit`, `run_js` tools
- [ ] Tests against known React SSR and CSR pages
- [ ] Decision gate: if QuickJS shim is too fragile, flip `escalate_skip_quickjs = true` and continue

### Phase 4 — Deno Tier (Week 6–7) — **gates v1**

- [ ] `deno/render.ts` — SPA renderer script (pin `deno_dom` to a specific version hash via `deno.lock`)
- [ ] `deno/dom_shim.ts` — deno_dom helpers
- [ ] `Tier3Deno` — subprocess spawn with permission flags (explicit host:port in `--allow-net`)
- [ ] `DenoPool` — warm process pool (size 2)
- [ ] Cookie round-trip: Rust → Deno (JSON) → Rust
- [ ] `wait_for` selector support
- [ ] `screenshot` tool (Deno only)
- [ ] Tests: Next.js CSR, Angular SPA, Vue SPA
- [ ] Cross-platform smoke: Linux x86_64, macOS aarch64, macOS x86_64

### Phase 5 — Remote Fallback + Polish (Week 8, optional)

- [ ] `Tier4Remote` — browserless.io client
- [ ] SSE transport option
- [ ] `set_headers`, `get_cookies` tools
- [ ] Full escalation path logged in response metadata
- [ ] Release build + binary size check
- [ ] README + usage examples
- [ ] Distribution: decide between `cargo install`, Homebrew tap, npm wrapper

---

## 16. Testing Strategy

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
async fn test_nextjs_csr_site_escalates_to_tier4() { ... }
```

### Test matrix

| Site type | Expected tier | Test |
|-----------|--------------|------|
| `example.com` | 1 | unit |
| Next.js SSR (`nextjs.org`) | 1 | integration |
| Next.js CSR | 2 or 3 | integration |
| Create React App | 3 | integration |
| Angular Universal | 1 | integration |
| Angular CSR | 3 | integration |

---

## 17. Open Questions

1. **Deno bundling** — ✅ **Resolved (defer to Phase 5).** v1 documents `curl https://deno.land/install.sh | sh` as a prereq; revisit embedding via `deno compile` + `include_bytes!` if install friction surfaces.

2. **Cookie persistence** — should session state optionally serialize to disk (SQLite via `rusqlite`) for long-running agent tasks that outlive the MCP process?

3. **JS sandbox escapes** — QuickJS tier currently trusts the page scripts. Should we add a pre-execution static analysis step to detect and strip potentially dangerous patterns? (Worth doing only if we observe abuse in the wild; defer.)

4. **Concurrent sessions** — the current design uses one cookie jar per session. For high-concurrency use (10+ agents), should we pool reqwest clients or keep one per session? **Tentative answer: one shared `reqwest::Client` (connection pool), one `cookie::Jar` per session via `cookie_provider`.** Validate in Phase 1 benchmark.

5. **Deno version pinning** — ✅ **Resolved.** Pin `deno_dom` to a specific version hash in `deno.lock` from day 1; commit the lockfile. No `https://deno.land/x/.../latest` imports in `render.ts`.

6. **Form-submit in Tier 1** — currently `click`/`fill`/`submit` work only in Tier 2+. Worth implementing a form-submit simulation in Tier 1 (parse form action + method, POST directly) for simple cases? **Likely no** — most real agent flows hit JS-driven forms; the engineering cost is not justified.

7. **Binary distribution** — three options:
   - (a) Document `curl install.deno.net | sh` as a prereq; `cargo install browser-mcp` (current plan, simplest)
   - (b) Embed a pre-compiled Deno binary via `include_bytes!` per platform (single binary, +~80MB)
   - (c) Bootstrap: first run downloads the right Deno, caches in `~/.cache/browser-mcp/`
   **Defer to Phase 5** — pick based on user feedback from v1.

8. **Distribution channel (new)** — where does the end user get the binary?
   - `cargo install` (CLI users)
   - Homebrew tap (macOS users)
   - npm wrapper that downloads the binary (Claude Desktop users)
   - All of the above
   **Defer to Phase 5** but discuss with users early.

---

## 18. Security

Because `browser-mcp` executes arbitrary page-supplied JavaScript (Tier 2) and can issue arbitrary network requests (all tiers), it is a non-trivial attack surface when an untrusted agent prompt is processed. The following are baseline protections; expand as we learn from real-world use.

### Domain allowlist (`[security].allowed_hosts`)

- Empty list = no filter (development default).
- Populated list = reject all navigation/fetch/proxy requests to hosts not in the list. The check applies at:
  - Tier 1: `reqwest` request URL
  - Tier 2: every JS `fetch()` proxied to reqwest
  - Tier 3: enforced as the `--allow-net=host:port` arg when spawning Deno
  - Tier 4: outbound to the configured remote endpoint only (no host check needed)
- Pattern matching supports exact host (`example.com`) and wildcard subdomains (`*.example.com`).

### Cookie isolation

- One `CookieStore` per session. Sessions are keyed by MCP connection ID; never by URL or host.
- Cookies set during a session are not visible to other concurrent sessions, even when both hit the same domain.

### Third-party cookie blocking (`[security].block_third_party_cookies`)

- When `true` (default), `Set-Cookie` headers from cross-origin responses are dropped before being merged into the session jar. This matches browser default behavior since 2023.

### Subprocess sandboxing (Tier 3 Deno)

- `--allow-net=host:port` — only the target host, never wildcard
- `--allow-env=false`, `--allow-read=false`, `--allow-write=false`, `--allow-run=false`, `--allow-ffi=false`
- No persistent state between invocations; stdin/stdout are the only IO channels

### Force-tier advisory

When an agent calls `navigate` with `force_tier: 4` (remote), the server logs a warning and the call must be confirmed by config flag `allow_remote_fallback = true` in production deployments. Otherwise the call returns `BrowserError::TierDisabled`.

### Secret redaction

- `Authorization`, `Cookie`, and `Set-Cookie` headers are redacted from `tracing` output at all log levels.
- The configured `tier4.token` (browserless.io) is never logged, even at debug level.
