# Agent Notes

## Project shape

- Single-package TypeScript ESM MCP server (`slimatlas`). No monorepo.
- Runtime entry: `src/index.ts`. Production build emits to `dist/` via `tsconfig.build.json`.
- Uses `tsx` for dev execution; `node_modules` is present and `package-lock.json` is the lockfile.

## Commands

- `npm run dev` — start the MCP server over stdio (uses `tsx src/index.ts`).
- `npm run build` — compile `src/` to `dist/` with `tsc -p tsconfig.build.json`.
- `npm start` — run the compiled `dist/index.js`.
- `npm test` — run Vitest in watch mode.
- `npm run test:run` — run Vitest once (use this in CI / verification).

No separate lint or typecheck scripts are defined; `npm run build` is the de-facto typecheck.

## Browser architecture

- Default browser on macOS/Linux is **Lightpanda**; the binary lives at repo root as `lightpanda` and is auto-downloaded on first run if missing. It is gitignored.
- **Chrome fallback is enabled by default** (`CHROME_ENABLED=true`). The server switches to Chrome when Lightpanda crashes, times out, or hits bot detection.
- Only macOS and Linux are supported; there is no Windows build.
- `use_chrome=true` on `browser_navigate` forces Chrome for a session.
- Sessions are serialised per `session_id` via an internal queue; concurrent calls to the same session are processed sequentially.

## Environment variables

- Copy `.env.example` to `.env` for local tuning; the server reads vars at startup.
- Notable defaults:
  - `CHROME_ENABLED=true`
  - `STEALTH_ENABLED=true`, `HUMAN_DELAYS_ENABLED=true`
  - `NAVIGATE_WAIT_UNTIL=domcontentloaded`, `NAVIGATE_TIMEOUT=30000`
  - `LIGHTPANDA_POOL_SIZE=5`, `CHROME_POOL_SIZE=1`
  - `CLEANUP_INTERVAL_MS=600000`, `SESSION_IDLE_TIMEOUT_MS=300000`

## TypeScript / module conventions

- ESM only (`"type": "module"`). Imports in `src/` use `.js` extensions even for `.ts` files.
- `tsconfig.json` has `noEmit: true` and includes `src` + `test`; `tsconfig.build.json` extends it, sets `noEmit: false`, `outDir: ./dist`, and includes only `src`.
- `verbatimModuleSyntax: true` is enabled; use `import type` for type-only imports.

## Testing caveats

- Tests hit real network hosts (`example.com`, `example.org`) and launch real browser instances; they require an internet connection.
- `test/integration.test.ts` spawns the server via `npx tsx src/index.ts` and exercises `ChromeManager` directly.
- `test/server.test.ts` and `test/integration.test.ts` share the `chromeManager` singleton from `src/chrome.js`; browser lifecycle leaks across suites can cause flakiness if tests fail to close the browser.
- Vitest has no custom config file; it uses defaults.

## Manual testing helpers

- `mcp_client.py` — interactive Python CLI that talks to the server over stdio.
- `scripts/test-server.ts` — spawns the server and checks it starts without errors.
- `scripts/test-mcp.ts` — end-to-end MCP handshake, tool list, navigate, snapshot, close.

## Browser tools (from `src/server.ts`)

Live source of truth: the `tools/list` MCP response. Currently exposed:

- `browser_navigate` — Navigate to a URL; creates a new session if `session_id` is omitted. Supports `use_chrome=true` to force Chrome.
- `browser_snapshot` — YAML-like accessibility tree with node IDs for targeting.
- `browser_view_node` — Inspect a node from the snapshot (text, URL, or image).
- `browser_click` — Click by node ID (preferred) or CSS selector.
- `browser_type` — Type text into an element, with optional keystroke delay.
- `browser_fill` — Instantly fill an input, clearing any existing value.
- `browser_go_back` / `browser_go_forward` — History navigation.
- `browser_reload` — Reload current page.
- `browser_get_page_info` — Current URL and title.
- `browser_close` — Close the session and free resources.

## Gotchas

- The README and some tests reference tools like `browser_evaluate`, `browser_screenshot`, `browser_get_html`, and `browser_install` that are not exposed by the current server (`src/server.ts`). Treat the live `ListTools` response as the source of truth for available tools.
- `dist/` is gitignored; remember to run `npm run build` before `npm start`.
