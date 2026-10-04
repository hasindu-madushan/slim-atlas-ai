# Plugins

Plugins add MCP tools to the server without touching core browser machinery. They are **disabled by default** — the server exposes only the core `browser_*` tools unless a plugin is explicitly enabled via config.

- Interface (the compatibility contract): [`src/plugin-api.ts`](../src/plugin-api.ts)
- Registry: [`src/plugins/registry.ts`](../src/plugins/registry.ts)
- Canonical example: [`src/plugins/document-export/`](../src/plugins/document-export/index.ts)

## Enabling plugins

```bash
# env
PLUGINS=document-export

# or CLI flag (overrides env)
bun run src/index.ts --plugins=document-export

# multiple plugins
PLUGINS=plugin-a,plugin-b
```

- Unset, empty, or `none` → **no plugins loaded** (the default).
- Unknown names fail at startup with `Unknown plugin(s): …` and exit code 1 (same behaviour as unknown CLI flags).
- Names are case-insensitive; duplicates are collapsed.
- Tool names must be globally unique — a plugin tool colliding with a core tool (or another plugin's tool) aborts startup.

## What a plugin is

A plugin is a module exporting a `Plugin` object: a unique kebab-case `name`, a list of `tools`, and optional `init`/`shutdown` lifecycle hooks (detailed in [Lifecycle hooks](#lifecycle-hooks)):

```ts
import type { Plugin } from '../plugin-api.js';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  tools: [/* ToolDefinition[] — see below */],
  init: async (ctx) => {
    // Runs once at startup, before requests are served. Throwing exits the server.
    ctx.log.info('my-plugin', 'ready');
  },
  shutdown: async () => {
    // Runs once on graceful shutdown, before browser pools are torn down.
  },
};
```

Each tool is a `ToolDefinition`:

```ts
import type { ToolDefinition } from '../plugin-api.js';

const myTool: ToolDefinition = {
  name: 'browser_my_tool',            // must be unique across core + plugins
  description: 'What it does, and when an agent should (not) use it',
  inputSchema: {                       // JSON Schema, type: object
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
    },
    required: ['session_id'],
  },
  handler: async (args, ctx) => {
    return ctx.textResult('done');
  },
};
```

### Tool metadata flags

| Flag | Default | Meaning |
|------|---------|---------|
| `canCreateSession` | `false` | The tool may be called with a `session_id` that doesn't exist yet; the server creates the session (used by pipeline tools like `browser_print_pdf` that manage their own session lifecycle). When `false`, calls against a non-existent session get an error telling the caller to `browser_navigate` first. |
| `requiresSessionId` | `true` | Set `false` only if the tool works without a `session_id` (core `browser_navigate` auto-generates one). |
| `redactArgsForLog` | – | Optional `(args) => args` returning a log-safe copy. Use it whenever args can contain large or sensitive payloads (HTML documents, templates), so the debug log stays useful. |

## Lifecycle hooks

Both hooks are optional and run at most once per process.

### `init(ctx)` — startup

- **When:** once during `server.init()`, after the `PLUGINS` config is resolved and **before the server accepts any MCP request** (the stdio connect / HTTP listen happen after all inits). Plugins are inited in `PLUGINS` list order, awaited one at a time.
- **Config errors come first:** an unknown plugin name in `PLUGINS` exits the process before any `init` runs.
- **What it gets:** a `PluginContext` — currently `{ log }`, the server logger (same instance core uses).
- **What it's for:** reading/validating plugin config, preflight checks (vendored assets present, required env vars set), capturing the logger into module state for later use by handlers.
- **What it does NOT get:** no browser sessions, pages, or pools — nothing browser-related exists at init time. Don't launch anything here; open resources lazily inside a tool handler (or via `ctx.forceFallback()`).
- **Failure semantics:** a thrown error aborts startup — the message is printed and the process exits(1). Use it to fail fast on misconfiguration.

```ts
// Fail fast on missing config instead of failing on the first tool call.
init: () => {
  if (!process.env.MY_PLUGIN_TOKEN) {
    throw new Error('my-plugin requires MY_PLUGIN_TOKEN to be set');
  }
},
```

### `shutdown()` — graceful teardown

- **When:** once inside `server.shutdown()`, triggered by `SIGINT`/`SIGTERM`. Ordering: after in-flight tool queues are killed, **before** sessions are released and the browser pools are torn down.
- **No arguments:** keep whatever you need (logger, handles) in closure/module state captured during `init`.
- **Failure semantics:** best-effort. A throwing or rejecting `shutdown` is logged (`Plugin <name> shutdown failed: …`) and shutdown continues — one plugin cannot block the process from exiting.
- **What it's for:** releasing resources the plugin itself created (temp files, timers, external service clients). Browser resources need no cleanup here — the server releases sessions and pools itself.

### Timing summary

```
startup:   ensureLightpanda → new PuppeteerMCPServer → server.init()
             └─ resolve PLUGINS → plugins[*].init() (in PLUGINS order, awaited)
             └─ tool registry built → transport starts serving
shutdown:  SIGINT/SIGTERM → server.shutdown()
             └─ session queues killed → plugins[*].shutdown()
             └─ sessions released → lightpanda + fallback pools shut down
```

## The ToolContext

Handlers receive `(args, ctx)`. The context is deliberately narrow — plugins never touch the `SessionManager`, pools, or escalation policy directly.

| Member | What it does |
|--------|--------------|
| `ctx.sessionId` | The session this call runs against. |
| `ctx.manager` | The connected `ChromeManager` for the session. Live getter: after `forceFallback()` resolves it returns the new manager. |
| `ctx.forceFallback()` | Switches the session to the level-2 fallback browser (no-op if already there; recorded history is replayed). Throws if `FALLBACK_BROWSER=none`. Use it when the capability needs a real Chrome engine — Lightpanda's JS engine is incomplete. |
| `ctx.isOnLightpanda()` / `ctx.hasFallback()` | Layer introspection. |
| `ctx.browserTag()` | `'lightpanda'` or the fallback type — include it in result strings like core tools do. |
| `ctx.textResult(body, isError?)` | Formats a result **identically to core tools** (`session_id: <id>` first line, `result: <body>` after). Clients parse this shape — always return results through this helper (or an MCP image block for binary-as-image). |

For the full typed contract, read [`src/plugin-api.ts`](../src/plugin-api.ts) — it is the source of truth and deliberately small.

## A complete example plugin

This plugin exposes a `browser_get_html` tool (core deliberately does not expose one). Create `src/plugins/page-dump/index.ts`:

```ts
import type { Plugin } from '../../plugin-api.js';

const getHtmlTool = {
  name: 'browser_get_html',
  description: 'Return the serialized HTML of the current page.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
    },
    required: ['session_id'],
  },
  handler: async (_args, ctx) => {
    const html = await ctx.manager.getHtml();
    return ctx.textResult(`HTML (${html.length} chars, ${ctx.browserTag()})\n${html}`);
  },
};

export const pageDumpPlugin: Plugin = {
  name: 'page-dump',
  tools: [getHtmlTool],
};
```

Register it in `src/plugins/registry.ts`:

```ts
import { pageDumpPlugin } from './page-dump/index.js';

export const BUILTIN_PLUGINS: Record<string, Plugin> = {
  'document-export': documentExportPlugin,
  'page-dump': pageDumpPlugin,          // ← add this line; the key is what PLUGINS refers to
};
```

Enable and run:

```bash
bun run src/index.ts --plugins=page-dump
```

## Runtime guarantees

Things you get for free as a plugin author:

- **Per-session serialisation.** Plugin tool calls go through the same per-session queue as core tools: calls to one session run strictly sequentially, calls to different sessions run in parallel. Never call another tool's handler from your handler — you'd bypass the queue.
- **Error isolation.** A thrown `Error` becomes an MCP `isError` result (`Error: <message>`) for that call only. The server keeps running.
- **Disconnect recovery.** The server re-connects the session's browser (same layer, history replayed) before your handler runs.
- **Session lifecycle.** Idle cleanup releases abandoned sessions; `browser_close` works the same for plugin-created sessions (`canCreateSession: true`).
- **No bot detection on level 2.** If you `forceFallback()`, whatever the fallback browser returns is trusted — same contract as core.

One thing you do **not** get: page mutations made inside a plugin tool are not recorded in session history, so they are not replayed if the session later reconnects or escalates. If your tool needs a specific page state, load it in the same handler (see how `document-export` does `setContent` right after `forceFallback`).

## Registering & shipping checklist

1. Create `src/plugins/<plugin-name>/index.ts` exporting a `Plugin`.
2. Add it to `BUILTIN_PLUGINS` in `src/plugins/registry.ts` (key = the name used in `PLUGINS`).
3. Add tests — `test/plugins.test.ts` shows the pattern (resolvePlugins behaviour, tool metadata, arg redaction). If your plugin has hooks, call them directly with a stub context (`init({ log: console })`-style) — no server needed.
4. Update `docs/configs.md` if your plugin adds env vars / CLI flags, and mention it here if it ships tools.

## Scope (what is intentionally not supported yet)

- **External / dynamically loaded plugins** (npm packages, a `PLUGINS_DIR`). The interface is module-shaped so an `await import()` loader can be added later without breaking plugins, but today plugins are built-in and compiled with the server.
- **Non-tool contributions** (prompts, resources, MCP capabilities). Tools only.
- **Plugin-scoped configuration schema.** Read `process.env` in `init()` like the rest of the server does if you need config.
