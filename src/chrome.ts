import puppeteer, { Browser, Page, BrowserContext } from 'puppeteer';
import type { NavigateOptions, PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';

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
    await page.goto(options.url, { waitUntil: options.waitUntil || 'load', timeout: 30000 });
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

    const yamlTree = await page.evaluate((flattenOption, trimLength) => {
      function buildTree(element: Element, idObj: { counter: number }, shouldFlatten: boolean, trimLen: number): any {
        const id = idObj.counter++;
        const node: any = { type: element.tagName.toLowerCase() };
        if (element.tagName.toLowerCase() === 'img') {
          const alt = (element as HTMLImageElement).alt;
          const src = (element as HTMLImageElement).src;
          if (alt) node.image_alt = alt;
          else if (src) { const f = src.split('/').pop()?.split('?')[0] || ''; if (f) node.image_alt = f; }
        }
        let textContent = '';
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) textContent += child.textContent;
        }
        textContent = textContent.trim();
        if (textContent) node.text = textContent.length > trimLen ? textContent.substring(0, trimLen) + '... (trimmed)' : textContent;
        const children: any[] = [];
        for (const child of element.children) {
          if (child.tagName.toLowerCase() === 'br') continue;
          children.push(buildTree(child, idObj, shouldFlatten, trimLen));
        }
        if (shouldFlatten && children.length === 1 && !node.text && !node.src) return children[0];
        if (children.length > 0) node.children = children;
        return { [id]: node };
      }
      return buildTree(document.body, { counter: 0 }, flattenOption, trimLength);
    }, flattenSingleChild, textTrimLength);

    const yamlOutput = this.treeToYaml(yamlTree);

    const selectorMap = await page.evaluate(() => {
      function gen(el: Element): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        let s = el.tagName.toLowerCase();
        const p = el.parentElement;
        if (p) {
          const sibs = Array.from(p.children).filter(c => c.tagName === el.tagName);
          if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`;
        }
        let path = s, c: Element | null = el.parentElement;
        while (c && c !== document.body) {
          const t = c.tagName.toLowerCase();
          if (c.id) { path = `#${CSS.escape(c.id)} > ${path}`; break; }
          const ps = Array.from(c.parentElement?.children || []).filter(x => x.tagName === c!.tagName);
          if (ps.length > 1) path = `${t}:nth-of-type(${ps.indexOf(c) + 1}) > ${path}`;
          else path = `${t} > ${path}`;
          c = c.parentElement;
        }
        return path;
      }
      const map: Record<number, string> = {};
      const local = new Map<number, string>();
      function assign(el: Element, obj: { value: number }) {
        const id = obj.value++;
        local.set(id, gen(el));
        for (const child of el.children) assign(child, obj);
      }
      assign(document.body, { value: 0 });
      local.forEach((v, k) => { map[k] = v; });
      return map;
    });

    for (const [id, selector] of Object.entries(selectorMap)) {
      this.idToSelector.set(Number(id), selector);
    }

    const formatExplanation = `## YAML Snapshot Format\n\nEach node contains:\n- \`id\`: Unique numeric identifier for the node\n- \`type\`: HTML tag name (e.g., div, p, span, button)\n- \`text\`: Text content between tags (trimmed to 200 chars, marked with "... (trimmed)" if truncated)\n- \`children\`: Child nodes in the same format\n\nThe ID to CSS selector mapping is maintained in memory for referencing nodes in subsequent operations.`;

    return {
      accessibilityTree: `${formatExplanation}\n\n---\n\n${yamlOutput}`,
      url: page.url(),
      title: await page.title(),
    };
  }

  async viewNode(nodeId: number): Promise<{ type: 'text' | 'image'; content: string }> {
    const page = this.getPage();
    const result = await page.evaluate((id) => {
      function traverse(el: Element, obj: { counter: number }, target: number): Element | null {
        const cid = obj.counter++;
        if (cid === target) return el;
        for (const child of el.children) { const f = traverse(child, obj, target); if (f) return f; }
        return null;
      }
      const el = traverse(document.body, { counter: 0 }, id);
      if (!el) return { type: 'text', text: `Node with ID ${id} not found` };
      if (el.tagName.toLowerCase() === 'img') { const src = (el as HTMLImageElement).src; if (src) return { type: 'image', src }; }
      let t = '';
      for (const c of el.childNodes) { if (c.nodeType === Node.TEXT_NODE) t += c.textContent; }
      t = t.trim();
      return t ? { type: 'text', text: t } : { type: 'text', text: '(no text content)' };
    }, nodeId);
    if (result.type === 'image') {
      try { const buf = await page.screenshot({ fullPage: false, encoding: 'base64' }); return { type: 'image', content: buf as string }; }
      catch (e) { return { type: 'text', content: `Image: ${(result as any).src}` }; }
    }
    return { type: 'text', content: result.text || '' };
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    const page = this.getPage();
    return await page.evaluate((id) => {
      function traverse(el: Element, obj: { counter: number }): Element | null {
        const cid = obj.counter++;
        if (cid === id) return el;
        for (const child of el.children) { const f = traverse(child, obj); if (f) return f; }
        return null;
      }
      function gen(el: Element): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        let s = el.tagName.toLowerCase();
        const p = el.parentElement;
        if (p) { const sibs = Array.from(p.children).filter(c => c.tagName === el.tagName); if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`; }
        let path = s, c: Element | null = el.parentElement;
        while (c && c !== document.body) {
          const t = c.tagName.toLowerCase();
          if (c.id) { path = `#${CSS.escape(c.id)} > ${path}`; break; }
          const ps = Array.from(c.parentElement?.children || []).filter(x => x.tagName === c!.tagName);
          if (ps.length > 1) path = `${t}:nth-of-type(${ps.indexOf(c) + 1}) > ${path}`;
          else path = `${t} > ${path}`;
          c = c.parentElement;
        }
        return path;
      }
      const el = traverse(document.body, { counter: 0 });
      return el ? gen(el) : null;
    }, nodeId);
  }

  async click(selector: string): Promise<void> { await this.getPage().click(selector); }
  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> { await this.getPage().type(selector, text, { delay: options.delay ?? 0 }); }
  async fill(selector: string, value: string): Promise<void> {
    const page = this.getPage();
    await page.focus(selector);
    await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLInputElement; if (el) el.value = ''; }, selector);
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

  private treeToYaml(obj: any, indent: number = 0): string {
    const spaces = '  '.repeat(indent);
    const lines: string[] = [];
    if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        if (!isNaN(Number(key))) { lines.push(`${key}:`); lines.push(this.treeToYaml(value, indent + 1)); }
        else if (key === 'type') lines.push(`${spaces}${key}: ${value}`);
        else if (key === 'text' || key === 'image_alt') lines.push(`${spaces}${key}: "${String(value).replace(/"/g, '\\"')}"`);
        else if (key === 'children') {
          lines.push(`${spaces}${key}:`);
          for (const child of (value as any[])) {
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
}

export const chromeManager = new ChromeManager();
