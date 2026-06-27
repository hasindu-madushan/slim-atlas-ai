<div align="center">
  <img src="img/slim-atlas-logo.svg" alt="SlimAtlas AI Logo" width="180">
</div>

<h1 align="center">SlimAtlas AI</h1>

<p align="center">
  A Model Context Protocol (MCP) server for token-efficient browser automation, built for agents.
</p>

<p align="center">
  Works with <strong>macOS</strong> and <strong>Linux</strong>.
</p>

<p align="center">
  Built on top of <a href="https://pptr.dev/">Puppeteer</a> and <a href="https://github.com/lightpanda-io/browser">Lightpanda</a>.
</p>

## Features

- **Browser Automation**: Navigate, click, type, fill forms, and evaluate JavaScript
- **Page Snapshots**: Get compact YAML accessibility tree snapshots with unique node IDs for precise element targeting
- **LLM-Optimized Context**: Snapshots are stripped to semantic essentials, keeping context usage tiny so you can fit more pages and longer sessions into the same window
- **Node Inspection**: View specific nodes by ID to inspect text content or images
- **History Navigation**: Go back, go forward, and reload pages
- **Lightweight by Default**: Uses Lightpanda browser (9x less memory than Chrome, 11x faster)
- **Configurable Fallback Browser**: Two-level model — Lightpanda first, then escalate to **headless Chrome**, **headful Chrome**, or **Browserbase** cloud browsers when Lightpanda crashes, times out, or is bot-detected. Disable with `FALLBACK_BROWSER=none`.
- **Per-Domain Routing**: List known-hard sites (`SKIP_LIGHTPANDA_DOMAINS`) that skip Lightpanda and start directly on the fallback browser.
- **Robust Session Management**: Per-session serialization, optional session cap (`MAX_SESSIONS`), mid-session crash recovery with history replay, and graceful shutdown.
- **Session Management**: Reuse sessions across multiple operations with unique session IDs
- **Cross-Platform**: Works on macOS and Linux (Lightpanda), with a configurable real-browser fallback when needed

## Installation

```bash
# Install dependencies
npm install
```

Lightpanda binary will be downloaded automatically on first run. You can also manually download it:

```bash
# Linux x86_64
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux && chmod a+x ./lightpanda

# macOS aarch64 (Apple Silicon)
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos && chmod a+x ./lightpanda

# macOS x86_64
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-macos && chmod a+x ./lightpanda
```

**Fallback browser**: Level 1 is always Lightpanda. Level 2 is `FALLBACK_BROWSER` — one of `headless` (Chrome), `headful` (Chrome), `browserbase` (cloud), or `none` (default, no fallback). When Lightpanda crashes, times out, or is bot-detected, the session switches once to the configured fallback. Chrome/Chromium can be installed locally or auto-downloaded by Puppeteer; Browserbase requires API credentials (see below).

## Usage

### Run the MCP Server

```bash
# Run with npm
npm run dev
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

**Tip**: Set `FALLBACK_BROWSER=none` to use Lightpanda only and propagate errors honestly. Use `headless`, `headful`, or `browserbase` to enable a real-browser fallback.

### Fallback browser

| `FALLBACK_BROWSER` | Level 2 browser | Notes |
|---|---|---|
| `none` (default) | — | Lightpanda only; errors propagate honestly |
| `headless` | Headless Chrome | Sized by `CHROME_POOL_SIZE` |
| `headful` | Headful Chrome | Real window on macOS; needs `xvfb` on headless Linux |
| `browserbase` | Browserbase cloud | Requires `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` |

**Skip Lightpanda for known-hard domains** with `SKIP_LIGHTPANDA_DOMAINS` (comma-separated, subdomain-aware). Matched hosts start directly on the fallback browser. Requires `FALLBACK_BROWSER != none` (otherwise the list is ignored with a warning).

### CLI Flags

Every environment variable in `.env.example` can also be passed as a lower-case CLI flag in `--flag=value` form. CLI flags override environment variables. Unknown flags cause the server to exit at startup.

```bash
npx tsx src/index.ts --fallback-browser=headless --lightpanda-pool-size=3 --skip-lightpanda-domains=g2.com --navigate-timeout=60000
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
        "--fallback-browser=headless",
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
# Returns: session_id: abc1, result: [lightpanda] Navigated to https://example.com. Title: Example Domain

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
- Lightpanda browser (macOS/Linux, downloads automatically) or Chrome/Chromium (fallback)

## License

MIT
