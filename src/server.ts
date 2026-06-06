import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { isCrashError } from './browser.js';
import { SessionManager } from './session.js';
import type { ChromeManager } from './chrome.js';

const CHROME_ENABLED = process.env.CHROME_ENABLED !== 'false';

export class PuppeteerMCPServer {
  private server: Server;
  private sessionManager: SessionManager;
  private sessionQueues: Map<string, Promise<void>> = new Map();

  constructor() {
    this.server = new Server(
      { name: 'slimatlas', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.sessionManager = new SessionManager();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'browser_navigate',
            description: 'Navigate to a URL',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The URL to navigate to' },
                waitUntil: {
                  type: 'string',
                  enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
                  description: 'When to consider navigation finished',
                  default: 'networkidle0',
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'browser_snapshot',
            description: 'Get YAML snapshot of the current page DOM tree with unique IDs',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'browser_view_node',
            description: 'View a specific node by ID - shows full text content or image',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'number', description: 'The unique ID of the node to view (from snapshot)' },
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'browser_click',
            description: 'Click on an element. Use nodeId (recommended) from snapshot, or CSS selector as fallback.',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'number', description: 'Unique node ID from snapshot (recommended)' },
                selector: { type: 'string', description: 'CSS selector (use only if nodeId not available)' },
              },
            },
          },
          {
            name: 'browser_type',
            description: 'Type text into an element. Use nodeId (recommended) from snapshot, or CSS selector as fallback.',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'number', description: 'Unique node ID from snapshot (recommended)' },
                selector: { type: 'string', description: 'CSS selector (use only if nodeId not available)' },
                text: { type: 'string', description: 'Text to type' },
                delay: { type: 'number', description: 'Delay between keystrokes in ms', default: 0 },
              },
              required: ['text'],
            },
          },
          {
            name: 'browser_fill',
            description: 'Fill an input element with a value',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector for the input element' },
                value: { type: 'string', description: 'Value to fill' },
              },
              required: ['selector', 'value'],
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
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'browser_go_forward',
            description: 'Navigate forward in history',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'browser_reload',
            description: 'Reload the current page',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'browser_get_page_info',
            description: 'Get information about the current page',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'browser_close',
            description: 'Close the browser session',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments as Record<string, any>;
      const sessionId = args?.session_id || 'default';
      const needsBrowser = toolName !== 'browser_install';

      if (needsBrowser) {
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

      return this.executeTool(sessionId, toolName, args);
    });
  }

  private async executeTool(sessionId: string, toolName: string, args: Record<string, any>): Promise<any> {
    const useChrome = args.use_chrome === true;

    if (!this.sessionManager.has(sessionId)) {
      await this.sessionManager.acquire(sessionId, useChrome || this.sessionManager.shouldPreferChrome(sessionId));
    } else if (useChrome && CHROME_ENABLED && this.sessionManager.getBrowserType(sessionId) !== 'chrome') {
      await this.sessionManager.acquire(sessionId, true);
    }

    let manager = this.sessionManager.getManager(sessionId);
    if (!manager) {
      manager = await this.sessionManager.acquire(sessionId, useChrome);
    }

    try {
      return await this.executeWithManager(sessionId, manager, toolName, args);
    } catch (error: any) {
      if (CHROME_ENABLED && isCrashError(error) && this.sessionManager.getBrowserType(sessionId) === 'lightpanda') {
        console.error(`[session:${sessionId}] Lightpanda crashed on ${toolName}, switching to Chrome...`);
        this.sessionManager.markPreferChrome(sessionId);
        manager = await this.sessionManager.acquire(sessionId, true);
        return this.executeWithManager(sessionId, manager, toolName, args);
      }
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async executeWithManager(sessionId: string, manager: ChromeManager, toolName: string, args: Record<string, any>): Promise<any> {
    const browserType = this.sessionManager.getBrowserType(sessionId) || 'lightpanda';

    switch (toolName) {
      case 'browser_navigate':
        await manager.navigate({ url: args.url, waitUntil: args.waitUntil || 'networkidle0' });
        const info = await manager.getPageInfo();
        return { content: [{ type: 'text', text: `[${browserType}:${sessionId.slice(0, 8)}] Navigated to ${info.url}. Title: ${info.title}` }] };

      case 'browser_snapshot': {
        const snapshot = await manager.getSnapshot();
        return { content: [{ type: 'text', text: snapshot.accessibilityTree }] };
      }

      case 'browser_view_node': {
        const nodeResult = await manager.viewNode(args.nodeId);
        if (nodeResult.type === 'image') return { content: [{ type: 'image', data: nodeResult.content, mimeType: 'image/png' }] };
        return { content: [{ type: 'text', text: nodeResult.content }] };
      }

      case 'browser_click': {
        const sel = args.nodeId !== undefined ? await manager.getSelectorByNodeId(args.nodeId) : args.selector;
        if (!sel) return { content: [{ type: 'text', text: args.nodeId !== undefined ? `Node ID ${args.nodeId} not found` : 'Selector is required' }] };
        await manager.click(sel);
        return { content: [{ type: 'text', text: `Clicked: ${sel}` }] };
      }

      case 'browser_type': {
        const typeSel = args.nodeId !== undefined ? await manager.getSelectorByNodeId(args.nodeId) : args.selector;
        if (!typeSel) return { content: [{ type: 'text', text: args.nodeId !== undefined ? `Node ID ${args.nodeId} not found` : 'Selector is required' }] };
        await manager.type(typeSel, args.text, { delay: args.delay });
        return { content: [{ type: 'text', text: `Typed into: ${typeSel}` }] };
      }

      case 'browser_fill':
        await manager.fill(args.selector, args.value);
        return { content: [{ type: 'text', text: `Filled ${args.selector} with: ${args.value}` }] };

      case 'browser_evaluate': {
        const result = await manager.evaluate(args.script);
        return { content: [{ type: 'text', text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) }] };
      }

      case 'browser_go_back':
        await manager.goBack();
        return { content: [{ type: 'text', text: 'Navigated back' }] };

      case 'browser_go_forward':
        await manager.goForward();
        return { content: [{ type: 'text', text: 'Navigated forward' }] };

      case 'browser_reload':
        await manager.reload();
        return { content: [{ type: 'text', text: 'Page reloaded' }] };

      case 'browser_get_page_info': {
        const page = await manager.getPageInfo();
        return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }] };
      }

      case 'browser_close':
        await this.sessionManager.release(sessionId);
        this.sessionQueues.delete(sessionId);
        return { content: [{ type: 'text', text: `Session ${sessionId.slice(0, 8)} closed` }] };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
