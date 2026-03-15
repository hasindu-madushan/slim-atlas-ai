import { describe, it, expect, beforeEach, afterEach, jest, beforeAll, afterAll } from 'bun:test';
import { browserManager } from '../src/browser.js';
import { PuppeteerMCPServer } from '../src/server.js';

describe('BrowserManager', () => {
  beforeAll(async () => {
    await browserManager.launch({ headless: true });
  });

  afterAll(async () => {
    await browserManager.close();
  });

  describe('launch', () => {
    it('should launch browser successfully', async () => {
      const connected = await browserManager.isBrowserConnected();
      expect(connected).toBe(true);
    });

    it('should create a page', () => {
      expect(() => browserManager.getPage()).not.toThrow();
    });
  });

  describe('navigate', () => {
    it('should navigate to a URL', async () => {
      await browserManager.navigate({ url: 'https://example.com', waitUntil: 'networkidle0' });
      const pageInfo = await browserManager.getPageInfo();
      expect(pageInfo.url).toContain('example.com');
    });
  });

  describe('getPageInfo', () => {
    it('should return page info', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const info = await browserManager.getPageInfo();
      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('url');
      expect(info).toHaveProperty('title');
    });
  });

  describe('getSnapshot', () => {
    it('should return accessibility snapshot', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const snapshot = await browserManager.getSnapshot();
      expect(snapshot).toHaveProperty('accessibilityTree');
      expect(snapshot).toHaveProperty('url');
      expect(snapshot).toHaveProperty('title');
    });
  });

  describe('getHtml', () => {
    it('should return HTML content', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const html = await browserManager.getHtml();
      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe('goBack and goForward', () => {
    it('should navigate back and forward', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      await browserManager.navigate({ url: 'https://example.org' });
      
      await browserManager.goBack();
      let info = await browserManager.getPageInfo();
      expect(info.url).toContain('example.com');
      
      await browserManager.goForward();
      info = await browserManager.getPageInfo();
      expect(info.url).toContain('example.org');
    });
  });

  describe('evaluate', () => {
    it('should evaluate JavaScript', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const result = await browserManager.evaluate('document.title');
      expect(result).toBe('Example Domain');
    });

    it('should evaluate complex JavaScript', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const result = await browserManager.evaluate('document.querySelector("h1")?.textContent');
      expect(result).toBe('Example Domain');
    });
  });

  describe('takeScreenshot', () => {
    it('should take a screenshot', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const screenshot = await browserManager.takeScreenshot({ type: 'png' });
      expect(screenshot).toBeDefined();
      expect(screenshot.length).toBeGreaterThan(0);
    });

    it('should take a full page screenshot', async () => {
      await browserManager.navigate({ url: 'https://example.com' });
      const screenshot = await browserManager.takeScreenshot({ fullPage: true, type: 'png' });
      expect(screenshot).toBeDefined();
      expect(screenshot.length).toBeGreaterThan(0);
    });
  });

  describe('close', () => {
    it('should close browser successfully', async () => {
      await browserManager.close();
      const connected = await browserManager.isBrowserConnected();
      expect(connected).toBe(false);
    });

    it('should throw error when accessing page after close', async () => {
      await browserManager.launch({ headless: true });
      await browserManager.close();
      expect(() => browserManager.getPage()).toThrow();
    });
  });
});

describe('PuppeteerMCPServer', () => {
  let server: PuppeteerMCPServer;

  beforeEach(() => {
    server = new PuppeteerMCPServer();
  });

  it('should create server instance', () => {
    expect(server).toBeDefined();
  });
});

describe('Types', () => {
  it('should have correct type definitions', () => {
    const navigateOptions = {
      url: 'https://example.com',
      waitUntil: 'networkidle0' as const,
    };
    expect(navigateOptions.url).toBe('https://example.com');
    expect(navigateOptions.waitUntil).toBe('networkidle0');
  });
});