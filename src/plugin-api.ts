// Public plugin API. This file is the compatibility contract for plugins:
// core tools use the same ToolDefinition shape, but plugins must only rely on
// what is exported here. Grow it deliberately; never break it silently.

import type { ChromeManager } from './chrome.js';
import type { log } from './logger.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/** Handed to a plugin tool handler on every call. One per invocation. */
export interface ToolContext {
  readonly sessionId: string;
  /**
   * Connected ChromeManager for this session. Live getter: after
   * forceFallback() resolves, reading ctx.manager returns the new manager.
   */
  readonly manager: ChromeManager;
  /**
   * Switch this session to the level-2 fallback browser (no-op if already
   * there; recorded history is replayed on the new browser). Throws if
   * FALLBACK_BROWSER=none. Use for capabilities Lightpanda lacks
   * (e.g. Page.printToPDF, accurate layout measurement).
   */
  forceFallback(): Promise<ChromeManager>;
  isOnLightpanda(): boolean;
  hasFallback(): boolean;
  /** 'lightpanda' or the configured fallback type — the same tag core results use. */
  browserTag(): string;
  /** Formats a result identically to core tools (clients parse this shape). */
  textResult(body: string, isError?: boolean): ToolResult;
}

export interface ToolDefinition {
  /** MCP tool name. Must be globally unique across core tools and plugins. */
  name: string;
  description: string;
  /** JSON Schema (type: object) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * The tool accepts a session_id for a session that does not exist yet and
   * creates it (e.g. pipeline tools that manage their own session lifecycle).
   * Default false: the tool requires an existing session.
   */
  canCreateSession?: boolean;
  /** false when the tool can be called without a session_id (browser_navigate). Default true. */
  requiresSessionId?: boolean;
  /** Return a log-safe copy of args (e.g. replace html payloads with a size marker). */
  redactArgsForLog?: (args: Record<string, any>) => Record<string, any>;
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Handed to a plugin's init() at startup. */
export interface PluginContext {
  /** The server logger — same instance core uses. */
  log: typeof log;
}

export interface Plugin {
  /** Unique plugin id, kebab-case (this is what PLUGINS refers to). */
  name: string;
  tools: ToolDefinition[];
  /**
   * Called once at startup, in PLUGINS order (awaited sequentially), before
   * the server serves any request. Throwing aborts startup (exit 1) — use it
   * to fail fast on misconfiguration. No browser resources exist yet.
   */
  init?(ctx: PluginContext): Promise<void> | void;
  /**
   * Called once on graceful shutdown (SIGINT/SIGTERM), after in-flight tool
   * queues are killed and before sessions/browser pools are torn down.
   * Best-effort: errors are logged and shutdown continues.
   */
  shutdown?(): Promise<void> | void;
}
