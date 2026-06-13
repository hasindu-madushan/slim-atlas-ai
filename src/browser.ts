import puppeteer, { Browser, Page } from 'puppeteer';
import type { Viewport } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserOptions, PageInfo, SnapshotResult, NavigateOptions, ScreenshotOptions } from './types.js';
import { existsSync, chmodSync } from 'fs';
import { treeToYaml, SNAPSHOT_FORMAT_EXPLANATION } from './snapshot-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIGHTPANDA_VERSION = process.env.LIGHTPANDA_VERSION || '0.3.1';

async function installLightpanda(targetPath: string): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  
  const repo = 'lightpanda-io/browser';
  const version = LIGHTPANDA_VERSION;
  
  let url: string;
  if (platform === 'darwin') {
    url = arch === 'arm64' 
      ? `https://github.com/${repo}/releases/download/${version}/lightpanda-aarch64-macos`
      : `https://github.com/${repo}/releases/download/${version}/lightpanda-x86_64-macos`;
  } else if (platform === 'linux') {
    url = `https://github.com/${repo}/releases/download/${version}/lightpanda-x86_64-linux`;
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  console.log(`Downloading Lightpanda v${version} from ${url}...`);
  
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
      '--timeout', '86400',
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
      timeout: 300000,
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

  async getSnapshot(): Promise<SnapshotResult> {
    const page = this.getPage();
    this.idCounter = 0;
    this.idToSelector.clear();

    const flattenSingleChild = this.snapshotOptions.flattenSingleChild;
    const textTrimLength = this.snapshotOptions.textTrimLength;

    // Build DOM tree using string-based page.evaluate()
    // Config values are embedded in the string since Puppeteer ignores args for string-based evaluate
    const yamlTree = await page.evaluate(`
      (function() {
        var shouldFlatten = ${JSON.stringify(flattenSingleChild)};
        var trimLength = ${JSON.stringify(textTrimLength)};
        var idObj = { counter: 0 };

        function buildTree(el) {
          var id = idObj.counter++;
          var node = { type: el.tagName.toLowerCase() };
          if (el.tagName.toLowerCase() === 'img') {
            var alt = el.alt;
            var src = el.src;
            if (alt) node.image_alt = alt;
            else if (src) {
              var filename = src.split('/').pop().split('?')[0] || '';
              if (filename) node.image_alt = filename;
            }
          }
          var textContent = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            var child = el.childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) textContent += child.textContent;
          }
          textContent = textContent.trim();
          if (textContent) {
            node.text = textContent.length > trimLength
              ? textContent.substring(0, trimLength) + '... (trimmed)'
              : textContent;
          }
          var children = [];
          for (var j = 0; j < el.children.length; j++) {
            var ch = el.children[j];
            if (ch.tagName.toLowerCase() === 'br') continue;
            children.push(buildTree(ch));
          }
          if (shouldFlatten && children.length === 1 && !node.text && !node.src) return children[0];
          if (children.length > 0) node.children = children;
          var obj = {};
          obj[id] = node;
          return obj;
        }
        return buildTree(document.body);
      })()
    `);

    const yamlOutput = treeToYaml(yamlTree);

    // Build selector map using string-based page.evaluate()
    const selectorMap = await page.evaluate(`
      (function() {
        function gen(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          var s = el.tagName.toLowerCase();
          var p = el.parentElement;
          if (p) {
            var sibs = Array.from(p.children).filter(function(c) { return c.tagName === el.tagName; });
            if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
          }
          var path = s;
          var c = el.parentElement;
          while (c && c !== document.body) {
            var t = c.tagName.toLowerCase();
            if (c.id) { path = '#' + CSS.escape(c.id) + ' > ' + path; break; }
            var ps = Array.from(c.parentElement ? c.parentElement.children : []).filter(function(x) { return x.tagName === c.tagName; });
            if (ps.length > 1) path = t + ':nth-of-type(' + (ps.indexOf(c) + 1) + ') > ' + path;
            else path = t + ' > ' + path;
            c = c.parentElement;
          }
          return path;
        }
        var map = {};
        var local = new Map();
        function assign(el, obj) {
          var id = obj.value++;
          local.set(id, gen(el));
          for (var i = 0; i < el.children.length; i++) assign(el.children[i], obj);
        }
        assign(document.body, { value: 0 });
        local.forEach(function(v, k) { map[k] = v; });
        return map;
      })()
    `) as Record<number, string>;

    for (const [id, selector] of Object.entries(selectorMap)) {
      this.idToSelector.set(Number(id), selector);
    }

    return {
      accessibilityTree: `${SNAPSHOT_FORMAT_EXPLANATION}\n\n---\n\n${yamlOutput}`,
      url: page.url(),
      title: await page.title(),
    };
  }

  async viewNode(nodeId: number): Promise<{ type: 'text' | 'image'; content: string }> {
    const page = this.getPage();
    
    const result = await page.evaluate(`
      function(id) {
        function traverse(el, obj, target) {
          var cid = obj.counter++;
          if (cid === target) return el;
          for (var i = 0; i < el.children.length; i++) { var f = traverse(el.children[i], obj, target); if (f) return f; }
          return null;
        }
        var el = traverse(document.body, { counter: 0 }, id);
        if (!el) return { type: 'text', text: 'Node with ID ' + id + ' not found' };
        if (el.tagName.toLowerCase() === 'img') { var src = el.src; if (src) return { type: 'image', src: src }; }
        var t = '';
        for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === Node.TEXT_NODE) t += c.textContent; }
        t = t.trim();
        return t ? { type: 'text', text: t } : { type: 'text', text: '(no text content)' };
      }
    `, nodeId) as any;

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

    return { type: 'text', content: result.text || '' };
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    const page = this.getPage();
    
    return await page.evaluate(`
      function(id) {
        function gen(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          var s = el.tagName.toLowerCase();
          var p = el.parentElement;
          if (p) {
            var sibs = Array.from(p.children).filter(function(c) { return c.tagName === el.tagName; });
            if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
          }
          var path = s;
          var c = el.parentElement;
          while (c && c !== document.body) {
            var t = c.tagName.toLowerCase();
            if (c.id) { path = '#' + CSS.escape(c.id) + ' > ' + path; break; }
            var ps = Array.from(c.parentElement ? c.parentElement.children : []).filter(function(x) { return x.tagName === c.tagName; });
            if (ps.length > 1) path = t + ':nth-of-type(' + (ps.indexOf(c) + 1) + ') > ' + path;
            else path = t + ' > ' + path;
            c = c.parentElement;
          }
          return path;
        }
        function traverse(el, obj) {
          var cid = obj.counter++;
          if (cid === id) return el;
          for (var i = 0; i < el.children.length; i++) { var f = traverse(el.children[i], obj); if (f) return f; }
          return null;
        }
        var el = traverse(document.body, { counter: 0 });
        return el ? gen(el) : null;
      }
    `, nodeId) as Promise<string | null>;
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
    await page.evaluate(`function(sel) {
      var el = document.querySelector(sel);
      if (el) el.value = '';
    }`, selector);
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
    await page.waitForNavigation({ timeout: options.timeout ?? 300000 });
  }

  async isBrowserConnected(): Promise<boolean> {
    return this.browser !== null && this.browser.connected;
  }
}

export const browserManager = new BrowserManager();

export function isCrashError(error: any): boolean {
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
