import puppeteer, { Browser, Page, Viewport } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserOptions, PageInfo, SnapshotResult, NavigateOptions, ScreenshotOptions } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pageCounter = 0;
  private lightpandaProcess: ChildProcess | null = null;

  async launch(options: BrowserOptions = {}): Promise<void> {
    if (this.browser) {
      return;
    }

    const lightpandaPath = options.lightpandaPath || path.join(__dirname, '..', 'lightpanda');
    const port = options.port || 9222;
    const wsEndpoint = `ws://127.0.0.1:${port}`;

    this.lightpandaProcess = spawn(lightpandaPath, [
      'serve',
      '--obey_robots',
      '--log_level', 'warn',
      '--host', '127.0.0.1',
      '--port', port.toString(),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      ignoreHTTPSErrors: true,
    });
    
    this.browser = browser;
    const context = await browser.createBrowserContext();
    this.page = await context.newPage();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    if (this.lightpandaProcess) {
      this.lightpandaProcess.kill();
      this.lightpandaProcess = null;
    }
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Browser not launched. Call launch() first.');
    }
    return this.page;
  }

  async navigate(options: NavigateOptions): Promise<void> {
    const page = this.getPage();
    await page.goto(options.url, {
      waitUntil: 'load',
      timeout: 30000,
    });
  }

  async getPageInfo(): Promise<PageInfo> {
    const page = this.getPage();
    const url = page.url();
    const title = await page.title();
    const id = `page-${this.pageCounter++}`;
    return { id, url, title };
  }

  async getSnapshot(): Promise<SnapshotResult> {
    const page = this.getPage();
    const accessibilityTree = await page.evaluate(() => {
      function serializeNode(node: any): any {
        if (node.nodeType === Node.TEXT_NODE) {
          return { type: 'text', value: node.textContent };
        }
        
        const result: any = {
          role: node.role || 'unknown',
          name: node.name || '',
        };

        if (node.value !== undefined && node.value !== null) {
          result.value = node.value;
        }

        if (node.checked !== undefined) {
          result.checked = node.checked;
        }

        const children: any[] = [];
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = serializeNode(node.childNodes[i]);
          if (child) {
            children.push(child);
          }
        }
        if (children.length > 0) {
          result.children = children;
        }

        return result;
      }

      const body = document.body;
      return JSON.stringify(serializeNode(body), null, 2);
    });

    return {
      accessibilityTree,
      url: page.url(),
      title: await page.title(),
    };
  }

  async click(selector: string): Promise<void> {
    const page = this.getPage();
    await page.click(selector);
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    const page = this.getPage();
    await page.type(selector, text, { delay: options.delay ?? 0 });
  }

  async fill(selector: string, value: string): Promise<void> {
    const page = this.getPage();
    await page.focus(selector);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      if (el) {
        el.value = '';
      }
    }, selector);
    await page.type(selector, value);
  }

  async evaluate(script: string): Promise<any> {
    const page = this.getPage();
    return await page.evaluate(script);
  }

  async takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
    const page = this.getPage();
    const screenshotOptions: any = {
      type: options.type ?? 'png',
    };

    if (options.fullPage) {
      screenshotOptions.fullPage = true;
    }

    if (options.quality && options.type === 'jpeg') {
      screenshotOptions.quality = options.quality;
    }

    return await page.screenshot(screenshotOptions) as string;
  }

  async getHtml(): Promise<string> {
    const page = this.getPage();
    return await page.content();
  }

  async goBack(): Promise<void> {
    const page = this.getPage();
    await page.goBack();
  }

  async goForward(): Promise<void> {
    const page = this.getPage();
    await page.goForward();
  }

  async reload(): Promise<void> {
    const page = this.getPage();
    await page.reload();
  }

  async waitForSelector(selector: string, options: { timeout?: number } = {}): Promise<void> {
    const page = this.getPage();
    await page.waitForSelector(selector, { timeout: options.timeout ?? 30000 });
  }

  async waitForNavigation(options: { timeout?: number } = {}): Promise<void> {
    const page = this.getPage();
    await page.waitForNavigation({ timeout: options.timeout ?? 30000 });
  }

  async isBrowserConnected(): Promise<boolean> {
    return this.browser !== null && this.browser.connected;
  }
}

export const browserManager = new BrowserManager();
