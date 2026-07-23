# Contributing to SlimAtlas

Thanks for wanting to help. This is a lightweight MCP server for browser automation — every PR, bug report, or doc improvement is appreciated.

## Quick setup

You need [Bun](https://bun.sh/) ≥1.1.

```bash
bun install
bun run src/index.ts            # start the server (stdio mode)
bun run src/index.ts --transport=http --port=8080  # HTTP mode
```

No build step — Bun runs TypeScript natively. `src/index.ts` is the entry point.

## Running tests

```bash
bun test                        # once
bun test --watch                # watch mode
npx tsc --noEmit                # typecheck everything
```

Tests hit real network hosts (`example.com`, `example.org`) and launch real browsers — internet connection required. Some tests need a Chrome/Chromium binary available.

## Code conventions

- ESM only (`"type": "module"`). Imports in `src/` use `.js` extensions even for `.ts` files.
- `verbatimModuleSyntax: true` — use `import type` for type-only imports.
- No unrequested abstractions. One implementation → no interface. Copy what's already there.
- Read `AGENTS.md` for architecture docs and gotchas.

## What to work on

- **Bug fixes** — check open issues
- **New tools** — the server exposes a fixed tool set (see `browser_tools` in `src/server.ts`). Adding a tool follows a pattern: declare schema → handle in `executeTool` → implement in `ChromeManager`
- **Docs** — improve README, fix type docs, add examples
- **Performance** — Lightpanda pool tuning, snapshot generation, memory usage

If you're unsure where to start, look for issues labeled `good first issue`.

## Pull request process

1. Fork the repo
2. Create a branch from `main`
3. Make your changes — keep them focused to one thing
4. Run `npx tsc --noEmit` and `bun test` before pushing
5. Open a PR with a clear description of what changed and why
6. Link any related issue

PRs are reviewed on a best-effort basis. Small, focused PRs are reviewed faster.

PRs that add new tools must include the tool definition in `src/server.ts` and corresponding implementation in `src/chrome.ts` + `src/browser-tools.ts`. Any new env var or CLI flag must be documented in `docs/configs.md`. Keep it consistent with existing code — no new dependencies for things a few lines of code can do.
