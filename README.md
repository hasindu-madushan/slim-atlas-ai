# slim-atlas

A Model Context Protocol (MCP) server that provides lightweight browser
automation capabilities for AI agents.

Built in Rust with a two-tier rendering architecture:

1. **Tier 1** — plain HTTP + HTML parse (cheap, handles SSR pages)
2. **Tier 2** — Deno subprocess with full Web API coverage (handles SPAs and
   interactive tools)

A legacy TypeScript implementation built on Puppeteer + Lightpanda is kept at
[`archive/slim-atlas/`](archive/slim-atlas/README.md) for reference.

## Status

**Phase 1 of 4** (in progress). Implements the read-only Tier 1 (HTTP) path
and the MCP stdio server with 5 tools:

- `navigate` — fetch a URL, return an acknowledgement (`session_id`, `title`,
  `url`, `elapsed_ms`); content is fetched via `get_text` / `get_html`
- `get_text` — clean text of the current page (optionally scoped by selector)
- `get_html` — raw HTML, full or scoped
- `query` — run a CSS selector and return matching elements
- `click` — Phase 1 (T1-only) handles `<a href>` links; the T2 (Deno) fast
  path for buttons, divs, forms, and JS-driven click targets is planned for
  Phase 3

All tool results are returned as a single `content[0].text` JSON string (no
`structuredContent` field — keeps the wire payload minimal and avoids the
duplication that `rmcp`'s `Json<T>` wrapper would otherwise emit).

Session IDs are short — 4 characters from a Crockford base32 alphabet
(`0-9a-z` minus `i/l/o/u`). 32^4 = 1,048,576 unique IDs, well within the
safe zone for the default `max_sessions = 50` (collision probability ~0.005%
per `create()`). Agents can pass them through every tool call without
meaningful token overhead.

Phase 2 adds the router/classifier (T1 → T2 escalation). Phase 3 brings up the
Deno Tier 2 (SPAs, interactive tools, screenshots) and is the v1 gate. Phase 4
is polish + distribution. See [`DESIGN.md`](DESIGN.md) for the full plan.

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
