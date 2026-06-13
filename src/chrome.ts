import puppeteer, { Browser, Page, BrowserContext } from 'puppeteer';
import type { NavigateOptions, PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';
import { treeToYaml, SNAPSHOT_FORMAT_EXPLANATION } from './snapshot-utils.js';

const CHROME_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
];

export class ChromeManager {
  private browser: Browser | null = null;
  private ownedBrowser = false;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pageCounter = 0;
  private idCounter = 0;
  private idToSelector: Map<number, string> = new Map();
  private snapshotOptions: { flattenSingleChild: boolean; textTrimLength: number } = {
    flattenSingleChild: process.env.SNAPSHOT_FLATTEN?.toLowerCase() !== 'false',
    textTrimLength: parseInt(process.env.SNAPSHOT_TEXT_TRIM_LENGTH || '200', 10),
  };

  constructor(options?: { browser?: Browser; context?: BrowserContext; page?: Page }) {
    if (options?.browser) this.browser = options.browser;
    if (options?.context) this.context = options.context;
    if (options?.page) this.page = options.page;
  }

  setSnapshotOptions(options: { flattenSingleChild?: boolean; textTrimLength?: number }): void {
    this.snapshotOptions = { ...this.snapshotOptions, ...options };
  }

  async launch(): Promise<void> {
    if (this.browser && this.browser.connected) return;
    await this.close();

    this.browser = await puppeteer.launch({ headless: true as any, args: CHROME_LAUNCH_ARGS });
    this.ownedBrowser = true;
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.page) { try { await this.page.close(); } catch (e) {} this.page = null; }
    if (this.context) { try { await this.context.close(); } catch (e) {} this.context = null; }
    if (this.ownedBrowser && this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.ownedBrowser = false;
    }
  }

  isConnected(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  getPage(): Page {
    if (!this.page) throw new Error('Chrome browser not launched. Call launch() first.');
    return this.page;
  }

  async navigate(options: NavigateOptions): Promise<void> {
    const page = this.getPage();
    await page.goto(options.url, { waitUntil: options.waitUntil || 'load', timeout: 300000 });
  }

  async getPageInfo(): Promise<PageInfo> {
    const page = this.getPage();
    return { id: `chrome-page-${this.pageCounter++}`, url: page.url(), title: await page.title() };
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
      (function(id) {
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
      })
    `, nodeId) as any;
    if (result.type === 'image') {
      try { const buf = await page.screenshot({ fullPage: false, encoding: 'base64' }); return { type: 'image', content: buf as string }; }
      catch (e) { return { type: 'text', content: `Image: ${(result as any).src}` }; }
    }
    return { type: 'text', content: result.text || '' };
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    const page = this.getPage();
    return await page.evaluate(`
      (function(id) {
        function traverse(el, obj) {
          var cid = obj.counter++;
          if (cid === id) return el;
          for (var i = 0; i < el.children.length; i++) { var f = traverse(el.children[i], obj); if (f) return f; }
          return null;
        }
        function gen(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          var s = el.tagName.toLowerCase();
          var p = el.parentElement;
          if (p) { var sibs = Array.from(p.children).filter(function(c) { return c.tagName === el.tagName; }); if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')'; }
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
        var el = traverse(document.body, { counter: 0 });
        return el ? gen(el) : null;
      })
    `, nodeId) as Promise<string | null>;
  }

  async click(selector: string): Promise<void> { await this.getPage().click(selector); }
  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> { await this.getPage().type(selector, text, { delay: options.delay ?? 0 }); }
  async fill(selector: string, value: string): Promise<void> {
    const page = this.getPage();
    await page.focus(selector);
    await page.evaluate(`(function(sel) { var el = document.querySelector(sel); if (el) el.value = ''; })`, selector);
    await page.type(selector, value);
  }
  async evaluate(script: string): Promise<any> { return await this.getPage().evaluate(script); }
  async takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
    const opts: any = { type: options.type ?? 'png' };
    if (options.fullPage) opts.fullPage = true;
    if (options.quality && options.type === 'jpeg') opts.quality = options.quality;
    return await this.getPage().screenshot(opts) as string;
  }
  async getHtml(): Promise<string> { return await this.getPage().content(); }
  async goBack(): Promise<void> { await this.getPage().goBack(); }
  async goForward(): Promise<void> { await this.getPage().goForward(); }
  async reload(): Promise<void> { await this.getPage().reload(); }

}

export const chromeManager = new ChromeManager();
