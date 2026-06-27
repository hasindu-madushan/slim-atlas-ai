import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { chromeManager } from '../src/chrome.js';
import { PuppeteerMCPServer } from '../src/server.js';

describe('ChromeManager', () => {
  beforeAll(async () => {
    await chromeManager.launch();
  });

  afterAll(async () => {
    await chromeManager.close();
  });

  describe('launch', () => {
    it('should launch browser successfully', async () => {
      const connected = chromeManager.isConnected();
      expect(connected).toBe(true);
    });

    it('should create a page', () => {
      expect(() => chromeManager.getPage()).not.toThrow();
    });
  });

  describe('navigate', () => {
    it('should navigate to a URL', async () => {
      await chromeManager.navigate({ url: 'https://example.com', waitUntil: 'networkidle0' });
      const pageInfo = await chromeManager.getPageInfo();
      expect(pageInfo.url).toContain('example.com');
    });
  });

  describe('getPageInfo', () => {
    it('should return page info', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const info = await chromeManager.getPageInfo();
      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('url');
      expect(info).toHaveProperty('title');
    });
  });

  describe('getSnapshot', () => {
    it('should return accessibility snapshot', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const snapshot = await chromeManager.getSnapshot();
      expect(snapshot).toHaveProperty('accessibilityTree');
      expect(snapshot).toHaveProperty('url');
      expect(snapshot).toHaveProperty('title');
    });

    it('should flatten a single text child inside headings', async () => {
      await chromeManager.navigate({ url: 'data:text/html,<h3><span>2. DoorDash</span></h3>' });
      const snapshot = await chromeManager.getSnapshot();
      expect(snapshot.accessibilityTree).toContain('- heading_3 "2. DoorDash"');
    });

    it('should omit link URLs by default', async () => {
      await chromeManager.navigate({ url: 'data:text/html,<a href="https://example.org">Example</a>' });
      const snapshot = await chromeManager.getSnapshot();
      expect(snapshot.accessibilityTree).toContain('- link "Example" #');
      expect(snapshot.accessibilityTree).not.toContain('@https://example.org');
    });

    it('should include link URLs when show_urls is true', async () => {
      await chromeManager.navigate({ url: 'data:text/html,<a href="https://example.org">Example</a>' });
      const snapshot = await chromeManager.getSnapshot(true);
      expect(snapshot.accessibilityTree).toContain('@https://example.org');
    });
  });

  describe('getHtml', () => {
    it('should return HTML content', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const html = await chromeManager.getHtml();
      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe('goBack and goForward', () => {
    it('should navigate back and forward', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      await chromeManager.navigate({ url: 'https://example.org' });
      
      await chromeManager.goBack();
      let info = await chromeManager.getPageInfo();
      expect(info.url).toContain('example.com');
      
      await chromeManager.goForward();
      info = await chromeManager.getPageInfo();
      expect(info.url).toContain('example.org');
    });
  });

  describe('evaluate', () => {
    it('should evaluate JavaScript', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const result = await chromeManager.evaluate('document.title');
      expect(result).toBe('Example Domain');
    });

    it('should evaluate complex JavaScript', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const result = await chromeManager.evaluate('document.querySelector("h1")?.textContent');
      expect(result).toBe('Example Domain');
    });
  });

  describe('takeScreenshot', () => {
    it('should take a screenshot', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const screenshot = await chromeManager.takeScreenshot({ type: 'png' });
      expect(screenshot).toBeDefined();
      expect(screenshot.length).toBeGreaterThan(0);
    });

    it('should take a full page screenshot', async () => {
      await chromeManager.navigate({ url: 'https://example.com' });
      const screenshot = await chromeManager.takeScreenshot({ fullPage: true, type: 'png' });
      expect(screenshot).toBeDefined();
      expect(screenshot.length).toBeGreaterThan(0);
    });
  });

  describe('close', () => {
    it('should close browser successfully', async () => {
      await chromeManager.close();
      const connected = chromeManager.isConnected();
      expect(connected).toBe(false);
    });

    it('should throw error when accessing page after close', async () => {
      await chromeManager.launch();
      await chromeManager.close();
      expect(() => chromeManager.getPage()).toThrow();
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