import { describe, it, expect } from 'vitest';
import { getAntiDetectionArgs, getStealthConfig, getRandomTypingDelay, getRandomClickDelay } from '../src/stealth.js';

describe('getAntiDetectionArgs', () => {
  it('includes automation flags regardless of headless', () => {
    const headless = getAntiDetectionArgs(true);
    const headful = getAntiDetectionArgs(false);
    expect(headless).toContain('--disable-blink-features=AutomationControlled');
    expect(headful).toContain('--disable-blink-features=AutomationControlled');
    expect(headless).toContain('--disable-features=IsolateOrigins,site-per-process');
    expect(headless).toContain('--disable-site-isolation-trials');
  });

  it('includes --disable-gpu when headless', () => {
    expect(getAntiDetectionArgs(true)).toContain('--disable-gpu');
  });

  it('excludes --disable-gpu when headful', () => {
    expect(getAntiDetectionArgs(false)).not.toContain('--disable-gpu');
  });
});

describe('getStealthConfig', () => {
  it('returns a viewport from the pool', () => {
    const pools = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 },
      { width: 1280, height: 720 },
      { width: 1600, height: 900 },
    ];
    for (let i = 0; i < 50; i++) {
      const cfg = getStealthConfig();
      const match = pools.some(p => p.width === cfg.viewport.width && p.height === cfg.viewport.height);
      expect(match).toBe(true);
    }
  });
});

describe('getRandomTypingDelay', () => {
  it('returns a value within [50, 150]', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRandomTypingDelay();
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(150);
    }
  });
});

describe('getRandomClickDelay', () => {
  it('returns a value within [100, 300]', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRandomClickDelay();
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(300);
    }
  });
});
