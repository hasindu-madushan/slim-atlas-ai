<div align="center">
  <img src="img/slim-atlas-logo.svg" alt="SlimAtlas AI Logo" width="180">
</div>

<h1 align="center">SlimAtlas AI</h1>

<p align="center">
  An extremely lightweight standalone MCP server for token-efficient browser automation for AI agents, designed to run on servers.
</p>

<p align="center">
  16x less memory. 9x faster execution. Up to 10x more token efficient than raw HTML.
</p>

<p align="center">
  Works with <strong>Linux</strong> and <strong>macOS</strong>.
</p>

<p align="center">
  Built on top of <a href="https://pptr.dev/">Puppeteer</a> and <a href="https://github.com/lightpanda-io/browser">Lightpanda</a>.
</p>

## Features

- **Browser Automation**: Navigate, click, type, fill forms, and evaluate JavaScript
- **Lightweight by Default**: 16x less memory than Chrome, 9x faster execution
- **Page Snapshots**: Get compact YAML accessibility tree snapshots with unique node IDs for precise element targeting
- **LLM-Optimized Context**: Snapshots are stripped to semantic essentials, keeping context usage tiny so you can fit more pages and longer sessions into the same window
- **Configurable Fallback Browser**: Two-level model — lightweight browser first, then escalate to **headful Chrome**, **Browserless** or **Browserbase** cloud browsers only when the default is bot-detected, crashes, or times out.
- **Rate Limiting**: Stay under the radar. Enforce a configurable minimum delay between requests to specific domains with wildcard patterns (`*`, `*.reddit.com`) plus optional jitter, so your agent paces itself instead of hammering a site and tripping its bot defenses.
- **Proxy Support**: Route every request through an HTTP proxy with a single `PROXY_SERVER` setting — applied automatically to **both** browser layers, so your real IP never touches the target. Supports inline basic auth (`http://user:pass@host:port`).
- **Robust Session Management**: Per-session serialization, optional session cap (`MAX_SESSIONS`), mid-session crash recovery with history replay, and graceful shutdown.
- **Session Management**: Reuse sessions across multiple operations with unique session IDs
- **Cross-Platform**: Works on Linux and macOS, with a configurable real-browser fallback when needed

## Installation

```bash
# Install dependencies
npm install
```

Browser binary is downloaded automatically on first run.

**Fallback browser**: Level 1 is always the lightweight browser. Level 2 is `FALLBACK_BROWSER` — one of `headless` (headless Chrome), `headful` (headful Chrome), `browserbase` (cloud), `browserless` (cloud), or `none` (default, no fallback). When the default crashes, times out, or is bot-detected, the session switches once to the configured fallback. Chrome is bundled by Puppeteer; Browserbase/Browserless require API credentials (see below).

## Usage

### Run the MCP Server

```bash
# Standalone HTTP server (default)
npm run start -- --port=8080

# Remote, authenticated
MCP_AUTH_TOKEN=s3cret npm start -- --host=0.0.0.0 --port=8080
```

SlimAtlas exposes a single **Streamable HTTP** `/mcp` endpoint. Each client gets its own session via the `mcp-session-id` header; `MAX_SESSIONS` bounds concurrency. Point your MCP client at it:

```json
{
  "mcpServers": {
    "slimatlas": {
      "url": "http://localhost:8080/mcp",
      "transport": "http"
    }
  }
}
```

With authentication:

```json
{
  "mcpServers": {
    "slimatlas": {
      "url": "http://your-host:8080/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer s3cret" }
    }
  }
}
```

**Tip**: Use `--host=0.0.0.0` to expose remotely, but always set `MCP_AUTH_TOKEN` when doing so.

### Docker

The image bundles the Lightpanda binary at build time, so the container starts self-contained and never re-downloads:

```bash
docker build -t slimatlas .
docker run -p 8080:8080 -e MCP_AUTH_TOKEN=s3cret slimatlas
# -> http://localhost:8080/mcp
```

Pin a Lightpanda release for reproducible builds (any `lightpanda-io/browser` tag — default `nightly`):

