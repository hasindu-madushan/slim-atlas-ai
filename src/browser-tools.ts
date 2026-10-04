import type { Page } from 'puppeteer';
import type { PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';
import { treeToString, SNAPSHOT_FORMAT_EXPLANATION, SKIP_TAGS, ELEMENT_TYPE_MAP, INPUT_TYPE_MAP, INTERACTABLE_TAGS, INTERACTIVE_ROLES } from './snapshot-utils.js';
import { isHumanDelaysEnabled, getRandomTypingDelay, getRandomClickDelay } from './stealth.js';

export interface ViewNodeResult {
  type: 'text' | 'image';
  content: string;
}

export interface BrowserToolsState {
  idToSelector: Map<number, string>;
  idToUrl: Map<number, string>;
}

const SKIP_TAGS_JS = JSON.stringify([...SKIP_TAGS]);
const ELEMENT_TYPE_MAP_JS = JSON.stringify(ELEMENT_TYPE_MAP);
const INPUT_TYPE_MAP_JS = JSON.stringify(INPUT_TYPE_MAP);
const INTERACTABLE_TAGS_JS = JSON.stringify([...INTERACTABLE_TAGS]);
const INTERACTIVE_ROLES_JS = JSON.stringify(INTERACTIVE_ROLES);

export class BrowserTools {
  private idToSelector: Map<number, string> = new Map();
  private idToUrl: Map<number, string> = new Map();
  private pageCounter = 0;

  constructor(
    private page: Page,
    private snapshotOptions: { flattenSingleChild: boolean; textTrimLength: number }
  ) {}

  getState(): BrowserToolsState {
    return { idToSelector: new Map(this.idToSelector), idToUrl: new Map(this.idToUrl) };
  }

  setState(state: BrowserToolsState): void {
    this.idToSelector = new Map(state.idToSelector);
    this.idToUrl = new Map(state.idToUrl || []);
  }

  async getPageInfo(): Promise<PageInfo> {
    return {
      id: `page-${this.pageCounter++}`,
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  async getSnapshot(showUrls?: boolean): Promise<SnapshotResult> {
    this.idToSelector.clear();
    this.idToUrl.clear();

    const textTrimLength = this.snapshotOptions.textTrimLength;

    const result = await this.page.evaluate(`
      (function() {
        var trimLength = ${JSON.stringify(textTrimLength)};
        var SKIP_TAGS = new Set(${SKIP_TAGS_JS});
        var ELEMENT_TYPE_MAP = ${ELEMENT_TYPE_MAP_JS};
        var INPUT_TYPE_MAP = ${INPUT_TYPE_MAP_JS};
        var INTERACTABLE_TAGS = new Set(${INTERACTABLE_TAGS_JS});
        var INTERACTIVE_ROLES = ${INTERACTIVE_ROLES_JS};

        var selectorMap = {};
        var urlMap = {};
        var idObj = { counter: 0 };

        function normalizeText(text) {
          if (!text) return '';
          return text.replace(/\\s+/g, ' ').trim();
        }

        function getDirectText(el) {
          var text = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3) text += el.childNodes[i].textContent;
          }
          return normalizeText(text);
        }

        function trimText(text, len) {
          if (!text || text.length <= len) return '';
          return text.substring(0, len) + '... (trimmed)';
        }

        function isInteractable(el) {
          var tag = el.tagName.toLowerCase();
          if (tag === 'a' && !el.hasAttribute('href')) return false;
          if (INTERACTABLE_TAGS.has(tag)) return true;
          var role = el.getAttribute('role');
          if (role && INTERACTIVE_ROLES[role]) return true;
          if (el.hasAttribute('tabindex')) return true;
          if (el.getAttribute('contenteditable') === 'true') return true;
          return false;
        }

        function getSemanticType(el) {
          var tag = el.tagName.toLowerCase();
          if (tag === 'input') {
            var itype = (el.type || 'text').toLowerCase();
            return INPUT_TYPE_MAP[itype] || 'textbox';
          }
          return ELEMENT_TYPE_MAP[tag] || null;
        }

        function getInputLabel(el) {
          var al = el.getAttribute('aria-label');
          if (al && al.trim()) return al.trim();
          if (el.labels && el.labels.length > 0) {
            var lt = el.labels[0].textContent;
            if (lt && lt.trim()) return lt.trim();
          }
          var ph = el.getAttribute('placeholder');
          if (ph && ph.trim()) return ph.trim();
          var tt = el.getAttribute('title');
          if (tt && tt.trim()) return tt.trim();
          return '';
        }

        function genSelector(el) {
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

        function mergeConsecutiveTexts(nodes, parentEl) {
          if (!nodes || nodes.length <= 1) return nodes;
          var merged = [];
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (node.type === 'text' && !node.children && node.id === undefined && merged.length > 0) {
              var prev = merged[merged.length - 1];
              if (prev.type === 'text' && !prev.children && prev.id === undefined) {
                var combined = (prev.text || '') + ' ' + (node.text || '');
                var trimmed = trimText(combined, trimLength);
                prev.text = trimmed || combined;
                if (trimmed) {
                  prev.id = idObj.counter++;
                  selectorMap[prev.id] = genSelector(parentEl);
                }
                continue;
              }
            }
            merged.push(node);
          }
          return merged;
        }

        function processChildren(el, currentElement) {
          var results = [];
          for (var i = 0; i < el.childNodes.length; i++) {
            var child = el.childNodes[i];
            if (child.nodeType === 3) {
              var text = normalizeText(child.textContent);
              if (text) {
                var trimmed = trimText(text, trimLength);
                var textNode = { type: 'text', text: trimmed || text };
                if (trimmed) {
                  textNode.id = idObj.counter++;
                  selectorMap[textNode.id] = genSelector(currentElement);
                }
                results.push(textNode);
              }
            } else if (child.nodeType === 1 && child.tagName.toLowerCase() !== 'br') {
              var result = buildTree(child);
              if (result) results = results.concat(result);
            }
          }
          return results.length > 0 ? mergeConsecutiveTexts(results, currentElement) : null;
        }

        function buildTree(el) {
          var tag = el.tagName.toLowerCase();
          if (tag === 'input' && el.type === 'hidden') return null;
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return null;

          if (SKIP_TAGS.has(tag)) return processChildren(el, el);

          var semanticType = getSemanticType(el);
          if (!semanticType) return processChildren(el, el);

          var node = { type: semanticType };

          if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            var label = getInputLabel(el);
            if (label) node.text = label;
          }

          if (tag === 'a') {
            var href = el.getAttribute('href');
            if (href) {
              var absoluteUrl;
              try {
                absoluteUrl = new URL(href, document.baseURI).href;
              } catch (e) {
                absoluteUrl = href;
              }
              urlMap[idObj.counter] = absoluteUrl;
              var urlTrimmed = trimText(absoluteUrl, trimLength);
              node.url = urlTrimmed || absoluteUrl;
              if (urlTrimmed) node.urlTrimmed = true;
            }
            var linkText = '';
            var al = el.getAttribute('aria-label');
            if (al && normalizeText(al)) linkText = normalizeText(al);
            if (!linkText) {
              var tt = el.getAttribute('title');
              if (tt && normalizeText(tt)) linkText = normalizeText(tt);
            }
            if (!linkText) {
              var heading = el.querySelector('h1, h2, h3, h4, h5, h6');
              if (heading) linkText = normalizeText(heading.textContent);
            }
            if (!linkText) {
              var headlineEl = el.querySelector('[class*="eadline" i], [class*="itle" i], [class*="abel" i]');
              if (headlineEl) linkText = normalizeText(headlineEl.textContent);
            }
            if (!linkText) {
              for (var ci = 0; ci < el.childNodes.length; ci++) {
                var c = el.childNodes[ci];
                if (c.nodeType === 3) {
                  var dt = normalizeText(c.textContent);
                  if (dt) { linkText = dt; break; }
                } else if (c.nodeType === 1) {
                  var ct = normalizeText(c.textContent);
                  if (ct) { linkText = ct; break; }
                }
              }
            }
            if (!linkText) linkText = normalizeText(el.textContent);
            if (linkText) {
              var linkTrimmed = trimText(linkText, trimLength);
              node.text = linkTrimmed || linkText;
              if (!node.id) {
                node.id = idObj.counter++;
                selectorMap[node.id] = genSelector(el);
              }
              return [node];
            }
          }

          var hasElementChildren = false;
          for (var i = 0; i < el.children.length; i++) {
            if (el.children[i].tagName.toLowerCase() !== 'br') {
              hasElementChildren = true;
              break;
            }
          }

          if (!hasElementChildren) {
            var directText = getDirectText(el);
            var trimmedText = trimText(directText, trimLength);
            var isTrimmed = !!trimmedText;

            if (directText && !node.text) node.text = trimmedText || directText;

            if (isInteractable(el) || isTrimmed) {
              node.id = idObj.counter++;
              selectorMap[node.id] = genSelector(el);
            }

            if (!node.text && node.id === undefined) return null;

            return [node];
          }

          if (isInteractable(el)) {
            node.id = idObj.counter++;
            selectorMap[node.id] = genSelector(el);
          }

          var children = [];
          for (var i = 0; i < el.childNodes.length; i++) {
            var child = el.childNodes[i];
            if (child.nodeType === 3) {
              var text = normalizeText(child.textContent);
              if (text) {
                var trimmed = trimText(text, trimLength);
                var textNode = { type: 'text', text: trimmed || text };
                if (trimmed) {
                  textNode.id = idObj.counter++;
                  selectorMap[textNode.id] = genSelector(el);
                }
                children.push(textNode);
              }
            } else if (child.nodeType === 1 && child.tagName.toLowerCase() !== 'br') {
              var result = buildTree(child);
              if (result) children = children.concat(result);
            }
          }

          node.children = mergeConsecutiveTexts(children, el);

          if (node.type && node.type.startsWith('heading_') && node.children && node.children.length > 0 && !node.text) {
            var allTextChildren = true;
            var headingTextParts = [];
            var headingInheritedId = undefined;
            for (var hi = 0; hi < node.children.length; hi++) {
              var hc = node.children[hi];
              if (hc.type !== 'text' || hc.children) { allTextChildren = false; break; }
              if (hc.text) headingTextParts.push(hc.text);
              if (hc.id !== undefined && headingInheritedId === undefined) headingInheritedId = hc.id;
            }
            if (allTextChildren && headingTextParts.length > 0) {
              var headingMerged = headingTextParts.join(' ');
              var headingMergedTrimmed = trimText(headingMerged, trimLength);
              node.text = headingMergedTrimmed || headingMerged;
              if (headingMergedTrimmed && headingInheritedId !== undefined) node.id = headingInheritedId;
              node.children = undefined;
            }
          }

          if (node.type === 'text' && node.children && node.children.length > 0) {
            var allTextChildren = true;
            for (var ti = 0; ti < node.children.length; ti++) {
              if (node.children[ti].type !== 'text') { allTextChildren = false; break; }
            }
            if (allTextChildren) {
              var parts = [];
              var inheritedId = undefined;
              for (var tj = 0; tj < node.children.length; tj++) {
                var cc = node.children[tj];
                if (cc.text) parts.push(cc.text);
                if (cc.id !== undefined && inheritedId === undefined) inheritedId = cc.id;
              }
              if (parts.length > 0) {
                var merged = parts.join(' ');
                var mergedTrimmed = trimText(merged, trimLength);
                node.text = mergedTrimmed || merged;
                if (mergedTrimmed && inheritedId !== undefined) node.id = inheritedId;
                node.children = undefined;
              }
            } else if (!node.text && node.id === undefined) {
              return node.children;
            }
          }

          if (!node.text && node.id === undefined && (!node.children || node.children.length === 0)) {
            return null;
          }

          return [node];
        }

        var tree = document.body ? buildTree(document.body) : null;
        return { tree: tree || [], selectorMap: selectorMap, urlMap: urlMap };
      })()
    `) as { tree: any[]; selectorMap: Record<number, string>; urlMap: Record<number, string> };

    const yamlOutput = treeToString(result.tree, 0, !!showUrls);

    this.idToSelector.clear();
    this.idToUrl.clear();
    for (const [id, selector] of Object.entries(result.selectorMap)) {
      this.idToSelector.set(Number(id), selector);
    }
    for (const [id, url] of Object.entries(result.urlMap || {})) {
      this.idToUrl.set(Number(id), url);
    }

    return {
      accessibilityTree: `${SNAPSHOT_FORMAT_EXPLANATION}\n\n${yamlOutput}`,
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  async viewNode(nodeId: number): Promise<ViewNodeResult> {
    const selector = this.idToSelector.get(nodeId);
    if (!selector) {
      return { type: 'text', content: `Node with ID ${nodeId} not found` };
    }

    const cachedUrl = this.idToUrl.get(nodeId);
    if (cachedUrl) {
      return { type: 'text', content: cachedUrl };
    }

    const result = await this.page.evaluate(`
      (function() {
        var sel = ${JSON.stringify(selector)};
        var el = document.querySelector(sel);
        if (!el) return { type: 'text', text: 'Element not found' };
        if (el.tagName.toLowerCase() === 'img') {
          var src = el.src;
          if (src) return { type: 'image', src: src };
          return { type: 'text', text: 'Image (no source)' };
        }
        var t = el.textContent || '';
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
    return this.idToSelector.get(nodeId) || null;
  }

  async click(selector: string): Promise<void> {
    if (isHumanDelaysEnabled()) {
      await new Promise(r => setTimeout(r, getRandomClickDelay()));
    }
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
    const delay = options.delay ?? (isHumanDelaysEnabled() ? getRandomTypingDelay() : 0);
    await this.page.type(selector, text, { delay });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.focus(selector);
    await this.page.evaluate(`(function() { var sel = ${JSON.stringify(selector)}; var el = document.querySelector(sel); if (el) el.value = ''; })()`);
    const delay = isHumanDelaysEnabled() ? getRandomTypingDelay() : 0;
    await this.page.type(selector, value, { delay });
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
