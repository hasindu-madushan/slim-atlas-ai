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

No separate lint or typecheck scripts are defined; `npm run build` is the de-facto typecheck. `npx tsc --noEmit` also typechecks the `test/` files.

## Browser architecture — two levels

The server is a strict **2-level** model. Level 1 is always Lightpanda; level 2 is a single configurable fallback browser.

- **Level 1 — Lightpanda (always, not configurable).** The binary lives at repo root as `lightpanda` and is auto-downloaded on first run if missing. It is gitignored. New sessions always start here. `PROXY_SERVER` is forwarded via its `--http-proxy` flag (see `buildLightpandaServeArgs` in `src/pool.ts`), so proxying applies to this layer too.
- **Level 2 — `FALLBACK_BROWSER`.** One of `headless` | `headful` | `browserbase` | `none` (default `none`). Configured via env or `--fallback-browser`. Only the **one** configured pool is constructed, lazily (it spawns nothing until a session actually escalates).
  - `headless` → `ChromePool` (headless Chrome via puppeteer-extra + stealth).
  - `headful` → `HeadfulChromePool`. On macOS it opens a real visible window (dev-only). On headless Linux without `DISPLAY` it lazily spawns `Xvfb` on a free display (`:99`, scanning up to `:103`) and tears it down at shutdown; if `Xvfb` is not installed (`apt-get install xvfb`) escalation fails with an honest `isError`.
  - `browserbase` → `BrowserbasePool`. Cloud browsers via `puppeteer.connect` to Browserbase's WebSocket endpoint; each slot is a remote session created via REST (`POST /v1/sessions`) and deleted on release (`DELETE /v1/sessions/{id}`). No SDK dependency (uses the already-installed puppeteer + Node global `fetch`). Requires `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`.
  - `none` → no fallback. Lightpanda errors and bot challenges propagate honestly as `isError`.

**Escalation (level 1 → 2)** is triggered only at the Lightpanda layer, by:
1. a navigation crash/timeout (`isCrashOrTimeout`), or
2. bot detection reporting `blocked` (see below), or
3. a `getPageInfo` timeout after a successful navigate.