```bash
docker build --build-arg LIGHTPANDA_VERSION=0.3.3 -t slimatlas:0.3.3 .
```

Multi-arch is handled automatically — the build detects the container's arch via `uname -m` (`x86_64` → `lightpanda-x86_64-linux`, `aarch64` → `lightpanda-aarch64-linux`), so the binary always matches the platform being built.

> **Apple Silicon (M-series Macs):** pass `--platform linux/arm64` to build/run natively. Without it, Docker Desktop may default to `amd64` and run the container under Rosetta, which fails to launch the Lightpanda binary (`rosetta error: failed to open elf …`).
> ```bash
> docker build --platform linux/arm64 -t slimatlas .
> docker run --platform linux/arm64 -p 8080:8080 -e MCP_AUTH_TOKEN=s3cret slimatlas
> ```

**Headful fallback variant.** The default image runs Lightpanda only (`FALLBACK_BROWSER=none`). To enable the headful Chrome fallback (needed only if you set `FALLBACK_BROWSER=headful` at runtime), build the headful variant — it adds the Chrome runtime libraries + Xvfb (~150MB) and presets `FALLBACK_BROWSER=headful`:

```bash
docker build --build-arg FALLBACK_BROWSER=headful -t slimatlas:headful .
docker run -p 8080:8080 -e MCP_AUTH_TOKEN=s3cret slimatlas:headful
```

Xvfb is started lazily inside the container on the first session that escalates to headful Chrome — no entrypoint or manual `xvfb-run` needed.

### Stdio Mode

For MCP clients that spawn the server as a subprocess (local, single-client), use stdio transport:

```bash
npx tsx src/index.ts
```

```json
{
  "mcpServers": {
    "slimatlas": {
      "command": "npx",
      "args": ["tsx", "path/to/mcp/src/index.ts"]
    }
  }
}
```

### Configuration

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "slimatlas": {
      "command": "npx",
      "args": ["tsx", "path/to/mcp/src/index.ts"]
    }
  }
}
```

**Tip**: Set `FALLBACK_BROWSER=none` to use the lightweight browser only and propagate errors honestly. Use `headful` or `browserbase` to enable a real-browser fallback.

See [docs/configs.md](docs/configs.md) for all environment variables and CLI flags.

### Fallback browser

| `FALLBACK_BROWSER` | Level 2 browser | Notes |
|---|---|---|
| `none` (default) | — | Lightweight browser only; errors propagate honestly |
| `headful` | Headful Chrome | Real window on macOS; needs `xvfb` on headless Linux |
| `browserbase` | Browserbase cloud | Requires `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` |

**Skip the default browser for known-hard domains** with `SKIP_LIGHTPANDA_DOMAINS` (comma-separated, subdomain-aware). Matched hosts start directly on the fallback browser. Requires `FALLBACK_BROWSER != none` (otherwise the list is ignored with a warning).

### Rate limiting

Polite, anti-detection pacing for your agent. `RateLimiter` enforces a server-wide minimum delay between `browser_navigate` calls to the domains you list, with optional random jitter so the cadence isn't a fixed, fingerprintable interval. Buckets are keyed per host across **all** sessions (because the target site sees your IP, not your sessions), and patterns support wildcards:

| Pattern | Matches | Bucket |
|---|---|---|
| `*` | Every host | Each host throttled independently |
| `*.reddit.com` | Subdomains only (`www.reddit.com`, `old.reddit.com`) — **not** `reddit.com` | All matching subdomains share one bucket |
| `g2.com` | `g2.com` + its subdomains | Apex + subdomains share one bucket |

Disabled by default. Enable with a non-empty domain list **and** a non-zero delay:

```bash
# Via CLI flags
npx tsx src/index.ts --rate-limit-domains=*.reddit.com,g2.com --rate-limit-min-delay-ms=2000 --rate-limit-jitter-ms=1500

