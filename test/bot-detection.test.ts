import { describe, it, expect, vi } from 'vitest';
import { BotDetectionService } from '../src/bot-detection.js';

function mockPage(overrides: Partial<{
  html: string;
  bodyText: string;
  elCount: number;
  title: string;
  hostname: string;
}>) {
  const defaults = {
    html: '<html><body></body></html>',
    bodyText: 'Hello world this is a normal page with plenty of text content',
    elCount: 50,
    title: 'Normal Page',
    hostname: 'example.com',
  };
  const data = { ...defaults, ...overrides };
  return {
    evaluate: vi.fn().mockResolvedValue(data),
  };
}

describe('BotDetectionService', () => {
  const service = new BotDetectionService();

  it('returns not blocked for a normal page', async () => {
    const page = mockPage({});
    const result = await service.detect(page as any);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('');
  });

  it('returns blocked when page.evaluate itself throws', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context was destroyed')),
    };
    const result = await service.detect(page as any);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('detection failed');
  });

  describe('strong markers', () => {
    for (const marker of ['cf-chl-bypass', 'cdn-cgi/challenge-platform', 'px-captcha',
      'bm-challenge', '/_bm/', 'datadome']) {
      it(`detects marker: ${marker}`, async () => {
        const page = mockPage({ html: `<html><script src="${marker}/x.js"></script></html>` });
        const result = await service.detect(page as any);
        expect(result.blocked).toBe(true);
        expect(result.reason).toBe(`marker: ${marker}`);
      });
    }
  });

  describe('challenge title prefix', () => {
    const challengeTitles = [
      'Just a moment...',
      'Checking your browser...',
      'Access Denied',
      'access denied',
      'DDOS protection',
      'ddos protection by cloudflare',
      'Human Verification',
      'Verify you are human',
      'Attention Required',
      'attention required!',
    ];

    for (const title of challengeTitles) {
      it(`detects challenge title: "${title}"`, async () => {
        const page = mockPage({ title, html: '<html></html>', bodyText: '', elCount: 0 });
        const result = await service.detect(page as any);
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('challenge title');
      });
    }

    it('does not flag a title with a challenge word in the middle', async () => {
      const page = mockPage({ title: 'This is just a moment in time' });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(false);
    });
  });

  describe('near-empty body', () => {
    it('detects body with <50 chars and <20 elements', async () => {
      const page = mockPage({
        bodyText: 'hi',
        elCount: 3,
        title: '',
        html: '<html><body></body></html>',
      });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('near-empty body');
    });

    it('treats 49 chars as near-empty', async () => {
      const page = mockPage({ bodyText: 'a'.repeat(49), elCount: 5 });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(true);
    });

    it('treats 50 chars as sufficient', async () => {
      const page = mockPage({ bodyText: 'a'.repeat(50), elCount: 5 });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(false);
    });

    it('treats 49 chars + 20 elements as sufficient', async () => {
      const page = mockPage({ bodyText: 'a'.repeat(49), elCount: 20 });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(false);
    });

    it('treats 0 chars + 19 elements as near-empty', async () => {
      const page = mockPage({ bodyText: '', elCount: 19 });
      const result = await service.detect(page as any);
      expect(result.blocked).toBe(true);
    });

    it('includes body text length and element count in reason', async () => {
      const page = mockPage({ bodyText: 'ab', elCount: 2, title: 'Blocked' });
      const result = await service.detect(page as any);
      expect(result.reason).toContain('2 chars');
      expect(result.reason).toContain('2 elements');
    });
  });
});
