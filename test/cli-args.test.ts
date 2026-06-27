import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCliArgs, applyCliArgsToEnv, CLI_FLAG_TO_ENV } from '../src/cli-args.js';

describe('parseCliArgs', () => {
  it('returns an empty object when no args are provided', () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it('parses all known flags', () => {
    const args = parseCliArgs([
      '--fallback-browser=headless',
      '--lightpanda-pool-size=10',
      '--navigate-wait-until=networkidle0',
      '--skip-lightpanda-domains=g2.com,linkedin.com',
      '--user-agent=Mozilla/5.0',
      '--proxy-server=http://proxy.example.com:8080',
    ]);

    expect(args).toEqual({
      'fallback-browser': 'headless',
      'lightpanda-pool-size': '10',
      'navigate-wait-until': 'networkidle0',
      'skip-lightpanda-domains': 'g2.com,linkedin.com',
      'user-agent': 'Mozilla/5.0',
      'proxy-server': 'http://proxy.example.com:8080',
    });
  });

  it('normalizes boolean flags', () => {
    expect(parseCliArgs(['--stealth-enabled=1'])['stealth-enabled']).toBe('true');
    expect(parseCliArgs(['--stealth-enabled=0'])['stealth-enabled']).toBe('false');
    expect(parseCliArgs(['--stealth-enabled=TRUE'])['stealth-enabled']).toBe('true');
    expect(parseCliArgs(['--stealth-enabled=FALSE'])['stealth-enabled']).toBe('false');
  });

  it('rejects invalid boolean values', () => {
    expect(() => parseCliArgs(['--stealth-enabled=maybe'])).toThrow('Boolean flag');
  });

  it('rejects non-numeric values for numeric flags', () => {
    expect(() => parseCliArgs(['--lightpanda-pool-size=abc'])).toThrow('non-negative integer');
  });

  it('rejects negative numeric values', () => {
    expect(() => parseCliArgs(['--navigate-timeout=-1'])).toThrow('non-negative integer');
  });

  it('rejects invalid enum values', () => {
    expect(() => parseCliArgs(['--navigate-wait-until=never'])).toThrow('Invalid value');
    expect(() => parseCliArgs(['--fallback-browser=firefox'])).toThrow('Invalid value');
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--unknown-flag=value'])).toThrow('Unknown flag');
  });

  it('rejects removed flags', () => {
    expect(() => parseCliArgs(['--chrome-enabled=false'])).toThrow('Unknown flag');
    expect(() => parseCliArgs(['--skip-headless-domains=g2.com'])).toThrow('Unknown flag');
  });

  it('rejects flags without =value', () => {
    expect(() => parseCliArgs(['--fallback-browser'])).toThrow('--flag=value');
  });

  it('rejects empty values', () => {
    expect(() => parseCliArgs(['--user-agent='])).toThrow('non-empty value');
  });

  it('rejects positional arguments', () => {
    expect(() => parseCliArgs(['something'])).toThrow('Invalid argument');
  });
});

describe('applyCliArgsToEnv', () => {
  const envKeys = Object.values(CLI_FLAG_TO_ENV);
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      originalValues[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
  });

  it('applies parsed CLI args to process.env', () => {
    applyCliArgsToEnv({
      'fallback-browser': 'headless',
      'lightpanda-pool-size': '7',
      'navigate-wait-until': 'load',
    });

    expect(process.env.FALLBACK_BROWSER).toBe('headless');
    expect(process.env.LIGHTPANDA_POOL_SIZE).toBe('7');
    expect(process.env.NAVIGATE_WAIT_UNTIL).toBe('load');
  });

  it('overrides existing environment variables', () => {
    process.env.FALLBACK_BROWSER = 'none';
    process.env.NAVIGATE_TIMEOUT = '30000';

    applyCliArgsToEnv({
      'fallback-browser': 'browserbase',
      'navigate-timeout': '60000',
    });

    expect(process.env.FALLBACK_BROWSER).toBe('browserbase');
    expect(process.env.NAVIGATE_TIMEOUT).toBe('60000');
  });
});