# Or via environment / .env
RATE_LIMIT_DOMAINS=*.reddit.com,g2.com
RATE_LIMIT_MIN_DELAY_MS=2000
RATE_LIMIT_JITTER_MS=1500
```

### Proxy

Keep your real IP off the target. Set a single `PROXY_SERVER` and SlimAtlas routes **all** HTTP traffic from **both** browser layers through it — no per-browser wiring needed:

- **Lightweight browser (level 1)** — forwarded via its native `--http-proxy` flag.
- **Chrome fallback (level 2)** — applied via `--proxy-server` at launch.

```bash
# Via CLI flag
npx tsx src/index.ts --proxy-server=http://host:8080

# Or via environment / .env
PROXY_SERVER=http://user:pass@host:8080
```

Inline basic auth (`http://user:pass@host:port`) is supported on the lightweight browser layer. For IP-allowlisted proxies (no credentials) it just works on both layers. *(Per-page Chrome authentication via `page.authenticate` is on the roadmap.)*

### CLI Flags

Every environment variable can also be passed as a lower-case CLI flag in `--flag=value` form. CLI flags override environment variables. Unknown flags cause the server to exit at startup. See [docs/configs.md](docs/configs.md) for the full list.

```bash
npx tsx src/index.ts --fallback-browser=headful --lightpanda-pool-size=3 --skip-lightpanda-domains=g2.com --navigate-timeout=60000
```

To use flags from an MCP client, append them to the `args` array:

```json
{
  "mcpServers": {
    "slimatlas": {
      "command": "npx",
      "args": [
        "tsx",
        "path/to/mcp/src/index.ts",
        "--fallback-browser=headful",
        "--skip-lightpanda-domains=g2.com,linkedin.com",
        "--chrome-pool-size=3"
      ]
    }
  }
}
```

### Usage Workflow

```python
# Example: Navigate, snapshot, and interact with a page

# 1. Navigate to a URL (creates a new session automatically)
result = mcp.call("browser_navigate", {"url": "https://example.com"})
# Returns: session_id: abc1, result: Navigated to https://example.com. Title: Example Domain

# 2. Take a snapshot to see the page structure
snapshot = mcp.call("browser_snapshot", {"session_id": "abc1"})
# Returns YAML with node IDs like: 0: {type: div, children: ...}

# 3. Click a node by ID (from the snapshot)
mcp.call("browser_click", {"session_id": "abc1", "nodeId": 2})

# 4. Type into a search box
mcp.call("browser_type", {"session_id": "abc1", "nodeId": 5, "text": "search query"})

# 5. Close the session when done
mcp.call("browser_close", {"session_id": "abc1"})
```

## Available Tools

| Tool | Description | Value |
|------|-------------|-------|
| `browser_navigate` | Navigate to a URL with configurable wait strategy | Entry point for all web interactions. Supports `load`, `domcontentloaded`, `networkidle0`, `networkidle2` |
| `browser_snapshot` | Get YAML accessibility tree with unique node IDs | Structured page representation ideal for LLM understanding. Node IDs enable precise targeting for clicks/types |
| `browser_view_node` | View specific node content by ID (text or image) | Inspect individual elements without full page re-read. Returns images as base64 for visual verification |
| `browser_click` | Click element by node ID or CSS selector | Node ID (from snapshot) is recommended over CSS selectors for reliability and simplicity |
| `browser_type` | Type text into element with optional keystroke delay | Simulates human typing. Use for search boxes, forms, and text inputs |
| `browser_fill` | Fill input element with a value instantly | Faster than `browser_type` for form fields. Clears existing value before filling |
| `browser_go_back` | Navigate back in browser history | Essential for multi-step workflows and correcting navigation mistakes |
| `browser_go_forward` | Navigate forward in browser history | Complements `browser_go_back` for bidirectional navigation |
| `browser_reload` | Reload the current page | Refresh dynamic content or recover from stale page state |
| `browser_get_page_info` | Get current page URL and title | Quick way to verify navigation success and current context |
| `browser_close` | Close browser session and free resources | Important for cleanup. Sessions auto-close on timeout, but explicit closing is recommended |

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npx vitest
```

## Requirements

- Node.js 18+
- Linux or macOS (downloads automatically) or Chrome/Chromium (fallback)

## License

MIT
