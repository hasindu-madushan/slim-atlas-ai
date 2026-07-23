import { describe, it, expect } from 'vitest';
import { treeToString, SKIP_TAGS, ELEMENT_TYPE_MAP, INTERACTABLE_TAGS } from '../src/snapshot-utils.js';

describe('treeToString', () => {
  it('returns empty string for empty input', () => {
    expect(treeToString([])).toBe('');
  });

  it('returns empty string for null/undefined entries', () => {
    const nodes = [{ type: null as any }];
    expect(treeToString(nodes)).toBe('');
  });

  it('formats a simple text node', () => {
    const nodes = [{ type: 'text', text: 'hello' }];
    expect(treeToString(nodes)).toBe('- text "hello"');
  });

  it('formats a node with an id', () => {
    const nodes = [{ type: 'link', text: 'Click Me', id: 42 }];
    expect(treeToString(nodes)).toBe('- link "Click Me" #42');
  });

  it('escapes double quotes in text', () => {
    const nodes = [{ type: 'text', text: 'say "hello" now' }];
    expect(treeToString(nodes)).toBe('- text "say \\"hello\\" now"');
  });

  it('formats a heading with level', () => {
    expect(treeToString([{ type: 'heading_1', text: 'Title', id: 1 }])).toBe('- heading_1 "Title" #1');
    expect(treeToString([{ type: 'heading_3', text: 'Sub' }])).toBe('- heading_3 "Sub"');
  });

  it('omits url when showUrls is false and includes it when true', () => {
    const nodes = [{ type: 'link', text: 'Example', id: 5, url: 'https://example.com' }];
    expect(treeToString(nodes, 0, false)).toBe('- link "Example" #5');
    expect(treeToString(nodes, 0, true)).toBe('- link "Example" #5@https://example.com');
  });

  it('indents children', () => {
    const nodes = [
      {
        type: 'list', id: 1, children: [
          { type: 'listitem', text: 'Item 1', id: 2 },
          { type: 'listitem', text: 'Item 2', id: 3 },
        ],
      },
    ];
    const out = treeToString(nodes);
    expect(out).toBe(
      '- list #1\n' +
      '  - listitem "Item 1" #2\n' +
      '  - listitem "Item 2" #3'
    );
  });

  it('skips empty link nodes (no text, no url)', () => {
    const nodes = [{ type: 'link' }];
    expect(treeToString(nodes)).toBe('');
  });

  it('keeps link nodes that have text but no url', () => {
    const nodes = [{ type: 'link', text: 'Click' }];
    expect(treeToString(nodes)).toBe('- link "Click"');
  });
});

describe('SKIP_TAGS', () => {
  it('includes common structural tags', () => {
    expect(SKIP_TAGS.has('div')).toBe(true);
    expect(SKIP_TAGS.has('span')).toBe(true);
    expect(SKIP_TAGS.has('main')).toBe(true);
    expect(SKIP_TAGS.has('section')).toBe(true);
    expect(SKIP_TAGS.has('strong')).toBe(true);
    expect(SKIP_TAGS.has('em')).toBe(true);
    expect(SKIP_TAGS.has('svg')).toBe(true);
    expect(SKIP_TAGS.has('path')).toBe(true);
  });
});

describe('ELEMENT_TYPE_MAP', () => {
  it('maps HTML tags to semantic types', () => {
    expect(ELEMENT_TYPE_MAP['h1']).toBe('heading_1');
    expect(ELEMENT_TYPE_MAP['h2']).toBe('heading_2');
    expect(ELEMENT_TYPE_MAP['h6']).toBe('heading_6');
    expect(ELEMENT_TYPE_MAP['a']).toBe('link');
    expect(ELEMENT_TYPE_MAP['button']).toBe('button');
    expect(ELEMENT_TYPE_MAP['p']).toBe('text');
    expect(ELEMENT_TYPE_MAP['img']).toBe('image');
    expect(ELEMENT_TYPE_MAP['textarea']).toBe('textbox');
    expect(ELEMENT_TYPE_MAP['select']).toBe('combobox');
    expect(ELEMENT_TYPE_MAP['table']).toBe('table');
    expect(ELEMENT_TYPE_MAP['tr']).toBe('row');
    expect(ELEMENT_TYPE_MAP['td']).toBe('cell');
    expect(ELEMENT_TYPE_MAP['th']).toBe('columnheader');
  });
});

describe('INTERACTABLE_TAGS', () => {
  it('includes common interactive elements', () => {
    expect(INTERACTABLE_TAGS.has('a')).toBe(true);
    expect(INTERACTABLE_TAGS.has('button')).toBe(true);
    expect(INTERACTABLE_TAGS.has('input')).toBe(true);
    expect(INTERACTABLE_TAGS.has('textarea')).toBe(true);
    expect(INTERACTABLE_TAGS.has('select')).toBe(true);
    expect(INTERACTABLE_TAGS.has('summary')).toBe(true);
  });

  it('does not include non-interactive elements', () => {
    expect(INTERACTABLE_TAGS.has('div')).toBe(false);
    expect(INTERACTABLE_TAGS.has('p')).toBe(false);
    expect(INTERACTABLE_TAGS.has('h1')).toBe(false);
  });
});
