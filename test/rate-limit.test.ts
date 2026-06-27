import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter', () => {
  it('is disabled with empty config', () => {
    expect(new RateLimiter([], 1000).isEnabled()).toBe(false);
    expect(new RateLimiter(['g2.com'], 0).isEnabled()).toBe(false);
  });

  it('matches a configured domain and its subdomains, misses others', () => {
    const rl = new RateLimiter(['g2.com'], 1000);
    expect(rl.matchedDomain('https://g2.com/x')).toBe('g2.com');
    expect(rl.matchedDomain('https://www.g2.com/x')).toBe('g2.com');
    expect(rl.matchedDomain('https://sellers.g2.com/x')).toBe('g2.com');
    expect(rl.matchedDomain('https://example.com/x')).toBeNull();
    expect(rl.matchedDomain('not-a-url')).toBeNull();
  });

  it('does not sleep on the first hit to a configured domain', async () => {
    const rl = new RateLimiter(['g2.com'], 2000);
    const start = Date.now();
    await rl.throttle('s1', 'https://www.g2.com/a');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('does not throttle non-configured domains even on rapid calls', async () => {
    const rl = new RateLimiter(['g2.com'], 2000);
    const start = Date.now();
    await rl.throttle('s1', 'https://example.com/a');
    await rl.throttle('s1', 'https://example.com/b');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('sleeps the remaining delay on a second hit to the same configured domain', async () => {
    const rl = new RateLimiter(['g2.com'], 300);
    await rl.throttle('s1', 'https://g2.com/a');
    // Burn ~100ms so we can assert the sleep is the remainder, not the full delay.
    await new Promise(r => setTimeout(r, 100));
    const start = Date.now();
    await rl.throttle('s1', 'https://g2.com/b');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(300);
  });

  it('shares one bucket across subdomains of the same configured domain', async () => {
    const rl = new RateLimiter(['g2.com'], 300);
    await rl.throttle('s1', 'https://www.g2.com/a');
    const start = Date.now();
    await rl.throttle('s2', 'https://sellers.g2.com/b');
    // Different session, different subdomain, same configured domain -> throttled.
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  it('does nothing when disabled even if domain matches', async () => {
    const rl = new RateLimiter(['g2.com'], 0);
    const start = Date.now();
    await rl.throttle('s1', 'https://g2.com/a');
    await rl.throttle('s1', 'https://g2.com/b');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('keeps the jittered delay within [minDelay, minDelay+jitter]', async () => {
    const minDelay = 200;
    const jitter = 200;
    const rl = new RateLimiter(['g2.com'], minDelay, jitter);
    await rl.throttle('s1', 'https://g2.com/a'); // seed lastHit
    const start = Date.now();
    await rl.throttle('s1', 'https://g2.com/b');
    const elapsed = Date.now() - start;
    // minDelay <= elapsed <= minDelay+jitter (allow small timer slack)
    expect(elapsed).toBeGreaterThanOrEqual(minDelay - 20);
    expect(elapsed).toBeLessThan(minDelay + jitter + 50);
  });

  it('a fresh first hit still does not sleep even with jitter', async () => {
    const rl = new RateLimiter(['g2.com'], 2000, 1000);
    const start = Date.now();
    await rl.throttle('s1', 'https://g2.com/a');
    expect(Date.now() - start).toBeLessThan(50);
  });

  describe('wildcard patterns', () => {
    it('"*" matches every host and keys each host independently', () => {
      const rl = new RateLimiter(['*'], 1000);
      expect(rl.matchedDomain('https://example.com/')).toBe('example.com');
      expect(rl.matchedDomain('https://www.reddit.com/')).toBe('www.reddit.com');
      expect(rl.matchedDomain('https://g2.com/')).toBe('g2.com');
    });

    it('"*" throttles each domain independently (not one shared bucket)', async () => {
      const rl = new RateLimiter(['*'], 300);
      await rl.throttle('s1', 'https://a.com/');
      // Different host right after -> not throttled against a.com.
      const start = Date.now();
      await rl.throttle('s1', 'https://b.com/');
      expect(Date.now() - start).toBeLessThan(50);
      // Same host again -> throttled.
      const start2 = Date.now();
      await rl.throttle('s1', 'https://a.com/');
      expect(Date.now() - start2).toBeGreaterThanOrEqual(250);
    });

    it('"*.reddit.com" matches subdomains only, not the apex, and groups them', () => {
      const rl = new RateLimiter(['*.reddit.com'], 1000);
      expect(rl.matchedDomain('https://www.reddit.com/')).toBe('reddit.com');
      expect(rl.matchedDomain('https://old.reddit.com/')).toBe('reddit.com');
      expect(rl.matchedDomain('https://reddit.com/')).toBeNull();
      expect(rl.matchedDomain('https://notreddit.com/')).toBeNull();
    });

    it('"*.reddit.com" shares one bucket across its subdomains', async () => {
      const rl = new RateLimiter(['*.reddit.com'], 300);
      await rl.throttle('s1', 'https://www.reddit.com/');
      const start = Date.now();
      await rl.throttle('s2', 'https://old.reddit.com/');
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    });

    it('literal + wildcard can coexist and combine on the apex', () => {
      // reddit.com (apex+subdomains) + *.reddit.com (subdomains) both key to reddit.com.
      const rl = new RateLimiter(['reddit.com', '*.reddit.com'], 1000);
      expect(rl.matchedDomain('https://reddit.com/')).toBe('reddit.com');
      expect(rl.matchedDomain('https://old.reddit.com/')).toBe('reddit.com');
    });
  });
});
