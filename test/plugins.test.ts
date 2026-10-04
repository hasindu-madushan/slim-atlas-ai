import { describe, it, expect } from 'vitest';
import { resolvePlugins, BUILTIN_PLUGINS } from '../src/plugins/registry.js';

describe('resolvePlugins', () => {
  it('disables all plugins by default (unset, empty, or "none")', () => {
    expect(resolvePlugins(undefined)).toEqual([]);
    expect(resolvePlugins('')).toEqual([]);
    expect(resolvePlugins('none')).toEqual([]);
  });

  it('resolves known plugin names', () => {
    expect(resolvePlugins('document-export').map(p => p.name)).toEqual(['document-export']);
  });

  it('is case-insensitive, trims, and de-duplicates', () => {
    expect(resolvePlugins(' Document-Export , document-export ')).toHaveLength(1);
  });

  it('throws on unknown plugin names, listing what is available', () => {
    expect(() => resolvePlugins('nope')).toThrow(/Unknown plugin\(s\): nope/);
    expect(() => resolvePlugins('nope')).toThrow(/document-export/);
  });
});

describe('document-export plugin', () => {
  const plugin = BUILTIN_PLUGINS['document-export'];

  it('exposes the two pipeline tools as session-creating tools', () => {
    expect(plugin.tools.map(t => t.name).sort()).toEqual(['browser_export_pptx', 'browser_print_pdf']);
    for (const tool of plugin.tools) {
      expect(tool.canCreateSession).toBe(true);
      expect((tool.inputSchema as any).required).toEqual(['session_id']);
    }
  });

  it('redacts html and header/footer templates from log args', () => {
    const tool = plugin.tools.find(t => t.name === 'browser_print_pdf')!;
    const html = '<html>big document</html>';
    const redacted = tool.redactArgsForLog!({
      session_id: 'abcd',
      html,
      header_template: '<span>h</span>',
      footer_template: '<span>f</span>',
      print_background: true,
    });
    expect(redacted.html).toBe(`<${html.length} chars>`);
    expect(redacted.header_template).toBeUndefined();
    expect(redacted.footer_template).toBeUndefined();
    expect(redacted.session_id).toBe('abcd');
    expect(redacted.print_background).toBe(true);
  });
});
