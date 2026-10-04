import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import { SessionManager } from './session.js';
import { BotDetectionService } from './bot-detection.js';
import { RateLimiter } from './rate-limit.js';
import { log } from './logger.js';
import { resolvePlugins } from './plugins/registry.js';
import type { ChromeManager } from './chrome.js';
import type { PageInfo } from './types.js';
import type { Plugin, ToolContext, ToolDefinition } from './plugin-api.js';

const DEFAULT_WAIT_UNTIL = process.env.NAVIGATE_WAIT_UNTIL || 'domcontentloaded';
const SKIP_LIGHTPANDA_DOMAINS = (process.env.SKIP_LIGHTPANDA_DOMAINS || '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

const SESSION_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Reddit-style JS challenges redirect while the page is being evaluated, destroying the
// execution context mid-operation. The challenge cookie is already set by then, so a
// retry on the settled page almost always succeeds on the first re-attempt.
function isContextDestroyed(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes('Execution context was destroyed');
}

async function retryOnContextDestroyed<T>(sessionId: string, op: () => Promise<T>, attempts = 2): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (attempts <= 0 || !isContextDestroyed(e)) throw e;
    log.warn(sessionId, 'Execution context destroyed mid-operation (challenge redirect?), retrying after settle');
    await new Promise(r => setTimeout(r, 1500));
    return retryOnContextDestroyed(sessionId, op, attempts - 1);
  }
}

interface ToolTask {
  sessionId: string;
  toolName: string;
  args: Record<string, any>;
}

function generateSessionId(): string {
  let id = '';
  for (let i = 0; i < 4; i++) id += SESSION_ID_CHARS[Math.floor(Math.random() * SESSION_ID_CHARS.length)];
  return id;
}

