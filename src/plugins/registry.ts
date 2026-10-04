import type { Plugin } from '../plugin-api.js';
import { documentExportPlugin } from './document-export/index.js';

// Built-in plugins shipped in-repo. Register new plugins here — the plugin's
// key is what PLUGINS / --plugins= refers to.
export const BUILTIN_PLUGINS: Record<string, Plugin> = {
  'document-export': documentExportPlugin,
};

/**
 * Resolve the PLUGINS config (comma-separated plugin names) into plugin
 * objects. Unset, empty, or 'none' = no plugins (the default). Throws on
 * unknown names so the server exits at startup with a clear message.
 */
export function resolvePlugins(raw: string | undefined): Plugin[] {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'none') return [];
  const names = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  const unknown = names.filter(n => !(n in BUILTIN_PLUGINS));
  if (unknown.length > 0) {
    throw new Error(`Unknown plugin(s): ${unknown.join(', ')}. Available plugins: ${Object.keys(BUILTIN_PLUGINS).join(', ')}`);
  }
  return names.map(n => BUILTIN_PLUGINS[n]);
}
