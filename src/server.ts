import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from './session.js';
import { log } from './logger.js';
import type { ChromeManager } from './chrome.js';
import type { PageInfo } from './types.js';

const CHROME_ENABLED = process.env.CHROME_ENABLED !== 'false';
const DEFAULT_WAIT_UNTIL = process.env.NAVIGATE_WAIT_UNTIL || 'domcontentloaded';

const SESSION_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateSessionId(): string {
  let id = '';
  for (let i = 0; i < 4; i++) id += SESSION_ID_CHARS[Math.floor(Math.random() * SESSION_ID_CHARS.length)];
  return id;
}

function isCrashError(error: any): boolean {
  const msg = (error?.message || error || '').toLowerCase();
  return (
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('segfault') ||
    msg.includes('segmentation') ||
    msg.includes('detached') ||
    msg.includes('not connected') ||
    msg.includes('connection closed')
  );
}

function normalizeNodeId(args: Record<string, any>): number | undefined {
  if (args.nodeId !== undefined) return Number(args.nodeId);
  if (args.node_id !== undefined) return Number(args.node_id);
  return undefined;
}

export class PuppeteerMCPServer {
  private server: Server;
  private sessionManager: SessionManager;
  private sessionQueues: Map<string, Promise<void>> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.server = new Server(
      { name: 'slimatlas', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.sessionManager = new SessionManager();
    this.setupHandlers();
    this.startCleanupJob();
    log.info('server', `Initialized. Log file: ${log.getPath()}`);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'browser_navigate',
            description: 'Navigate to a URL. Provide session_id to reuse an existing session, or omit to create a new one. Set use_chrome=true to force Chrome (better for bot detection evasion).',
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
                use_chrome: { type: 'boolean', description: 'Force Chrome instead of Lightpanda. Recommended for sites with bot detection (Cloudflare, CAPTCHA).', default: false },
              },
              required: ['url'],
            },
          },
          {
            name: 'browser_snapshot',
            description: 'Get a semantic snapshot of the current page. Each line: `- type "text" #id@url` where #N is the node id and @URL is the link\'s absolute href. Long values end "... (trimmed)" — use browser_view_node to get the full content. Empty structural wrappers are omitted. Use ids with browser_click, browser_type, browser_view_node.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
              },
              required: ['session_id'],
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
          },
          {
            name: 'browser_click',
            description: 'Click on an element. Use nodeId (recommended) from snapshot, or CSS selector as fallback.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
                selector: { type: 'string', description: 'Node ID (from snapshot) or CSS selector' },
                nodeId: { type: 'number', description: 'Unique node ID from snapshot (recommended, overrides selector if both provided)' },
              },
              required: ['session_id', 'selector'],
            },
          },
          {
            name: 'browser_type',
            description: 'Type text into an element. Use nodeId (recommended) from snapshot, or CSS selector as fallback.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID from a previous browser_navigate call' },
                selector: { type: 'string', description: 'Node ID (from snapshot) or CSS selector' },
                nodeId: { type: 'number', description: 'Unique node ID from snapshot (recommended, overrides selector if both provided)' },
                text: { type: 'string', description: 'Text to type' },
                delay: { type: 'number', description: 'Delay between keystrokes in ms', default: 0 },
              },
              required: ['session_id', 'selector', 'text'],
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
          },
          // {
          //   name: 'browser_evaluate',
          //   description: 'Evaluate JavaScript on the page',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       script: { type: 'string', description: 'JavaScript code to evaluate' },
          //     },
          //     required: ['script'],
          //   },
          // },
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
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments as Record<string, any>;
      const needsBrowser = toolName !== 'browser_install';

      if (needsBrowser) {
        if (!args.session_id && toolName !== 'browser_navigate') {
          return {
            content: [{ type: 'text', text: `session_id: ERROR\nresult: session_id is required for ${toolName}` }],
            isError: true,
          };
        }

        if (!args.session_id) {
          let sessionId = generateSessionId();
          while (this.sessionManager.has(sessionId)) {
            sessionId = generateSessionId();
          }
          args.session_id = sessionId;
        }

        const sessionId = args.session_id;

        return new Promise((resolve) => {
          const prev = this.sessionQueues.get(sessionId) || Promise.resolve();
          const next = prev.then(async () => {
            const result = await this.executeTool(sessionId, toolName, args);
            resolve(result);
          }).catch(async (err) => {
            console.error(`[session:${sessionId}] Queue error:`, err.message);
            await this.sessionManager.release(sessionId).catch(() => {});
            this.sessionQueues.delete(sessionId);
            const result = await this.executeTool(sessionId, toolName, args);
            resolve(result);
          });
          this.sessionQueues.set(sessionId, next);
        });
      }

      return this.executeTool('default', toolName, args);
    });
  }

  private async executeTool(sessionId: string, toolName: string, args: Record<string, any>): Promise<any> {
    const useChrome = args.use_chrome === true;
    log.info(sessionId, `Executing ${toolName}`);

    if (!this.sessionManager.has(sessionId)) {
      log.info(sessionId, `New session, acquiring browser (chrome=${useChrome})`);
      await this.sessionManager.acquire(sessionId, useChrome || this.sessionManager.shouldPreferChrome(sessionId));
    } else if (useChrome && CHROME_ENABLED && this.sessionManager.getBrowserType(sessionId) !== 'chrome') {
      log.info(sessionId, `Switching to Chrome`);
      await this.sessionManager.acquire(sessionId, true);
    }

    let manager = this.sessionManager.getManager(sessionId);
    if (!manager) {
      manager = await this.sessionManager.acquire(sessionId, useChrome);
    }

    try {
      const result = await this.executeWithManager(sessionId, manager, toolName, args);
      log.info(sessionId, `${toolName} completed`);
      this.sessionManager.touchSession(sessionId);
      return result;
    } catch (error: any) {
      if (CHROME_ENABLED && isCrashError(error) && this.sessionManager.getBrowserType(sessionId) === 'lightpanda') {
        log.warn(sessionId, `Lightpanda crashed on ${toolName}, switching to Chrome`);
        this.sessionManager.markPreferChrome(sessionId);
        manager = await this.sessionManager.acquire(sessionId, true);
        const result = await this.executeWithManager(sessionId, manager, toolName, args);
        log.info(sessionId, `${toolName} completed (after Chrome fallback)`);
        this.sessionManager.touchSession(sessionId);
        return result;
      }
      log.error(sessionId, `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async executeWithManager(sessionId: string, manager: ChromeManager, toolName: string, args: Record<string, any>): Promise<any> {
    const browserType = this.sessionManager.getBrowserType(sessionId) || 'lightpanda';
    const prefix = `session_id: ${sessionId}`;
    log.debug(sessionId, `${toolName} args: ${JSON.stringify(args)}`);

    switch (toolName) {
      case 'browser_navigate': {
        try {
          await manager.navigate({ url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });
        } catch (navError: any) {
          const msg = (navError?.message || '').toLowerCase();
          if ((msg.includes('timeout') || msg.includes('timed out')) && browserType === 'lightpanda' && CHROME_ENABLED) {
            log.warn(sessionId, `Navigation timeout on Lightpanda, switching to Chrome`);
            this.sessionManager.markPreferChrome(sessionId);
            manager = await this.sessionManager.acquire(sessionId, true);
            await manager.navigate({ url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });
          } else {
            throw navError;
          }
        }

        if (browserType === 'lightpanda' && CHROME_ENABLED && !args.use_chrome) {
          try {
            const isBlocked = await this.checkBotDetection(manager);

            if (isBlocked) {
              log.warn(sessionId, `Bot detection triggered on Lightpanda, switching to Chrome`);
              this.sessionManager.markPreferChrome(sessionId);
              manager = await this.sessionManager.acquire(sessionId, true);
              await manager.navigate({ url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });
            }
          } catch (detectError: any) {
            const detectMsg = (detectError?.message || '').toLowerCase();
            if ((detectMsg.includes('timeout') || detectMsg.includes('timed out')) && CHROME_ENABLED) {
              log.warn(sessionId, `Bot detection timed out on Lightpanda, switching to Chrome`);
              this.sessionManager.markPreferChrome(sessionId);
              manager = await this.sessionManager.acquire(sessionId, true);
              await manager.navigate({ url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });
            }
          }
        }

        this.sessionManager.getHistory(sessionId)?.record({ type: 'navigate', url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });

        let info: PageInfo;
        try {
          info = await manager.getPageInfo();
        } catch (infoError: any) {
          const infoMsg = (infoError?.message || '').toLowerCase();
          if ((infoMsg.includes('timeout') || infoMsg.includes('timed out')) && browserType === 'lightpanda' && CHROME_ENABLED) {
            log.warn(sessionId, `getPageInfo timed out on Lightpanda, switching to Chrome`);
            this.sessionManager.markPreferChrome(sessionId);
            manager = await this.sessionManager.acquire(sessionId, true);
            await manager.navigate({ url: args.url, waitUntil: args.waitUntil || DEFAULT_WAIT_UNTIL });
            info = await manager.getPageInfo();
          } else {
            throw infoError;
          }
        }

        await this.sessionManager.logResourceUsage();
        return { content: [{ type: 'text', text: `${prefix}\nresult: [${this.sessionManager.getBrowserType(sessionId)}] Navigated to ${info.url}. Title: ${info.title}` }] };
      }

      case 'browser_snapshot': {
        const snapshot = await manager.getSnapshot();
        return { content: [{ type: 'text', text: `${prefix}\nresult: ${snapshot.accessibilityTree}` }] };
      }

      case 'browser_view_node': {
        const viewNodeId = normalizeNodeId(args);
        const nodeResult = await manager.viewNode(viewNodeId!);
        if (nodeResult.type === 'image') return { content: [{ type: 'image', data: nodeResult.content, mimeType: 'image/png' }] };
        return { content: [{ type: 'text', text: `${prefix}\nresult: ${nodeResult.content}` }] };
      }

      case 'browser_click': {
        const clickNodeId = normalizeNodeId(args);
        let sel: string | null;
        if (clickNodeId !== undefined) {
          sel = await manager.getSelectorByNodeId(clickNodeId);
        } else if (args.selector && /^\d+$/.test(String(args.selector))) {
          sel = await manager.getSelectorByNodeId(Number(args.selector));
        } else {
          sel = args.selector ?? null;
        }
        if (!sel) return { content: [{ type: 'text', text: `${prefix}\nresult: ${clickNodeId !== undefined ? `Node ID ${clickNodeId} not found` : 'Selector is required'}` }] };
        await manager.click(sel);
        this.sessionManager.getHistory(sessionId)?.record({ type: 'click', selector: sel });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Clicked: ${sel}` }] };
      }

      case 'browser_type': {
        const typeNodeId = normalizeNodeId(args);
        let typeSel: string | null;
        if (typeNodeId !== undefined) {
          typeSel = await manager.getSelectorByNodeId(typeNodeId);
        } else if (args.selector && /^\d+$/.test(String(args.selector))) {
          typeSel = await manager.getSelectorByNodeId(Number(args.selector));
        } else {
          typeSel = args.selector ?? null;
        }
        if (!typeSel) return { content: [{ type: 'text', text: `${prefix}\nresult: ${typeNodeId !== undefined ? `Node ID ${typeNodeId} not found` : 'Selector is required'}` }] };
        await manager.type(typeSel, args.text, { delay: args.delay });
        this.sessionManager.getHistory(sessionId)?.record({ type: 'type', selector: typeSel, text: args.text, delay: args.delay });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Typed into: ${typeSel}` }] };
      }

      case 'browser_fill':
        await manager.fill(args.selector, args.value);
        this.sessionManager.getHistory(sessionId)?.record({ type: 'fill', selector: args.selector, value: args.value });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Filled ${args.selector} with: ${args.value}` }] };

      case 'browser_evaluate': {
        const result = await manager.evaluate(args.script);
        return { content: [{ type: 'text', text: `${prefix}\nresult: ${typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)}` }] };
      }

      case 'browser_go_back':
        await manager.goBack();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'goBack' });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Navigated back` }] };

      case 'browser_go_forward':
        await manager.goForward();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'goForward' });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Navigated forward` }] };

      case 'browser_reload':
        await manager.reload();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'reload' });
        return { content: [{ type: 'text', text: `${prefix}\nresult: Page reloaded` }] };

      case 'browser_get_page_info': {
        const page = await manager.getPageInfo();
        return { content: [{ type: 'text', text: `${prefix}\nresult: ${JSON.stringify(page, null, 2)}` }] };
      }

      case 'browser_close':
        await this.sessionManager.release(sessionId);
        this.sessionQueues.delete(sessionId);
        return { content: [{ type: 'text', text: `${prefix}\nresult: Session ${sessionId} closed` }] };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
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

        const activeIds = this.sessionManager.getActiveSessionIds();
        await this.sessionManager.purgeOrphanedInstances(activeIds);

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

  private async checkBotDetection(manager: ChromeManager): Promise<boolean> {
    try {
      const page = manager.getPage();
      const client = await page.createCDPSession();
      const { root } = await client.send('DOM.getDocument' as any) as { root: { nodeId: number } };
      const { outerHTML } = await client.send('DOM.getOuterHTML' as any, { nodeId: root.nodeId }) as { outerHTML: string };
      await client.detach();
      const html = outerHTML.toLowerCase();
      return (
        html.includes('cf-ray') ||
        html.includes('cf-chl-bypass') ||
        html.includes('challenge-platform') ||
        html.includes('cdn-cgi/challenge-platform') ||
        html.includes('checking your browser') ||
        html.includes('ddos protection') ||
        html.includes('access denied') ||
        html.includes('captcha')
      );
    } catch {
      return true;
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log.info('server', 'MCP server connected via stdio transport');
  }
}
