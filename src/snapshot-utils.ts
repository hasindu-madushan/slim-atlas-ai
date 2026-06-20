/**
 * Shared snapshot utilities for building semantic DOM snapshots.
 * Browser-side functions are re-implemented inline in browser-tools.ts
 * due to Puppeteer's page.evaluate() limitations.
 */

// Tags to skip in output (flatten, recurse into children, no ID assigned)
export const SKIP_TAGS = new Set([
  'div', 'span', 'br', 'hr',
  'script', 'style', 'noscript', 'template', 'slot',
  'main', 'section', 'article', 'aside',
  'strong', 'em', 'b', 'i', 'u', 's', 'mark', 'del', 'ins', 'sub', 'sup', 'small',
  'code', 'kbd', 'samp', 'var', 'abbr', 'time', 'data', 'wbr',
  'picture', 'source', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'blockquote', 'q', 'cite', 'pre',
  'svg', 'path', 'g', 'circle', 'rect', 'line', 'polygon', 'polyline',
  'thead', 'tbody', 'tfoot', 'colgroup', 'col',
  'map', 'area', 'canvas', 'audio', 'video',
  'head', 'title', 'meta', 'link', 'base',
  'meter', 'progress', 'output',
  'ul', 'ol', 'li',
  'body',
]);

// HTML tag to semantic type name mapping
export const ELEMENT_TYPE_MAP: Record<string, string | null> = {
  'p': 'text',
  'h1': 'heading_1', 'h2': 'heading_2', 'h3': 'heading_3',
  'h4': 'heading_4', 'h5': 'heading_5', 'h6': 'heading_6',
  'a': 'link',
  'button': 'button',
  'textarea': 'textbox',
  'select': 'combobox',
  'img': 'image',
  'li': 'listitem',
  'ul': 'list', 'ol': 'list',
  'table': 'table',
  'tr': 'row',
  'td': 'cell', 'th': 'columnheader',
  'footer': 'contentinfo',
  'header': 'banner',
  'nav': 'navigation',
  'form': 'form',
  'label': 'label',
  'dialog': 'dialog',
  'fieldset': 'group', 'legend': 'label',
  'summary': 'button', 'details': 'group',
  'option': 'option',
};

// Input type attribute to semantic type mapping
export const INPUT_TYPE_MAP: Record<string, string> = {
  'text': 'textbox', 'search': 'searchbox', 'email': 'textbox',
  'tel': 'textbox', 'url': 'textbox', 'password': 'textbox',
  'number': 'spinbutton', 'checkbox': 'checkbox', 'radio': 'radio',
  'range': 'slider', 'submit': 'button', 'reset': 'button',
  'button': 'button', 'file': 'file', 'color': 'color',
  'date': 'textbox', 'datetime-local': 'textbox',
  'month': 'textbox', 'week': 'textbox', 'time': 'textbox',
  'image': 'button',
};

// Elements that are inherently interactable
export const INTERACTABLE_TAGS = new Set([
  'a', 'button', 'input', 'textarea', 'select', 'summary',
]);

// Interactive ARIA roles
export const INTERACTIVE_ROLES: Record<string, boolean> = {
  'button': true, 'link': true, 'checkbox': true, 'radio': true,
  'tab': true, 'switch': true, 'menuitem': true, 'option': true,
  'slider': true, 'spinbutton': true, 'combobox': true,
  'searchbox': true, 'textbox': true, 'listbox': true,
  'treeitem': true, 'menuitemcheckbox': true, 'menuitemradio': true,
  'gridcell': true,
};

export interface SnapshotNode {
  type: string;
  text?: string;
  id?: number;
  url?: string;
  urlTrimmed?: boolean;
  children?: SnapshotNode[];
}

const STRUCTURAL_TYPES = new Set([
  'list', 'table', 'row',
  'contentinfo', 'banner', 'navigation',
  'form', 'group', 'dialog',
]);

function hasUsefulDescendant(node: SnapshotNode): boolean {
  if (node.id !== undefined) return true;
  if (node.text) return true;
  if (!STRUCTURAL_TYPES.has(node.type)) return true;
  if (!node.children) return false;
  for (const child of node.children) {
    if (hasUsefulDescendant(child)) return true;
  }
  return false;
}

function shouldSkipStructural(node: SnapshotNode): boolean {
  if (!STRUCTURAL_TYPES.has(node.type)) return false;
  if (node.id !== undefined) return false;
  if (node.text) return false;
  if (!node.children || node.children.length === 0) return true;
  for (const child of node.children) {
    if (hasUsefulDescendant(child)) return false;
  }
  return true;
}

/**
 * Converts a snapshot node tree to indented text format.
 * Runs in Node.js context.
 */
export function treeToString(nodes: SnapshotNode[], indent: number = 0, showUrls: boolean = false): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  for (const node of nodes) {
    if (!node || !node.type) continue;
    if (node.type === 'link' && !node.text && !node.url) continue;
    if (shouldSkipStructural(node)) continue;

    let line = `${prefix}- ${node.type}`;

    if (node.text) {
      line += ` "${node.text.replace(/"/g, '\\"')}"`;
    }

    if (node.id !== undefined) {
      line += ` #${node.id}`;
    }
    if (showUrls && node.url) {
      line += `@${node.url}`;
    }

    lines.push(line);

    if (node.children && node.children.length > 0) {
      lines.push(treeToString(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

/**
 * Generates a full CSS selector path for an element.
 * Runs in browser context via page.evaluate().
 */
export function generateSelector(element: Element): string {
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

export const SNAPSHOT_FORMAT_EXPLANATION = `## Format: heading_1-6 | text "x" | link "x" | button "x" | textbox/combobox/checkbox/radio/spinbutton/slider/option | image | list/listitem/row/cell/columnheader/table | contentinfo/banner/navigation/form/group/dialog/label; attrs use #N for id, @URL for url; long values end "... (trimmed)"; **link URLs are omitted by default — to get a single link's URL call \`browser_view_node\` with its #id; only re-run this snapshot with \`show_urls=true\` if you need URLs for many links at once**; use \`browser_view_node\` for full text. To click/type/view a node, pass its numeric ID (the number after #) to the nodeId parameter — do not pass #N or selector "#N".`;
