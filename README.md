# slim-atlas

A Model Context Protocol (MCP) server that provides lightweight browser
automation capabilities for AI agents.

Built in Rust with a two-tier rendering architecture:

1. **Tier 1** — plain HTTP + HTML parse (cheap, handles SSR pages)
2. **Tier 2** — Deno subprocess + happy-dom (handles SPAs, runs external JS bundles,
   click/fill/submit interactive tools)

A legacy TypeScript implementation built on Puppeteer + Lightpanda is kept at
[`archive/slim-atlas/`](archive/slim-atlas/README.md) for reference.

## Status

**Phase 2 of 4** (in progress). Tier 1 (HTTP) and Tier 2 (Deno + happy-dom)
are both wired into the MCP server with 7 tools:

- `navigate` — fetch a URL, return an acknowledgement (`session_id`, `title`,
  `url`, `elapsed_ms`); content is fetched via `get_text` / `get_html`.
  Tries Tier 1 first; auto-escalates to Tier 2 on known-CSR frameworks
  (Next.js CSR, React CSR, Angular CSR) and on empty-DOM detection.
- `get_text` — clean text of the current page (optionally scoped by selector)
- `get_html` — raw HTML, full or scoped
- `query` — run a CSS selector and return matching elements
- `click` — T1 fast path for `<a href>` links; T2 (happy-dom) for buttons, divs,
  forms, mailto:/javascript:/#fragment links, and any other clickable
  element. Auto-escalates when the T1 fast path misses.
- `fill` — T2 only. Set the value of an `<input>` or `<textarea>`.
- `submit` — T2 only. Submit a `<form>` (with or without a selector).

All tool results are returned as a single `content[0].text` JSON string (no
`structuredContent` field — keeps the wire payload minimal and avoids the
duplication that `rmcp`'s `Json<T>` wrapper would otherwise emit).

### Tier 2 (Deno + happy-dom)

Tier 2 spins up a Deno subprocess per call. The script (`deno/render.ts`)
pre-fetches the page and any `<script src="...">` bundles with Deno's
allowlisted `fetch`, inlines the script bodies, then constructs a
happy-dom `Window` with `disableJavaScriptFileLoading: true` and lets
happy-dom run the inlined scripts during parse. This means:

- External `<script src="...">` bundles are fetched through the same
  `--allow-net` sandbox as the initial page load, then inlined as
  `<script>...</script>` before happy-dom sees them. This lets
  React / Vue / Angular mount into the DOM tree. (The previous
  `deno_dom` parser never ran external scripts, so production SPA
  shells came back empty.)
- happy-dom's own subresource loader is disabled — happy-dom 16's
  `Browser.goto` path uses node:http internally, which bypasses
  Deno's permission system. We pre-fetch externally so the sandbox
  is preserved end-to-end.
- Cookies from the session jar are seeded onto `document.cookie`,
  and any cookies the page's JS sets are read back and synthesized
  as `Set-Cookie` header strings in the response.

The subprocess runs with `--allow-net=<hosts>`, where `<hosts>` is the
union of the page's own origin, the form actions, and the `<script
src>` / `<link href>` / `<img src>` hosts found in the page — capped
at 16 hosts total. `--allow-env` (no value list) is also granted
because happy-dom's transitive npm deps read `process.env` at import
time. The cost is modest: the script only sees the env vars npm
packages check for (`DEBUG`, `NODE_DEBUG`, `PATH`, etc.).
`--allow-read`, `--allow-write`, `--allow-run`, `--allow-ffi` are
explicitly denied.

Deno is auto-installed on first T2 call to
`~/.cache/slim-atlas/deno/<version>/` (pinned to v2.8.2 today; the
`DENO_VERSION` env var overrides).

### Tier 2 limitations

happy-dom is a JavaScript implementation of the DOM, not a real
browser. Pages that depend on the following will not render
correctly:

- **WebGL / Canvas** — happy-dom does not implement a layout or
  paint pipeline, so `<canvas>`-based UIs and WebGL contexts come
  back blank.
- **WebRTC / MediaSource / Service Workers** — not implemented in
  happy-dom.
- **Bot detection** — pages that fingerprint the runtime (e.g.
  Cloudflare, DataDome) may serve alternate content. happy-dom's
  default `navigator.userAgent` is `Mozilla/5.0 (linux)
  AppleWebKit/537.36`, which some bot checks flag.
- **Custom Elements with Shadow DOM** — happy-dom has partial
  Declarative Shadow DOM support; pages that rely on polyfilled
  shadow DOM may not render correctly.

For these cases, the agent will see whatever happy-dom was able to
construct. Future work (Phase 3+): a real-headless-engine fallback
(Playwright) for pages happy-dom can't render.

Phase 3 brings up the warm pool and screenshots. Phase 4 is polish +
distribution. See [`DESIGN.md`](DESIGN.md) for the full plan.

## Requirements

- Rust 1.75+ (stable)
- macOS (aarch64 or x86_64) or Linux x86_64

## Build

```bash
cargo build              # debug
cargo build --release    # release
```

## Run

```bash
cargo run
```

The server speaks MCP over stdio. Configure it as an MCP server in your client
(Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "slim-atlas": {
      "command": "cargo",
      "args": ["run", "--manifest-path", "/path/to/slim-atlas/Cargo.toml"]
    }
  }
}
```

For a release binary:

```json
{
  "mcpServers": {
    "slim-atlas": {
      "command": "/path/to/target/release/slim-atlas"
    }
  }
}
```

## Test client

`test_client.py` is an interactive CLI for manual testing and one-shot
invocations. It auto-spawns the release binary (or `target/debug/slim-atlas`
if release isn't built).

```bash
# Interactive REPL
python3 test_client.py

# One-shot
python3 test_client.py navigate https://example.com/
python3 test_client.py get_text <session_id>
python3 test_client.py query <session_id> "h1"
```

The default output mode is `full` (the exact JSON-RPC response). Pass
`--mode text` to show only `content[0].text` (the tool's typed output,
pretty-printed).

## Configuration

Optional `config.toml` at the working directory. All keys have defaults; the
file is not required for basic operation. See
[`DESIGN.md` §9](DESIGN.md#9-configuration) for the full schema.

Environment overrides:

- `MCP_TRANSPORT` — `stdio` (default) or `sse`
- `MCP_MAX_TIER` — caps which tiers are used
- `MCP_LOG_LEVEL` — `debug` | `info` | `warn` | `error`
- `DENO_PATH` — override the `deno` binary path (default: auto-discover)
- `DENO_VERSION` — pinned Deno version for auto-install (default: 2.8.2)

## Testing

```bash
cargo test               # unit + wiremock integration
cargo clippy -- -D warnings
cargo fmt --check
```

Network-gated tests (real `example.com`, `nextjs.org`) are marked
`#[ignore]`. Run with:

```bash
cargo test -- --ignored
```

## License

MIT
