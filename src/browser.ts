import puppeteer, { Browser, Page } from 'puppeteer';
import type { Viewport } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserOptions, PageInfo, SnapshotResult, NavigateOptions, ScreenshotOptions } from './types.js';
import { existsSync, chmodSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function installLightpanda(targetPath: string): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  
  let url: string;
  if (platform === 'darwin') {
    url = arch === 'arm64' 
      ? 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos'
      : 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-macos';
  } else if (platform === 'linux') {
    url = 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux';
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  console.log(`Downloading Lightpanda from ${url}...`);
  
  const { spawn: spawnAsync } = await import('child_process');
  const curl = spawnAsync('curl', ['-L', '-o', targetPath, url], { stdio: 'inherit' });
  
  await new Promise<void>((resolve, reject) => {
    curl.on('close', (code) => {
      if (code === 0) {
        chmodSync(targetPath, 0o755);
        console.log('Lightpanda installed successfully.');
        resolve();
      } else {
        reject(new Error(`Failed to download Lightpanda (exit code: ${code})`));
      }
    });
  });
}

class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pageCounter = 0;
  private lightpandaProcess: ChildProcess | null = null;
  private context: any = null;
  private snapshotOptions: { flattenSingleChild: boolean; textTrimLength: number } = {
    flattenSingleChild: process.env.SNAPSHOT_FLATTEN?.toLowerCase() !== 'false',
    textTrimLength: parseInt(process.env.SNAPSHOT_TEXT_TRIM_LENGTH || '200', 10),
  };

  setSnapshotOptions(options: { flattenSingleChild?: boolean; textTrimLength?: number }): void {
    this.snapshotOptions = { ...this.snapshotOptions, ...options };
  }

  async install(): Promise<void> {
    const lightpandaPath = path.join(__dirname, '..', 'lightpanda');
    
    if (!existsSync(lightpandaPath)) {
      await installLightpanda(lightpandaPath);
    }
  }

  async launch(options: BrowserOptions = {}): Promise<void> {
    if (this.browser && this.browser.connected) {
      return;
    }

    await this.close();

    const lightpandaPath = options.lightpandaPath || path.join(__dirname, '..', 'lightpanda');
    
    if (!existsSync(lightpandaPath)) {
      await installLightpanda(lightpandaPath);
    }
    
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

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
    });
    
    this.browser = browser;
    this.context = await browser.createBrowserContext();
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (e) {}
      this.page = null;
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch (e) {}
      this.context = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
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
    
    if (!page || page.isClosed()) {
      throw new Error('Browser page is not available. Please restart the browser.');
    }
    
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

  private idCounter = 0;
  private idToSelector: Map<number, string> = new Map();

  private generateUniqueId(): number {
    return this.idCounter++;
  }

  private generateSelector(element: Element): string {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }
    
    let selector = element.tagName.toLowerCase();
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (el) => el.tagName === element.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    
    return selector;
  }

  private buildYamlTree(element: Element, id: number): any {
    const node: any = {
      id,
      type: element.tagName.toLowerCase(),
    };

    this.idToSelector.set(id, this.generateSelector(element));

    const textContent = element.textContent?.trim() || '';
    if (textContent) {
      const maxLength = 200;
      node.text = textContent.length > maxLength 
        ? textContent.substring(0, maxLength) + '... (trimmed)'
        : textContent;
    }

    const children: any[] = [];
    for (const child of element.children) {
      const childId = this.generateUniqueId();
      const childNode = this.buildYamlTree(child, childId);
      children.push({ [childId]: childNode });
    }

    if (children.length > 0) {
      node.children = children;
    }

    return node;
  }

  private treeToYaml(obj: any, indent: number = 0): string {
    const spaces = '  '.repeat(indent);
    let lines: string[] = [];

    if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        if (!isNaN(Number(key))) {
          lines.push(`${key}:`);
          lines.push(this.treeToYaml(value, indent + 1));
        } else if (key === 'type') {
          lines.push(`${spaces}${key}: ${value}`);
        } else if (key === 'text') {
          const escaped = String(value).replace(/"/g, '\\"');
          lines.push(`${spaces}${key}: "${escaped}"`);
        } else if (key === 'image_alt') {
          const escaped = String(value).replace(/"/g, '\\"');
          lines.push(`${spaces}${key}: "${escaped}"`);
        } else if (key === 'children') {
          lines.push(`${spaces}${key}:`);
          for (const child of value) {
            if (typeof child === 'object' && child !== null) {
              for (const [childId, childObj] of Object.entries(child)) {
                lines.push(`${spaces}  ${childId}:`);
                lines.push(this.treeToYaml(childObj, indent + 2));
              }
            }
          }
        }
      }
    }

    return lines.join('\n');
  }

  async getSnapshot(): Promise<SnapshotResult> {
    const page = this.getPage();
    this.idCounter = 0;
    this.idToSelector.clear();

    const flattenSingleChild = this.snapshotOptions.flattenSingleChild;
    const textTrimLength = this.snapshotOptions.textTrimLength;

    const yamlTree = await page.evaluate((flattenOption, maxLength) => {
      function buildTree(element: Element, idObj: { counter: number }, idToSelector: Map<number, string>, shouldFlatten: boolean, trimLength: number): any {
        const id = idObj.counter++;
        
        const selector = element.id 
          ? `#${element.id}` 
          : element.tagName.toLowerCase();
        idToSelector.set(id, selector);

        const node: any = {
          type: element.tagName.toLowerCase(),
        };

        if (element.tagName.toLowerCase() === 'img') {
          const alt = (element as HTMLImageElement).alt;
          const src = (element as HTMLImageElement).src;
          
          if (alt) {
            node.image_alt = alt;
          } else if (src) {
            const filename = src.split('/').pop()?.split('?')[0] || '';
            if (filename) {
              node.image_alt = filename;
            }
          }
        }

        let textContent = '';
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            textContent += child.textContent;
          }
        }
        textContent = textContent.trim();
        if (textContent) {
          const maxLength = 200;
          node.text = textContent.length > maxLength 
            ? textContent.substring(0, trimLength) + '... (trimmed)'
            : textContent;
        }

        const children: any[] = [];
        for (const child of element.children) {
          if (child.tagName.toLowerCase() === 'br') continue;
          const childNode = buildTree(child, idObj, idToSelector, shouldFlatten, trimLength);
          children.push(childNode);
        }

        if (shouldFlatten && children.length === 1 && !node.text && !node.src) {
          return children[0];
        }

        if (children.length > 0) {
          node.children = children;
        }

        return { [id]: node };
      }

      const idObj = { counter: 0 };
      const idToSelector = new Map<number, string>();
      const root = document.body;
      return buildTree(root, idObj, idToSelector, flattenOption, maxLength);
    }, flattenSingleChild, textTrimLength);

    const yamlOutput = this.treeToYaml(yamlTree);
    
    const selectorMap = await page.evaluate(() => {
      function generateSelector(element: Element): string {
        let selector = element.tagName.toLowerCase();
        
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }
        
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (el) => el.tagName === element.tagName
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(element) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        
        let path = selector;
        let current: Element | null = element.parentElement;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            path = `#${CSS.escape(current.id)} > ${path}`;
            break;
          }
          const parentSiblings = Array.from(current.parentElement?.children || []).filter(
            (el) => el.tagName === current!.tagName
          );
          if (parentSiblings.length > 1) {
            const idx = parentSiblings.indexOf(current) + 1;
            path = `${tag}:nth-of-type(${idx}) > ${path}`;
          } else {
            path = `${tag} > ${path}`;
          }
          current = current.parentElement;
        }
        return path;
      }

      const map: Record<number, string> = {};
      function traverse(element: Element, idObj: { counter: number }, selectors: Map<number, string>): void {
        const id = idObj.counter++;
        selectors.set(id, generateSelector(element));
        for (const child of element.children) {
          traverse(child, idObj, selectors);
        }
      }
      
      traverse(document.body, { counter: 0 }, new Map());
      
      const allElements = document.querySelectorAll('*');
      const idObj = { counter: 0 };
      const selectorMap = new Map<number, string>();
      
      function assignIds(element: Element, counterObj: { value: number }): number {
        const id = counterObj.value++;
        const selector = generateSelector(element);
        selectorMap.set(id, selector);
        for (const child of element.children) {
          assignIds(child, counterObj);
        }
        return id;
      }
      
      assignIds(document.body, idObj);
      
      selectorMap.forEach((value, key) => {
        map[key] = value;
      });
      
      return map;
    });

    const formatExplanation = `## YAML Snapshot Format

Each node contains:
- \`id\`: Unique numeric identifier for the node
- \`type\`: HTML tag name (e.g., div, p, span, button)
- \`text\`: Text content between tags (trimmed to 200 chars, marked with "... (trimmed)" if truncated)
- \`children\`: Child nodes in the same format

The ID to CSS selector mapping is maintained in memory for referencing nodes in subsequent operations.`;

    const fullOutput = `${formatExplanation}\n\n---\n\n${yamlOutput}`;

    return {
      accessibilityTree: fullOutput,
      url: page.url(),
      title: await page.title(),
    };
  }

  async viewNode(nodeId: number): Promise<{ type: 'text' | 'image'; content: string }> {
    const page = this.getPage();
    
    const result = await page.evaluate((id) => {
      function generateSelector(element: Element): string {
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }
        
        let selector = element.tagName.toLowerCase();
        const parent = element.parentElement;
        
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (el) => el.tagName === element.tagName
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(element) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        
        let path = selector;
        let current: Element | null = element.parentElement;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            path = `#${CSS.escape(current.id)} > ${path}`;
            break;
          }
          const parentSiblings = Array.from(current.parentElement?.children || []).filter(
            (el) => el.tagName === current!.tagName
          );
          if (parentSiblings.length > 1) {
            const idx = parentSiblings.indexOf(current) + 1;
            path = `${tag}:nth-of-type(${idx}) > ${path}`;
          } else {
            path = `${tag} > ${path}`;
          }
          current = current.parentElement;
        }
        return path;
      }

      function traverse(element: Element, idObj: { counter: number }, targetId: number): Element | null {
        const currentId = idObj.counter++;
        
        if (currentId === targetId) {
          return element;
        }
        
        for (const child of element.children) {
          const found = traverse(child, idObj, targetId);
          if (found) return found;
        }
        return null;
      }

      const element = traverse(document.body, { counter: 0 }, id);
      
      if (!element) return { type: 'text', text: `Node with ID ${id} not found` };
      
      const tagName = element.tagName.toLowerCase();
      
      if (tagName === 'img') {
        const src = (element as HTMLImageElement).src;
        if (src) {
          return { type: 'image', src };
        }
      }
      
      let textContent = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          textContent += child.textContent;
        }
      }
      textContent = textContent.trim();
      
      if (textContent) {
        return { type: 'text', text: textContent };
      }
      
      return { type: 'text', text: '(no text content)' };
    }, nodeId);

    if (!result) {
      return { type: 'text', content: `Node with ID ${nodeId} not found` };
    }

    if (result.type === 'image') {
      try {
        const buf = await page.screenshot({
          fullPage: false,
          encoding: 'base64'
        });
        return { type: 'image', content: buf as string };
      } catch (e) {
        return { type: 'text', content: `Image: ${result.src}` };
      }
    }

    return { type: 'text', content: result.text };
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    const page = this.getPage();
    
    return await page.evaluate((id) => {
      function generateSelector(element: Element): string {
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }
        
        let selector = element.tagName.toLowerCase();
        const parent = element.parentElement;
        
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (el) => el.tagName === element.tagName
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(element) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        
        let path = selector;
        let current: Element | null = element.parentElement;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            path = `#${CSS.escape(current.id)} > ${path}`;
            break;
          }
          const parentSiblings = Array.from(current.parentElement?.children || []).filter(
            (el) => el.tagName === current!.tagName
          );
          if (parentSiblings.length > 1) {
            const idx = parentSiblings.indexOf(current) + 1;
            path = `${tag}:nth-of-type(${idx}) > ${path}`;
          } else {
            path = `${tag} > ${path}`;
          }
          current = current.parentElement;
        }
        return path;
      }

      function traverse(element: Element, idObj: { counter: number }): Element | null {
        const currentId = idObj.counter++;
        if (currentId === id) return element;
        for (const child of element.children) {
          const found = traverse(child, idObj);
          if (found) return found;
        }
        return null;
      }

      const element = traverse(document.body, { counter: 0 });
      if (!element) return null;
      
      return generateSelector(element);
    }, nodeId);
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
