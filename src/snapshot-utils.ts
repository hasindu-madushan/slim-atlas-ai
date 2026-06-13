/**
 * Shared snapshot utilities for building DOM trees and generating YAML output.
 *
 * Browser-side functions are defined here and can be used with page.evaluate()
 * by wrapping them in a callback. Node.js-side utilities are exported as regular functions.
 */

/**
 * buildTree - runs in browser context via page.evaluate().
 * Builds a DOM tree from an element with unique numeric IDs.
 */
export function buildTree(element: Element, idObj: { counter: number }, shouldFlatten: boolean, trimLength: number): any {
  const id = idObj.counter++;
  const node: any = { type: element.tagName.toLowerCase() };

  if (element.tagName.toLowerCase() === 'img') {
    const alt = (element as HTMLImageElement).alt;
    const src = (element as HTMLImageElement).src;
    if (alt) {
      node.image_alt = alt;
    } else if (src) {
      const filename = src.split('/').pop()?.split('?')[0] || '';
      if (filename) node.image_alt = filename;
    }
  }

  let textContent = '';
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      textContent += child.textContent || '';
    }
  }
  textContent = textContent.trim();
  if (textContent) {
    node.text = textContent.length > trimLength
      ? textContent.substring(0, trimLength) + '... (trimmed)'
      : textContent;
  }

  const children: any[] = [];
  for (let j = 0; j < element.children.length; j++) {
    const ch = element.children[j];
    if (ch.tagName.toLowerCase() === 'br') continue;
    children.push(buildTree(ch, idObj, shouldFlatten, trimLength));
  }

  if (shouldFlatten && children.length === 1 && !node.text && !node.src) {
    return children[0];
  }

  if (children.length > 0) {
    node.children = children;
  }

  const obj: any = {};
  obj[id] = node;
  return obj;
}

/**
 * generateSelector - runs in browser context.
 * Generates a full CSS selector path for an element.
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

/**
 * Converts a tree object to YAML format.
 * Runs in Node.js context.
 */
export function treeToYaml(obj: any, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  const lines: string[] = [];

  if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (!isNaN(Number(key))) {
        lines.push(`${key}:`);
        lines.push(treeToYaml(value, indent + 1));
      } else if (key === 'type') {
        lines.push(`${spaces}${key}: ${value}`);
      } else if (key === 'text' || key === 'image_alt') {
        lines.push(`${spaces}${key}: "${String(value).replace(/"/g, '\\"')}"`);
      } else if (key === 'children') {
        lines.push(`${spaces}${key}:`);
        for (const child of (value as any[])) {
          if (typeof child === 'object' && child !== null) {
            for (const [childId, childObj] of Object.entries(child)) {
              lines.push(`${spaces}  ${childId}:`);
              lines.push(treeToYaml(childObj, indent + 2));
            }
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format explanation for the YAML snapshot output.
 */
export const SNAPSHOT_FORMAT_EXPLANATION = `## YAML Snapshot Format

Each node contains:
- \`id\`: Unique numeric identifier for the node
- \`type\`: HTML tag name (e.g., div, p, span, button)
- \`text\`: Text content between tags (trimmed to 200 chars, marked with "... (trimmed)" if truncated)
- \`children\`: Child nodes in the same format

The ID to CSS selector mapping is maintained in memory for referencing nodes in subsequent operations.`;