function shouldSkipLightpanda(url: string): boolean {
  if (SKIP_LIGHTPANDA_DOMAINS.length === 0) return false;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return SKIP_LIGHTPANDA_DOMAINS.some(d => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

function isCrashError(error: any): boolean {
  const msg = errMsg(error);
  return (
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('segfault') ||
    msg.includes('segmentation') ||
    msg.includes('detached') ||
    msg.includes('not connected') ||
    msg.includes('connection closed') ||
    // Lightpanda surfaces proxy-refused tunnels (e.g. providers blocking .gov
    // domains) as CouldntConnect — escalate so the fallback can try the domain.
    msg.includes('couldntconnect')
  );
}

function isTimeoutError(error: any): boolean {
  // 'timedout' also catches Lightpanda's 'OperationTimedout' (no space).
  return errMsg(error).includes('timeout') || errMsg(error).includes('timed out') || errMsg(error).includes('timedout');
}

function isCrashOrTimeout(error: any): boolean {
  return isCrashError(error) || isTimeoutError(error);
}

function errMsg(error: any): string {
  return (error?.message || error || '').toString().toLowerCase();
}

function normalizeNodeId(args: Record<string, any>): number | undefined {
  if (args.nodeId !== undefined) return Number(args.nodeId);
  if (args.node_id !== undefined) return Number(args.node_id);
  return undefined;
}

export class PuppeteerMCPServer {
  private sessionManager: SessionManager = new SessionManager();
  private botDetection: BotDetectionService = new BotDetectionService();
  private rateLimiter: RateLimiter = new RateLimiter();
  private sessionQueues: Map<string, queueAsPromised<ToolTask>> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private httpServer: http.Server | null = null;
  // One MCP Server per HTTP connection: the SDK's Protocol only allows one
  // transport at a time, so sharing a single Server across clients throws
  // "Already connected to a transport" on the second connect. Handlers close
  // over `this` (shared browser sessions), not the Server instance.
  private httpTransports: Map<string, { server: Server; transport: StreamableHTTPServerTransport }> = new Map();
  // Tool registry: core tools plus tools from enabled plugins, keyed by name.
  private tools: Map<string, ToolDefinition> = new Map();
  private plugins: Plugin[] = [];
  private initialized = false;

  constructor() {
    this.startCleanupJob();
    if (SKIP_LIGHTPANDA_DOMAINS.length > 0 && !this.sessionManager.hasFallback()) {
      log.warn('server', `SKIP_LIGHTPANDA_DOMAINS set but FALLBACK_BROWSER=none — per-domain skipping is disabled`);
    }
    if (this.rateLimiter.isEnabled()) {
      log.info('server', `Rate limiting enabled`);
    }
  }

  // Load + init plugins (PLUGINS config) and build the tool registry.
  // Called from run(); idempotent so direct construction stays valid.
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.plugins = resolvePlugins(process.env.PLUGINS);
    for (const plugin of this.plugins) {
      await plugin.init?.({ log });
    }

    const defs = [...this.coreTools(), ...this.plugins.flatMap(p => p.tools)];
    for (const def of defs) {
      if (this.tools.has(def.name)) {
        throw new Error(`Duplicate tool name: ${def.name}`);
      }
      this.tools.set(def.name, def);
    }

    const pluginNames = this.plugins.map(p => p.name).join(', ') || 'none';
    log.info('server', `Initialized (fallback=${this.sessionManager.getFallbackType()}, plugins=${pluginNames}). Log file: ${log.getPath()}`);
  }

  private createServer(): Server {
    const server = new Server(
      { name: 'slimatlas', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [...this.tools.values()].map(def => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments as Record<string, any>;

      const def = this.tools.get(toolName);
      if (!def) {
        return this.textResult('', `Unknown tool: ${toolName}`, true);
      }

      if (!args.session_id && def.requiresSessionId !== false) {
        return this.textResult('', `session_id is required for ${toolName}`, true);
      }

      if (!args.session_id) {
        let sessionId = generateSessionId();
        while (this.sessionManager.has(sessionId)) sessionId = generateSessionId();
        args.session_id = sessionId;
      }

      const sessionId = args.session_id;
      return this.getQueue(sessionId).push({ sessionId, toolName, args });
    });
  }

  private getQueue(sessionId: string): queueAsPromised<ToolTask> {
    let q = this.sessionQueues.get(sessionId);
    if (!q) {
      q = fastq.promise(async (task: ToolTask) => {
        return this.executeTool(task.sessionId, task.toolName, task.args);
      }, 1);
      this.sessionQueues.set(sessionId, q);
    }
    return q;
  }

  private async executeTool(sessionId: string, toolName: string, args: Record<string, any>): Promise<any> {
    log.info(sessionId, `Executing ${toolName}`);
    // Unknown tools are rejected by the CallTool handler before queueing.
    const def = this.tools.get(toolName)!;
    try {
      if (!this.sessionManager.has(sessionId)) {
        if (!def.canCreateSession) {
          return this.textResult(sessionId, 'Session not found. Call browser_navigate first to create a session.', true);
        }
        await this.sessionManager.acquire(sessionId, typeof args.url === 'string' ? args.url : undefined);
      }

      await this.sessionManager.ensureConnected(sessionId);
      const logArgs = def.redactArgsForLog ? def.redactArgsForLog(args) : args;
      log.debug(sessionId, `${toolName} args: ${JSON.stringify(logArgs)}`);

      const result = await def.handler(args, this.makeToolContext(sessionId));
      this.sessionManager.touchSession(sessionId);
      log.info(sessionId, `${toolName} completed`);
      return result;
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(sessionId, `${toolName} failed: ${msg}`);
      return this.textResult(sessionId, `Error: ${msg}`, true);
    }
  }

  // The plugin-facing context. Narrow on purpose: plugins get the session's
  // manager plus layer control, never the SessionManager itself.
  private makeToolContext(sessionId: string): ToolContext {
    const sm = this.sessionManager;
    return {
      sessionId,
      get manager(): ChromeManager {
        const m = sm.getManager(sessionId);
        if (!m) throw new Error(`Session ${sessionId} not found`);
        return m;
      },
      forceFallback: async () => {
        if (!sm.isOnLightpanda(sessionId)) return sm.getManager(sessionId)!;
        if (!sm.hasFallback()) {
          throw new Error('this tool requires a real Chrome fallback but FALLBACK_BROWSER=none');
        }
        return sm.switchToFallback(sessionId);
      },
      isOnLightpanda: () => sm.isOnLightpanda(sessionId),
      hasFallback: () => sm.hasFallback(),
      browserTag: () => this.browserTag(sessionId),
      textResult: (body, isError) => this.textResult(sessionId, body, isError),
    };
  }

  private browserTag(sessionId: string): string {
    return this.sessionManager.isOnLightpanda(sessionId) ? 'lightpanda' : this.sessionManager.getFallbackType();
  }

  // Navigate on the current manager; escalate to the fallback pool exactly once
  // when Lightpanda crashes/times out or the page is bot-detected. Level 2 is
  // trusted: no detection, no further escalation.
  private async navigateOn(
    sessionId: string,
    manager: ChromeManager,
    url: string,
    waitUntil: string,
  ): Promise<ChromeManager> {
    let current = manager;
    try {
      await current.navigate({ url, waitUntil: waitUntil as any });
    } catch (navError: any) {
      if (!this.sessionManager.isOnLightpanda(sessionId) || !isCrashOrTimeout(navError) || !this.sessionManager.hasFallback()) {
        throw navError;
      }
      log.warn(sessionId, `Lightpanda navigate failed (${errMsg(navError)}), escalating to ${this.sessionManager.getFallbackType()}`);
      current = await this.sessionManager.switchToFallback(sessionId);
      await current.navigate({ url, waitUntil: waitUntil as any });
      return current;
    }

    if (this.sessionManager.isOnLightpanda(sessionId)) {
      const check = await this.botDetection.detect(current.getPage());
      if (check.blocked) {
        if (!this.sessionManager.hasFallback()) {
          throw new Error(`Bot challenge detected (${check.reason}). No fallback configured (FALLBACK_BROWSER=none).`);
        }
        log.warn(sessionId, `Bot challenge on lightpanda (${check.reason}), escalating to ${this.sessionManager.getFallbackType()}`);
        current = await this.sessionManager.switchToFallback(sessionId);
        await current.navigate({ url, waitUntil: waitUntil as any });
      }
    }
    return current;
  }

  // Core browser tools. Same ToolDefinition shape plugins use; handlers close
  // over `this` for the internals plugins don't get (rate limiting, bot
  // detection, escalation policy, history).
  private coreTools(): ToolDefinition[] {
    return [
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL. Provide session_id to reuse an existing session, or omit to create a new one.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to navigate to' },
            session_id: { type: 'string', description: 'Session ID. Omit to create a new session.' },
            waitUntil: {
              type: 'string',
              enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
              description: 'When to consider navigation finished',
              default: 'domcontentloaded',
            },
          },
          required: ['url'],
        },
        requiresSessionId: false,
        canCreateSession: true,
        handler: async (args, ctx) => {
          const sessionId = ctx.sessionId;
          const url = args.url;
          const waitUntil = args.waitUntil || DEFAULT_WAIT_UNTIL;

          await this.rateLimiter.throttle(sessionId, url);

          let manager = ctx.manager;
          if (this.sessionManager.isOnLightpanda(sessionId) && this.sessionManager.hasFallback() && shouldSkipLightpanda(url)) {
            log.info(sessionId, `Skip-lightpanda domain (${new URL(url).hostname}), starting on fallback (${this.sessionManager.getFallbackType()})`);
            manager = await this.sessionManager.switchToFallback(sessionId);
          }

          manager = await retryOnContextDestroyed(sessionId, () => this.navigateOn(sessionId, manager, url, waitUntil));
          this.sessionManager.getHistory(sessionId)?.record({ type: 'navigate', url, waitUntil });

          let info: PageInfo;
          try {
            info = await retryOnContextDestroyed(sessionId, () => manager.getPageInfo());
          } catch (e: any) {
            if (this.sessionManager.isOnLightpanda(sessionId) && isTimeoutError(e) && this.sessionManager.hasFallback()) {
              log.warn(sessionId, `getPageInfo timed out on lightpanda, escalating to ${this.sessionManager.getFallbackType()}`);
              manager = await this.sessionManager.switchToFallback(sessionId);
              await manager.navigate({ url, waitUntil: waitUntil as any });
              info = await manager.getPageInfo();
            } else {
              throw e;
            }
          }

          await this.sessionManager.logResourceUsage();
          return ctx.textResult(`[${this.browserTag(sessionId)}] Navigated to ${info.url}. Title: ${info.title}`);
        },
      },
      {
        name: 'browser_snapshot',
        description: 'Get a semantic snapshot of the current page. Each line: `- type "text" #id` where #N is the node id. **Link URLs are omitted by default to save tokens.** To get a link\'s URL, prefer `browser_view_node` with the link\'s numeric ID — it returns the absolute URL for a single link. Only set `show_urls=true` when you need URLs for many links at once and have already decided the extra tokens are worth it. Long values end "... (trimmed)" — use `browser_view_node` to get the full text. Empty structural wrappers are omitted. To interact with a node, use the numeric ID (the number after #) with the `nodeId` parameter of `browser_click`, `browser_type`, or `browser_view_node`. Do not pass #N or selector "#N".',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
            show_urls: { type: 'boolean', default: false, description: 'When true, include absolute URLs inline as `#id@url` for every link in the snapshot. Default false (URLs omitted to save tokens). Prefer `browser_view_node` for one-off URL lookups; only enable this when you need URLs for many links in the same snapshot.' },
          },
          required: ['session_id'],
        },
        handler: async (args, ctx) => {
          const sessionId = ctx.sessionId;
          let manager = ctx.manager;
          if (this.sessionManager.isOnLightpanda(sessionId)) {
            const check = await this.botDetection.detect(manager.getPage());
            if (check.blocked) {
              if (!this.sessionManager.hasFallback()) {
                return ctx.textResult(`Bot challenge detected (${check.reason}). No fallback configured (FALLBACK_BROWSER=none).`, true);
              }
              log.warn(sessionId, `Bot challenge on lightpanda during snapshot (${check.reason}), escalating (history replayed)`);
              manager = await this.sessionManager.switchToFallback(sessionId);
            }
          }
          let snapshot = await retryOnContextDestroyed(sessionId, () => manager.getSnapshot(args.show_urls === true));
          // A tiny tree means the page was caught mid-redirect (e.g. a challenge's second
          // hop still settling) — wait longer and take the snapshot again. Genuinely small
          // pages just snapshot twice; the second result is returned either way.
          const nodeLineCount = () => snapshot.accessibilityTree.split('\n').filter(l => /^\s*-\s/.test(l)).length;
          if (nodeLineCount() < 40) {
            log.warn(sessionId, `Sparse snapshot (${nodeLineCount()} nodes, mid-redirect?), retrying after settle`);
            await new Promise(r => setTimeout(r, 3500));
            snapshot = await retryOnContextDestroyed(sessionId, () => manager.getSnapshot(args.show_urls === true));
          }
          return ctx.textResult(snapshot.accessibilityTree);
        },
      },
      {
        name: 'browser_view_node',
        description: 'View a node by id from a snapshot. Returns the full text content, the full untrimmed URL for link nodes, or the image.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
            nodeId: { type: 'number', description: 'The unique ID of the node to view (from snapshot)' },
          },
          required: ['session_id', 'nodeId'],
        },
        handler: async (args, ctx) => {
          const nodeResult = await ctx.manager.viewNode(normalizeNodeId(args)!);
          if (nodeResult.type === 'image') return { content: [{ type: 'image', data: nodeResult.content, mimeType: 'image/png' }] };
          return ctx.textResult(nodeResult.content);
        },
      },
      {
        name: 'browser_click',
        description: 'Click on an element. Recommended: pass nodeId with the numeric ID from the snapshot (the number after #). Fallback: pass a valid CSS selector in selector.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
            nodeId: { type: 'number', description: 'Numeric node ID from the snapshot (the number shown after #)' },
            selector: { type: 'string', description: 'CSS selector fallback when nodeId is not provided' },
          },
          required: ['session_id'],
        },
        handler: async (args, ctx) => {
          const sel = await this.resolveSelector(ctx.manager, args);
          if (!sel) return ctx.textResult(this.missingSelectorMsg(args), true);
          await ctx.manager.click(sel);
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'click', selector: sel });
          return ctx.textResult(`Clicked: ${sel}`);
        },
      },
      {
        name: 'browser_type',
        description: 'Type text into an element. Recommended: pass nodeId with the numeric ID from the snapshot (the number after #). Fallback: pass a valid CSS selector in selector.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
            nodeId: { type: 'number', description: 'Numeric node ID from the snapshot (the number shown after #)' },
            selector: { type: 'string', description: 'CSS selector fallback when nodeId is not provided' },
            text: { type: 'string', description: 'Text to type' },
            delay: { type: 'number', description: 'Delay between keystrokes in ms', default: 0 },
          },
          required: ['session_id', 'text'],
        },
        handler: async (args, ctx) => {
          const sel = await this.resolveSelector(ctx.manager, args);
          if (!sel) return ctx.textResult(this.missingSelectorMsg(args), true);
          await ctx.manager.type(sel, args.text, { delay: args.delay });
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'type', selector: sel, text: args.text, delay: args.delay });
          return ctx.textResult(`Typed into: ${sel}`);
        },
      },
      {
        name: 'browser_fill',
        description: 'Fill an input element with a value',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
            selector: { type: 'string', description: 'CSS selector for the input element' },
            value: { type: 'string', description: 'Value to fill' },
          },
          required: ['session_id', 'selector', 'value'],
        },
        handler: async (args, ctx) => {
          await ctx.manager.fill(args.selector, args.value);
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'fill', selector: args.selector, value: args.value });
          return ctx.textResult(`Filled ${args.selector} with: ${args.value}`);
        },
      },
      {
        name: 'browser_go_back',
        description: 'Navigate back in history',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
          },
          required: ['session_id'],
        },
        handler: async (_args, ctx) => {
          await ctx.manager.goBack();
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'goBack' });
          return ctx.textResult('Navigated back');
        },
      },
      {
        name: 'browser_go_forward',
        description: 'Navigate forward in history',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
          },
          required: ['session_id'],
        },
        handler: async (_args, ctx) => {
          await ctx.manager.goForward();
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'goForward' });
          return ctx.textResult('Navigated forward');
        },
      },
      {
        name: 'browser_reload',
        description: 'Reload the current page',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
          },
          required: ['session_id'],
        },
        handler: async (_args, ctx) => {
          await ctx.manager.reload();
          this.sessionManager.getHistory(ctx.sessionId)?.record({ type: 'reload' });
          return ctx.textResult('Page reloaded');
        },
      },
      {
        name: 'browser_get_page_info',
        description: 'Get information about the current page',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
          },
          required: ['session_id'],
        },
        handler: async (_args, ctx) => {
          const page = await ctx.manager.getPageInfo();
          return ctx.textResult(JSON.stringify(page, null, 2));
        },
      },
      {
        name: 'browser_close',
        description: 'Close the browser session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to close' },
          },
        },
        handler: async (_args, ctx) => {
          await this.sessionManager.release(ctx.sessionId);
          this.sessionQueues.delete(ctx.sessionId);
          return ctx.textResult(`Session ${ctx.sessionId} closed`);
        },
      },
    ];
  }

  private async resolveSelector(manager: ChromeManager, args: Record<string, any>): Promise<string | null> {
    const nodeId = normalizeNodeId(args);
    if (nodeId !== undefined) return manager.getSelectorByNodeId(nodeId);
    if (args.selector && /^\d+$/.test(String(args.selector))) return manager.getSelectorByNodeId(Number(args.selector));
    return args.selector ?? null;
  }

  private missingSelectorMsg(args: Record<string, any>): string {
    const nodeId = normalizeNodeId(args);
    return nodeId !== undefined ? `Node ID ${nodeId} not found` : 'Provide nodeId or selector';
  }

  private textResult(sessionId: string, body: string, isError = false): any {
    const prefix = sessionId ? `session_id: ${sessionId}\n` : '';
    return {
      content: [{ type: 'text', text: `${prefix}result: ${body}` }],
      isError,
    };
  }

  private startCleanupJob(): void {
    const intervalMs = parseInt(process.env.CLEANUP_INTERVAL_MS || '600000', 10);
    const idleTimeoutMs = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '300000', 10);

    log.info('cleanup', `Starting cleanup job (interval=${intervalMs}ms, idleTimeout=${idleTimeoutMs}ms)`);

    this.cleanupTimer = setInterval(async () => {
      try {
        const idleIds = this.sessionManager.getIdleSessionIds(idleTimeoutMs);
        for (const sessionId of idleIds) {
          log.info(sessionId, `Session idle >${idleTimeoutMs}ms, releasing`);
          await this.sessionManager.release(sessionId);
          this.sessionQueues.delete(sessionId);
        }

        await this.sessionManager.purgeOrphanedInstances(this.sessionManager.getActiveSessionIds());

        if (idleIds.length > 0) {
          log.info('cleanup', `Cleaned ${idleIds.length} idle session(s)`);
        }

        await this.sessionManager.logResourceUsage();
      } catch (e) {
        log.error('cleanup', `Cleanup job error: ${(e as Error).message}`);
      }
    }, intervalMs);

    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private stopCleanupJob(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopCleanupJob();
    for (const q of this.sessionQueues.values()) q.kill();
    this.sessionQueues.clear();
    for (const plugin of this.plugins) {
      try { await plugin.shutdown?.(); } catch (e) {
        log.error('server', `Plugin ${plugin.name} shutdown failed: ${(e as Error).message}`);
      }
    }
    await this.sessionManager.shutdown();
    if (this.httpServer) {
      for (const entry of this.httpTransports.values()) {
        try { await entry.transport.close(); } catch { /* ponytail: best-effort on shutdown */ }
      }
      this.httpTransports.clear();
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  async run(): Promise<void> {
    await this.init();
    const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();
    if (transport === 'http') {
      await this.runHttp();
      return;
    }
    const stdio = new StdioServerTransport();
    await this.createServer().connect(stdio);
    log.info('server', 'MCP server connected via stdio transport');
  }

  private async runHttp(): Promise<void> {
    const host = process.env.MCP_HOST ?? '127.0.0.1';
    const port = parseInt(process.env.MCP_PORT ?? '3000', 10);
    const authToken = process.env.MCP_AUTH_TOKEN;

    this.httpServer = http.createServer(async (req, res) => {
      try {
        if (authToken) {
          const sent = req.headers['authorization'] ?? '';
          // Hash both sides: fixed-length digests let timingSafeEqual compare
          // without leaking length or matching-prefix info.
          const a = createHash('sha256').update(sent).digest();
          const b = createHash('sha256').update(`Bearer ${authToken}`).digest();
          if (!timingSafeEqual(a, b)) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }

        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname !== '/mcp') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const existing = sessionId ? this.httpTransports.get(sessionId) : undefined;

        if (req.method === 'DELETE') {
          if (!existing || !sessionId) { res.writeHead(404); res.end(); return; }
          await existing.transport.close();
          this.httpTransports.delete(sessionId);
          log.info('server', `HTTP session ${sessionId} deleted`);
          res.writeHead(204); res.end();
          return;
        }

        let parsedBody: unknown;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          parsedBody = raw ? JSON.parse(raw) : undefined;
        }

        if (existing) {
          await existing.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'initialize via POST first' }));
          return;
        }

        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.httpTransports.set(id, { server, transport: newTransport });
            log.info('server', `HTTP session ${id} initialized`);
          },
          onsessionclosed: (id) => {
            this.httpTransports.delete(id);
            log.info('server', `HTTP session ${id} closed`);
          },
        });
        newTransport.onerror = (err) => {
          log.error('server', `HTTP transport error: ${err.message}`);
        };
        const server = this.createServer();
        await server.connect(newTransport);
        await newTransport.handleRequest(req, res, parsedBody);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('server', `HTTP request failed: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      }
    });

    this.httpServer.listen(port, host, () => {
      log.info('server', `MCP server listening on http://${host}:${port}/mcp`);
      if (!authToken) log.warn('server', 'HTTP transport has no MCP_AUTH_TOKEN — open access');
    });
  }
}
