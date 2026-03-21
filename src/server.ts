import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { browserManager } from './browser.js';

export class PuppeteerMCPServer {
  private server: Server;
  private isInitialized = false;

  constructor() {
    this.server = new Server(
      {
        name: 'slimatlas',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

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
                url: {
                  type: 'string',
                  description: 'The URL to navigate to',
                },
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
          // {
          //   name: 'browser_snapshot',
          //   description: 'Get accessibility snapshot of the current page',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {},
          //   },
          // },
          {
            name: 'browser_click',
            description: 'Click on an element',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the element to click',
                },
              },
              required: ['selector'],
            },
          },
          {
            name: 'browser_type',
            description: 'Type text into an element',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the input element',
                },
                text: {
                  type: 'string',
                  description: 'Text to type',
                },
                delay: {
                  type: 'number',
                  description: 'Delay between keystrokes in ms',
                  default: 0,
                },
              },
              required: ['selector', 'text'],
            },
          },
          {
            name: 'browser_fill',
            description: 'Fill an input element with a value',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the input element',
                },
                value: {
                  type: 'string',
                  description: 'Value to fill',
                },
              },
              required: ['selector', 'value'],
            },
          },
          {
            name: 'browser_evaluate',
            description: 'Evaluate JavaScript on the page',
            inputSchema: {
              type: 'object',
              properties: {
                script: {
                  type: 'string',
                  description: 'JavaScript code to evaluate',
                },
              },
              required: ['script'],
            },
          },
          {
            name: 'browser_screenshot',
            description: 'Take a screenshot of the current page',
            inputSchema: {
              type: 'object',
              properties: {
                fullPage: {
                  type: 'boolean',
                  description: 'Capture full page or just viewport',
                  default: false,
                },
                type: {
                  type: 'string',
                  enum: ['png', 'jpeg'],
                  description: 'Image format',
                  default: 'png',
                },
              },
            },
          },
          {
            name: 'browser_get_html',
            description: 'Get the HTML content of the page',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_go_back',
            description: 'Navigate back in history',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_go_forward',
            description: 'Navigate forward in history',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_reload',
            description: 'Reload the current page',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_get_page_info',
            description: 'Get information about the current page',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_close',
            description: 'Close the browser',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'browser_install',
            description: 'Install the browser binaries',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments as Record<string, any>;

      try {
        const needsBrowser = toolName !== 'browser_install';
        
        if (needsBrowser) {
          if (!this.isInitialized || !await browserManager.isBrowserConnected()) {
            await browserManager.close();
            await browserManager.launch({ headless: true });
            this.isInitialized = true;
          }
        }

        switch (toolName) {
          case 'browser_navigate':
            await browserManager.navigate({
              url: args.url,
              waitUntil: args.waitUntil || 'networkidle0',
            });
            const pageInfo = await browserManager.getPageInfo();
            return {
              content: [
                {
                  type: 'text',
                  text: `Navigated to ${pageInfo.url}. Title: ${pageInfo.title}`,
                },
              ],
            };

          case 'browser_snapshot':
            const snapshot = await browserManager.getSnapshot();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(snapshot, null, 2),
                },
              ],
            };

          case 'browser_click':
            await browserManager.click(args.selector);
            return {
              content: [
                {
                  type: 'text',
                  text: `Clicked element: ${args.selector}`,
                },
              ],
            };

          case 'browser_type':
            await browserManager.type(args.selector, args.text, { delay: args.delay });
            return {
              content: [
                {
                  type: 'text',
                  text: `Typed text into ${args.selector}`,
                },
              ],
            };

          case 'browser_fill':
            await browserManager.fill(args.selector, args.value);
            return {
              content: [
                {
                  type: 'text',
                  text: `Filled ${args.selector} with: ${args.value}`,
                },
              ],
            };

          case 'browser_evaluate':
            const result = await browserManager.evaluate(args.script);
            return {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
                },
              ],
            };

          case 'browser_screenshot':
            const screenshot = await browserManager.takeScreenshot({
              fullPage: args.fullPage,
              type: args.type,
            });
            return {
              content: [
                // {
                //   type: 'text',
                //   text: `Screenshot taken (base64, length: ${screenshot.length})`,
                // },
                {
                  type: 'image',
                  data: Buffer.from(screenshot).toString('base64'),
                  mimeType: args.type === 'jpeg' ? 'image/jpeg' : 'image/png',
                  text: ""
                },
              ],
            };

          case 'browser_get_html':
            const html = await browserManager.getHtml();
            return {
              content: [
                {
                  type: 'text',
                  text: html,
                },
              ],
            };

          case 'browser_go_back':
            await browserManager.goBack();
            return {
              content: [
                {
                  type: 'text',
                  text: 'Navigated back',
                },
              ],
            };

          case 'browser_go_forward':
            await browserManager.goForward();
            return {
              content: [
                {
                  type: 'text',
                  text: 'Navigated forward',
                },
              ],
            };

          case 'browser_reload':
            await browserManager.reload();
            return {
              content: [
                {
                  type: 'text',
                  text: 'Page reloaded',
                },
              ],
            };

          case 'browser_get_page_info':
            const info = await browserManager.getPageInfo();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(info, null, 2),
                },
              ],
            };

          case 'browser_close':
            await browserManager.close();
            this.isInitialized = false;
            return {
              content: [
                {
                  type: 'text',
                  text: 'Browser closed',
                },
              ],
            };

          case 'browser_install':
            try {
              await browserManager.install();
              return {
                content: [
                  {
                    text: 'Lightpanda browser installed successfully.',
                  },
                ],
              };
            } catch (error) {
              return {
                content: [
                  {
                    text: `Error installing browser: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }

          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}