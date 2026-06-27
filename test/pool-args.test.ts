import { describe, it, expect } from 'vitest';
import { buildLightpandaServeArgs } from '../src/pool.js';

describe('buildLightpandaServeArgs', () => {
  it('emits the base serve args with no proxy flag when unset', () => {
    const args = buildLightpandaServeArgs(9222);
    expect(args).toEqual([
      'serve', '--log_level', 'warn',
      '--host', '127.0.0.1', '--port', '9222', '--timeout', '86400',
    ]);
    expect(args).not.toContain('--http-proxy');
  });

  it('appends --http-proxy with the value when a proxy is provided', () => {
    const args = buildLightpandaServeArgs(9333, 'http://user:pass@host:8080');
    expect(args.indexOf('--http-proxy')).toBeGreaterThan(-1);
    const idx = args.indexOf('--http-proxy');
    expect(args[idx + 1]).toBe('http://user:pass@host:8080');
    // proxy goes at the tail (9 base args + flag + value = 11)
    expect(args.length).toBe(11);
    expect(args[args.length - 2]).toBe('--http-proxy');
  });

  it('ignores empty-string proxy', () => {
    expect(buildLightpandaServeArgs(9222, '')).not.toContain('--http-proxy');
  });
});
