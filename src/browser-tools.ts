import type { Page } from 'puppeteer';
import type { PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';
import { treeToYaml, SNAPSHOT_FORMAT_EXPLANATION } from './snapshot-utils.js';

export interface ViewNodeResult {
  type: 'text' | 'image';
  content: string;
}

export interface BrowserToolsState {
  idToSelector: Map<number, string>;
}

export class BrowserTools {
  private idCounter = 0;
  private idToSelector: Map<number, string> = new Map();
  private pageCounter = 0;

  constructor(
    private page: Page,
    private snapshotOptions: { flattenSingleChild: boolean; textTrimLength: number }
  ) {}

  getState(): BrowserToolsState {
    return { idToSelector: new Map(this.idToSelector) };
  }

  setState(state: BrowserToolsState): void {
    this.idToSelector = new Map(state.idToSelector);
  }

  async getPageInfo(): Promise<PageInfo> {
    return {
      id: `page-${this.pageCounter++}`,
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  async getSnapshot(): Promise<SnapshotResult> {
    this.idCounter = 0;
    this.idToSelector.clear();

    const flattenSingleChild = this.snapshotOptions.flattenSingleChild;
    const textTrimLength = this.snapshotOptions.textTrimLength;

    // Build DOM tree using string-based page.evaluate()
    // Config values are embedded in the string since Puppeteer ignores args for string-based evaluate
    const yamlTree = await this.page.evaluate(`
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
    const selectorMap = await this.page.evaluate(`
      (function() {
        var shouldFlatten = ${JSON.stringify(flattenSingleChild)};
        if (!document.body) return {};
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
        function getText(el) {
          var t = '';
          for (var i = 0; i < el.childNodes.length; i++) { var ch = el.childNodes[i]; if (ch.nodeType === Node.TEXT_NODE) t += ch.textContent; }
          return t.trim();
        }
        function getValidChildren(el) {
          var ch = [];
          for (var i = 0; i < el.children.length; i++) { if (el.children[i].tagName.toLowerCase() !== 'br') ch.push(el.children[i]); }
          return ch;
        }
        var map = {};
        var local = new Map();
        function assign(el, obj) {
          var id = obj.value++;
          var validChildren = getValidChildren(el);
          if (shouldFlatten && validChildren.length === 1 && !getText(el) && !el.src) {
            assign(validChildren[0], obj);
            return;
          }
          local.set(id, gen(el));
          for (var i = 0; i < validChildren.length; i++) assign(validChildren[i], obj);
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
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  async viewNode(nodeId: number): Promise<ViewNodeResult> {
    const shouldFlatten = this.snapshotOptions.flattenSingleChild;
    const result = await this.page.evaluate(`
      (function() {
        var id = ${JSON.stringify(nodeId)};
        var shouldFlatten = ${JSON.stringify(shouldFlatten)};
        if (!document.body) return { type: 'text', text: 'Node with ID ' + id + ' not found' };
        function getText(el) {
          var t = '';
          for (var i = 0; i < el.childNodes.length; i++) { var ch = el.childNodes[i]; if (ch.nodeType === Node.TEXT_NODE) t += ch.textContent; }
          return t.trim();
        }
        function getValidChildren(el) {
          var ch = [];
          for (var i = 0; i < el.children.length; i++) { if (el.children[i].tagName.toLowerCase() !== 'br') ch.push(el.children[i]); }
          return ch;
        }
        function traverse(el, obj, target) {
          var cid = obj.counter++;
          var validChildren = getValidChildren(el);
          if (shouldFlatten && validChildren.length === 1 && !getText(el) && !el.src) {
            if (cid === target) return el;
            return traverse(validChildren[0], obj, target);
          }
          if (cid === target) return el;
          for (var i = 0; i < validChildren.length; i++) { var f = traverse(validChildren[i], obj, target); if (f) return f; }
          return null;
        }
        var el = traverse(document.body, { counter: 0 }, id);
        if (!el) return { type: 'text', text: 'Node with ID ' + id + ' not found' };
        if (el.tagName.toLowerCase() === 'img') { var src = el.src; if (src) return { type: 'image', src: src }; }
        var t = '';
        for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === Node.TEXT_NODE) t += c.textContent; }
        t = t.trim();
        return t ? { type: 'text', text: t } : { type: 'text', text: '(no text content)' };
      })()
    `) as any;

    if (result.type === 'image') {
      try {
        const buf = await this.page.screenshot({ fullPage: false, encoding: 'base64' });
        return { type: 'image', content: buf as string };
      } catch (e) {
        return { type: 'text', content: `Image: ${(result as any).src}` };
      }
    }

    return { type: 'text', content: result.text || '' };
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    const cached = this.idToSelector.get(nodeId);
    if (cached) return cached;

    const shouldFlatten = this.snapshotOptions.flattenSingleChild;
    return await this.page.evaluate(`
      (function() {
        var id = ${JSON.stringify(nodeId)};
        var shouldFlatten = ${JSON.stringify(shouldFlatten)};
        if (!document.body) return null;
        function getText(el) {
          var t = '';
          for (var i = 0; i < el.childNodes.length; i++) { var ch = el.childNodes[i]; if (ch.nodeType === Node.TEXT_NODE) t += ch.textContent; }
          return t.trim();
        }
        function getValidChildren(el) {
          var ch = [];
          for (var i = 0; i < el.children.length; i++) { if (el.children[i].tagName.toLowerCase() !== 'br') ch.push(el.children[i]); }
          return ch;
        }
        function traverse(el, obj) {
          var cid = obj.counter++;
          var validChildren = getValidChildren(el);
          if (shouldFlatten && validChildren.length === 1 && !getText(el) && !el.src) {
            if (cid === id) return el;
            return traverse(validChildren[0], obj);
          }
          if (cid === id) return el;
          for (var i = 0; i < validChildren.length; i++) { var f = traverse(validChildren[i], obj); if (f) return f; }
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
      })()
    `) as Promise<string | null>;
  }

  async click(selector: string): Promise<void> {
    try {
      await this.page.click(selector);
    } catch (err: any) {
      if (err.message?.includes('not clickable') || err.message?.includes('not an Element')) {
        const clicked = await this.page.evaluate(`(function() {
          var sel = ${JSON.stringify(selector)};
          var el = document.querySelector(sel);
          if (!el) return 'not_found';
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          if (el.click) { el.click(); return 'clicked'; }
          return 'no_click_method';
        })()`);
        if (clicked === 'not_found') throw new Error(`Element not found: ${selector}`);
        if (clicked === 'no_click_method') throw new Error(`Element has no click method: ${selector}`);
        return;
      }
      throw err;
    }
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    await this.page.type(selector, text, { delay: options.delay ?? 0 });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.focus(selector);
    await this.page.evaluate(`(function() { var sel = ${JSON.stringify(selector)}; var el = document.querySelector(sel); if (el) el.value = ''; })()`);
    await this.page.type(selector, value);
  }

  async evaluate(script: string): Promise<any> {
    return await this.page.evaluate(script);
  }

  async takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
    const opts: any = { type: options.type ?? 'png' };
    if (options.fullPage) opts.fullPage = true;
    if (options.quality && options.type === 'jpeg') opts.quality = options.quality;
    return await this.page.screenshot(opts) as string;
  }

  async getHtml(): Promise<string> {
    return await this.page.content();
  }

  async goBack(): Promise<void> {
    await this.page.goBack();
  }

  async goForward(): Promise<void> {
    await this.page.goForward();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }
}
