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
import type { ChromeManager } from './chrome.js';
import type { PageInfo } from './types.js';

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

  constructor() {
    this.startCleanupJob();
    if (SKIP_LIGHTPANDA_DOMAINS.length > 0 && !this.sessionManager.hasFallback()) {
      log.warn('server', `SKIP_LIGHTPANDA_DOMAINS set but FALLBACK_BROWSER=none — per-domain skipping is disabled`);
    }
    if (this.rateLimiter.isEnabled()) {
      log.info('server', `Rate limiting enabled`);
    }
    log.info('server', `Initialized (fallback=${this.sessionManager.getFallbackType()}). Log file: ${log.getPath()}`);
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
        tools: [
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
          {
            name: 'browser_print_pdf',
            description: 'Print the current page — or a provided HTML document — to a PDF and return it as base64 (can be multi-megabyte). This tool is for document/report generation pipelines ONLY, and the caller MUST close the session with browser_close when done. Do NOT use it for research, reading, extracting, screenshotting, or archiving web content — use browser_snapshot or browser_view_node instead.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID. Provide a new ID to create a print session; reuse the same ID to print the same page again; close it with browser_close when done.' },
                html: { type: 'string', description: 'Self-contained HTML document to load before printing. Omit to print the current page.' },
                print_background: { type: 'boolean', description: 'Print background graphics', default: true },
                prefer_css_page_size: { type: 'boolean', description: 'Use the CSS @page size over the default paper size', default: false },
                display_header_footer: { type: 'boolean', description: 'Display header/footer templates', default: false },
                header_template: { type: 'string', description: 'HTML template for the page header (Chromium print template; .pageNumber/.totalPages classes available)' },
                footer_template: { type: 'string', description: 'HTML template for the page footer (Chromium print template; .pageNumber/.totalPages classes available)' },
                page_ranges: { type: 'string', description: 'Page ranges to print, e.g. "1" or "2-". Numbering counts all pages of the document.' },
                margin: {
                  type: 'object',
                  description: 'Page margins, e.g. {"top":"20mm","bottom":"16mm","left":"16mm","right":"16mm"}',
                  properties: {
                    top: { type: 'string' },
                    bottom: { type: 'string' },
                    left: { type: 'string' },
                    right: { type: 'string' },
                  },
                },
              },
              required: ['session_id'],
            },
          },
          {
            name: 'browser_export_pptx',
            description: 'Convert the current page — or a provided HTML document — into an editable PowerPoint (.pptx) via dom-to-pptx and return it as base64 (can be multi-megabyte). Slides are the elements matching "selector" (default ".slide"), each laid out at final pixel size (e.g. 1920x1080). This tool is for deck generation pipelines ONLY, and the caller MUST close the session with browser_close when done.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID. Provide a new ID to create an export session; reuse the same ID to export the same page again; close it with browser_close when done.' },
                html: { type: 'string', description: 'Self-contained HTML document to load before conversion. Omit to convert the current page.' },
                selector: { type: 'string', description: 'CSS selector matching the slide elements', default: '.slide' },
                with_previews: { type: 'boolean', description: 'Also return a base64 PNG screenshot of each slide, captured from the rendered page before conversion (for LLM visual QA)', default: false },
              },
              required: ['session_id'],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments as Record<string, any>;

      if (!args.session_id && toolName !== 'browser_navigate') {
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
    try {
      if (!this.sessionManager.has(sessionId)) {
        // browser_print_pdf / browser_export_pptx may create a session with a
        // caller-supplied id (the pipelines generate one up front so they can
        // close it afterwards).
        if (toolName !== 'browser_navigate' && toolName !== 'browser_print_pdf' && toolName !== 'browser_export_pptx') {
          return this.textResult(sessionId, 'Session not found. Call browser_navigate first to create a session.', true);
        }
        await this.sessionManager.acquire(sessionId, typeof args.url === 'string' ? args.url : undefined);
      }

      const manager = await this.sessionManager.ensureConnected(sessionId);
      const result = await this.executeWithManager(sessionId, manager, toolName, args);
      this.sessionManager.touchSession(sessionId);
      log.info(sessionId, `${toolName} completed`);
      return result;
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(sessionId, `${toolName} failed: ${msg}`);
      return this.textResult(sessionId, `Error: ${msg}`, true);
    }
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

  private async executeWithManager(sessionId: string, manager: ChromeManager, toolName: string, args: Record<string, any>): Promise<any> {
    // The print/export pipelines pass a full HTML document plus header/footer
    // templates — never write those to the debug log.
    const logArgs = toolName === 'browser_print_pdf' || toolName === 'browser_export_pptx'
      ? { ...args, html: args.html ? `<${args.html.length} chars>` : undefined, header_template: undefined, footer_template: undefined }
      : args;
    log.debug(sessionId, `${toolName} args: ${JSON.stringify(logArgs)}`);

    switch (toolName) {
      case 'browser_navigate': {
        const url = args.url;
        const waitUntil = args.waitUntil || DEFAULT_WAIT_UNTIL;

        await this.rateLimiter.throttle(sessionId, url);

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
        return this.textResult(sessionId, `[${this.browserTag(sessionId)}] Navigated to ${info.url}. Title: ${info.title}`);
      }

      case 'browser_snapshot': {
        if (this.sessionManager.isOnLightpanda(sessionId)) {
          const check = await this.botDetection.detect(manager.getPage());
          if (check.blocked) {
            if (!this.sessionManager.hasFallback()) {
              return this.textResult(sessionId, `Bot challenge detected (${check.reason}). No fallback configured (FALLBACK_BROWSER=none).`, true);
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
        return this.textResult(sessionId, snapshot.accessibilityTree);
      }

      case 'browser_view_node': {
        const nodeResult = await manager.viewNode(normalizeNodeId(args)!);
        if (nodeResult.type === 'image') return { content: [{ type: 'image', data: nodeResult.content, mimeType: 'image/png' }] };
        return this.textResult(sessionId, nodeResult.content);
      }

      case 'browser_click': {
        const sel = await this.resolveSelector(manager, args);
        if (!sel) return this.textResult(sessionId, this.missingSelectorMsg(args), true);
        await manager.click(sel);
        this.sessionManager.getHistory(sessionId)?.record({ type: 'click', selector: sel });
        return this.textResult(sessionId, `Clicked: ${sel}`);
      }

      case 'browser_type': {
        const sel = await this.resolveSelector(manager, args);
        if (!sel) return this.textResult(sessionId, this.missingSelectorMsg(args), true);
        await manager.type(sel, args.text, { delay: args.delay });
        this.sessionManager.getHistory(sessionId)?.record({ type: 'type', selector: sel, text: args.text, delay: args.delay });
        return this.textResult(sessionId, `Typed into: ${sel}`);
      }

      case 'browser_fill':
        await manager.fill(args.selector, args.value);
        this.sessionManager.getHistory(sessionId)?.record({ type: 'fill', selector: args.selector, value: args.value });
        return this.textResult(sessionId, `Filled ${args.selector} with: ${args.value}`);

      case 'browser_go_back':
        await manager.goBack();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'goBack' });
        return this.textResult(sessionId, 'Navigated back');

      case 'browser_go_forward':
        await manager.goForward();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'goForward' });
        return this.textResult(sessionId, 'Navigated forward');

      case 'browser_reload':
        await manager.reload();
        this.sessionManager.getHistory(sessionId)?.record({ type: 'reload' });
        return this.textResult(sessionId, 'Page reloaded');

      case 'browser_get_page_info': {
        const page = await manager.getPageInfo();
        return this.textResult(sessionId, JSON.stringify(page, null, 2));
      }

      case 'browser_close':
        await this.sessionManager.release(sessionId);
        this.sessionQueues.delete(sessionId);
        return this.textResult(sessionId, `Session ${sessionId} closed`);

      case 'browser_print_pdf': {
        // PDF needs CDP Page.printToPDF, which lightpanda does not implement —
        // force the real-Chrome fallback pool.
        if (this.sessionManager.isOnLightpanda(sessionId)) {
          if (!this.sessionManager.hasFallback()) {
            return this.textResult(sessionId, 'PDF requires a real Chrome fallback (FALLBACK_BROWSER=none)', true);
          }
          manager = await this.sessionManager.switchToFallback(sessionId);
        }
        if (args.html) {
          await manager.setContent(args.html);
        }
        const pdfBase64 = await manager.printPdf({
          printBackground: args.print_background,
          preferCSSPageSize: args.prefer_css_page_size,
          displayHeaderFooter: args.display_header_footer,
          headerTemplate: args.header_template,
          footerTemplate: args.footer_template,
          pageRanges: args.page_ranges,
          margin: args.margin,
        });
        // Base64 goes in a text block (last line): the LangChain mcp-adapter
        // drops non-text content (resource/image blocks) on direct tool.invoke,
        // and the pipeline caller parses the final line as the PDF payload.
        return this.textResult(sessionId, `PDF generated (${Math.round((pdfBase64.length * 3) / 4 / 1024)} KB, ${this.browserTag(sessionId)})\n${pdfBase64}`);
      }

      case 'browser_export_pptx': {
        // dom-to-pptx measures computed layout (getBoundingClientRect per
        // element), which lightpanda's JS engine cannot produce — it yields
        // structurally-valid but EMPTY slides. Force the real-Chrome fallback.
        if (this.sessionManager.isOnLightpanda(sessionId)) {
          if (!this.sessionManager.hasFallback()) {
            return this.textResult(sessionId, 'PPTX export requires a real Chrome fallback (FALLBACK_BROWSER=none)', true);
          }
          manager = await this.sessionManager.switchToFallback(sessionId);
        }
        if (args.html) {
          await manager.setContent(args.html);
        }
        const { base64, slides, previews } = await manager.exportPptx(args.selector ?? '.slide', args.with_previews === true);
        const summary = `PPTX generated (${Math.round((base64.length * 3) / 4 / 1024)} KB, ${slides} slides, ${this.browserTag(sessionId)})`;
        // Without previews the pptx base64 stays the final line (pdf-pipeline
        // contract). With previews, slide PNGs come between markers so callers
        // can split base64 payloads deterministically.
        return this.textResult(sessionId, previews.length > 0
          ? `${summary}\n---previews---\n${previews.join('\n')}\n---pptx---\n${base64}`
          : `${summary}\n${base64}`);
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
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