On any of these, if a fallback is configured the session **switches once** to the level-2 pool (sticky for the rest of the session's life) and history is replayed on the new browser. If `FALLBACK_BROWSER=none`, the error propagates.

**Level 2 is trusted:** no bot detection runs on it, and there is no third tier. Whatever it returns is returned to the caller.

Escalation chain:
```
Lightpanda  ── (crash / timeout / bot) ──▶  FALLBACK_BROWSER  ──▶  (no further escalation)
```

### Per-domain routing — `SKIP_LIGHTPANDA_DOMAINS`

Comma-separated, subdomain-aware (e.g. `g2.com` matches `www.g2.com`, `sellers.g2.com`). On `browser_navigate`, a session currently on Lightpanda whose target host matches the list **starts directly on the level-2 fallback**, skipping the Lightpanda attempt entirely. The switch is sticky.

**Requires `FALLBACK_BROWSER != none`.** If the list is set but the fallback is `none`, the list is ignored and a single warning is logged at startup (`SKIP_LIGHTPANDA_DOMAINS set but FALLBACK_BROWSER=none — per-domain skipping is disabled`); matched domains then use Lightpanda like everything else.

Only macOS and Linux are supported; there is no Windows build.

## Bot detection (`src/bot-detection.ts`)

A standalone in-process service (`BotDetectionService`) imported by `src/server.ts`. Returns `{ blocked: boolean; reason: string }` (no `certain` field — that only mattered for the removed 3-tier model).

**Runs only at the Lightpanda layer** (level 1), purely as the escalation trigger described above. It never runs on a level-2 browser.

Detection evaluates, in order:
- **Strong structural markers** (block): HTML contains any of `cf-chl-bypass`, `cdn-cgi/challenge-platform`, `px-captcha`, `bm-challenge`, `/_bm/`, `datadome`.
- **Challenge title prefix** (block): `document.title` matches `/^(just a moment|checking your browser|access denied|ddos protection|human verification|verify you are human|attention required)\b/i`.
- **Near-empty body** (block): `bodyText.length < 50 && elementCount < 20`. Lightpanda *does* execute JavaScript, but its JS engine is incomplete relative to a full desktop browser, so pages that lean on advanced or unsupported APIs can render to a near-empty DOM. A near-empty body thus signals the page didn't render usefully and is worth retrying on the level-2 browser.
- **Probe failure** (block): if the `page.evaluate` probe itself throws, returns `blocked: true` with `reason: "detection failed: …"` (mirrors the legacy "Lightpanda render failure → switch to a real browser" behaviour).

The old Chrome/CDP detection (`checkBotDetectionChrome`) and the weak-marker logic were removed — they were only relevant to the deleted middle/headful tiers.

## Session management (`src/session.ts`, `src/server.ts`)

- **Per-session serialisation via `fastq`.** `PuppeteerMCPServer` keeps a `Map<sessionId, fastq.promise queue (concurrency 1)>`. Calls to the **same** session run strictly sequentially; calls to **different** sessions run in parallel. (This replaced a hand-rolled promise-chain whose catch-branch double-ran the tool and could leak browsers.)
- **`MAX_SESSIONS`** (env / `--max-sessions`, default `0` = unlimited). `acquire()` rejects new sessions beyond the cap with an honest error.
- **Disconnect recovery.** `ensureConnected(sessionId)` is called before each tool; if the underlying browser died (`!manager.isConnected()`), it re-acquires from the **same layer** (Lightpanda or the fallback) and replays history.
- **Layer switch replays history.** `SessionManager.switchToFallback()` detaches Lightpanda, attaches the fallback, and replays recorded actions (`src/history.ts`) from the last navigate onward.
- **Graceful shutdown.** `index.ts` wires `SIGINT`/`SIGTERM` → `server.shutdown()`, which stops the cleanup timer, `.kill()`s every session queue, releases all sessions, and shuts down both pools.
- **Idle cleanup.** A timer (`CLEANUP_INTERVAL_MS`) releases sessions idle longer than `SESSION_IDLE_TIMEOUT_MS` and purges orphaned pool instances.

## Environment variables

- Copy `.env.example` to `.env` for local tuning; the server reads vars at startup.
- Every env var can also be set as a lower-case CLI flag in `--flag=value` form. CLI flags override env vars. Unknown flags throw at startup and the process exits(1). Example:
  ```bash
  npx tsx src/index.ts --fallback-browser=headless --lightpanda-pool-size=3 --skip-lightpanda-domains=g2.com --navigate-timeout=60000
  ```
- Notable defaults:
  - `FALLBACK_BROWSER=none`
  - `SKIP_LIGHTPANDA_DOMAINS=` (empty)
  - `MAX_SESSIONS=0` (unlimited)
  - `STEALTH_ENABLED=true`, `HUMAN_DELAYS_ENABLED=true`
  - `NAVIGATE_WAIT_UNTIL=domcontentloaded`, `NAVIGATE_TIMEOUT=30000`
  - `LIGHTPANDA_POOL_SIZE=5`, `CHROME_POOL_SIZE=1`, `HEADFUL_CHROME_POOL_SIZE` defaults to `CHROME_POOL_SIZE`
  - `CLEANUP_INTERVAL_MS=600000`, `SESSION_IDLE_TIMEOUT_MS=300000`
  - Rate limiting: `RATE_LIMIT_DOMAINS=` (empty), `RATE_LIMIT_MIN_DELAY_MS=0`, `RATE_LIMIT_JITTER_MS=0`
  - Browserbase (only when `FALLBACK_BROWSER=browserbase`): `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_POOL_SIZE`, `BROWSERBASE_API_URL=https://api.browserbase.com/v1`, `BROWSERBASE_CONNECT_HOST=wss://connect.browserbase.com`

### Rate limiting (`src/rate-limit.ts`)

`RateLimiter` enforces a server-wide minimum delay between `browser_navigate` calls to configured domains; patterns support wildcards (`*` = all hosts each throttled independently, `*.reddit.com` = subdomains only grouped under the suffix, literal = apex+subdomains sharing one bucket). Disabled unless both `RATE_LIMIT_DOMAINS` is non-empty and `RATE_LIMIT_MIN_DELAY_MS > 0`; `RATE_LIMIT_JITTER_MS` adds fresh `0..N` ms per hit so pacing isn't a fixed interval.

### Removed config (migration notes)

- `CHROME_ENABLED` and the `--chrome-enabled` flag are **gone**. Use `FALLBACK_BROWSER` instead (`none` ≈ the old `CHROME_ENABLED=false`; `headless`/`headful` ≈ the old default).
- `SKIP_HEADLESS_DOMAINS` / `--skip-headless-domains` is **renamed** to `SKIP_LIGHTPANDA_DOMAINS` / `--skip-lightpanda-domains`. A client still passing the old flag will get `Unknown flag: --skip-headless-domains` and the server will exit(1) at startup (stdio closes → MCP client sees "Connection closed").

## TypeScript / module conventions

- ESM only (`"type": "module"`). Imports in `src/` use `.js` extensions even for `.ts` files.
- `tsconfig.json` has `noEmit: true` and includes `src` + `test`; `tsconfig.build.json` extends it, sets `noEmit: false`, `outDir: ./dist`, and includes only `src`.
- `verbatimModuleSyntax: true` is enabled; use `import type` for type-only imports.
- The three fallback pools (`ChromePool`, `HeadfulChromePool`, `BrowserbasePool`) all `implements FallbackPool` (interface in `src/session.ts`), so signature drift is caught at compile time.

## Testing caveats

- Tests hit real network hosts (`example.com`, `example.org`) and launch real browser instances; they require an internet connection.
- `test/integration.test.ts` spawns the server via `npx tsx src/index.ts` and exercises `ChromeManager` directly.
- `test/server.test.ts` and `test/integration.test.ts` share the `chromeManager` singleton from `src/chrome.js`; browser lifecycle leaks across suites can cause flakiness if tests fail to close the browser.
- `test/cli-args.test.ts` asserts the current CLI surface (including that removed flags `--chrome-enabled` / `--skip-headless-domains` are now rejected).
- Browserbase has no automated test (needs real cloud credentials); validate manually with `BROWSERBASE_API_KEY`/`BROWSERBASE_PROJECT_ID` set.
- Vitest has no custom config file; it uses defaults.

## Manual testing helpers

- `mcp_client.py` — interactive Python CLI that talks to the server over stdio.
- `scripts/test-server.ts` — spawns the server and checks it starts without errors.
- `scripts/test-mcp.ts` — end-to-end MCP handshake, tool list, navigate, snapshot, close. (Its session-id regex parses the raw JSON stream, so it misreads the id when the body contains `\n`; the server response format itself is correct.)

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

- Some docs/tests still reference tools like `browser_evaluate`, `browser_screenshot`, `browser_get_html`, and `browser_install` that are **not** exposed by the current server (`src/server.ts`). Treat the live `ListTools` response as the source of truth for available tools.
- `dist/` is gitignored; remember to run `npm run build` before `npm start`.
- The Browserbase connect-URL/REST contract is implemented against Browserbase's documented shape but should be re-validated against current docs when real credentials are introduced.
