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
- **Headful Chrome auto-escalation.** If headless Chrome is also bot-detected (after escalation from Lightpanda), a single per-session switch to headful Chrome (`headless: false`) is triggered automatically. Headful Chrome is **sticky per session** — once escalated, subsequent calls on that session stay headful. The headful pool is lazy: it does not launch or claim resources until a session actually needs it. On macOS the headful browser opens a real visible window (dev-only). On Linux servers without `DISPLAY`, the headful pool lazily spawns `Xvfb` on a free display (`:99`, scanning up to `:103` if taken) and tears it down at shutdown. If `Xvfb` is not installed (`apt-get install xvfb`), escalation fails and the navigate returns an honest `isError` result.
- Only macOS and Linux are supported; there is no Windows build.

- Sessions are serialised per `session_id` via an internal queue; concurrent calls to the same session are processed sequentially.

## Bot detection (`src/server.ts:checkBotDetection`)

Returns `{ blocked, certain, reason }`. Triggers on:

- **Marker scan** (Cloudflare, Akamai, PerimeterX, DataDome, generic): `cf-ray`, `cf-chl-bypass`, `challenge-platform`, `cdn-cgi/challenge-platform`, `checking your browser`, `ddos protection`, `access denied`, `captcha`, `akamai`, `/_bm/`, `bm-challenge`, `px-captcha`, `perimeterx`, `datadome`, `human verification`, `verify you are human`, `bot detection`, `attention required`.
- **Content-presence heuristic** (catches Akamai-style interstitials that don't match markers, e.g. G2's `Title: g2.com`): `bodyText.length < 50 && elCount < 20 && (title === hostname || title.length < 4 || /access denied|verify|checking|challenge|blocked|attention required/i.test(title))`.
- **Internal CDP error** → `{ blocked: true, certain: false }`. Preserves the legacy "Lightpanda CDP failure → switch to Chrome" behaviour without false-positiving Chrome (only `certain: true` triggers escalation on Chrome).

Escalation chain on `browser_navigate`:
```
Lightpanda  ── (bot/timeout) ──▶  headless Chrome  ── (bot, certain) ──▶  headful Chrome  ── (bot, certain) ──▶  isError
```

## Environment variables

- Copy `.env.example` to `.env` for local tuning; the server reads vars at startup.
- Every env var can also be set as a lower-case CLI flag in `--flag=value` form. CLI flags override env vars. Example:
  ```bash
  npx tsx src/index.ts --chrome-enabled=false --lightpanda-pool-size=3 --navigate-timeout=60000
  ```
- Notable defaults:
  - `CHROME_ENABLED=true`
  - `STEALTH_ENABLED=true`, `HUMAN_DELAYS_ENABLED=true`
  - `NAVIGATE_WAIT_UNTIL=domcontentloaded`, `NAVIGATE_TIMEOUT=30000`
  - `LIGHTPANDA_POOL_SIZE=5`, `CHROME_POOL_SIZE=1`, `HEADFUL_CHROME_POOL_SIZE` defaults to `CHROME_POOL_SIZE`
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

- `browser_navigate` — Navigate to a URL; creates a new session if `session_id` is omitted.
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
