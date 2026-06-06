import puppeteer, { Browser, BrowserContext, Page } from 'puppeteer';
import { ChromeManager } from './chrome.js';

const MAX_SIZE = parseInt(process.env.CHROME_POOL_SIZE || '1', 10);

interface ChromeSlot {
  id: string;
  context: BrowserContext;
  page: Page;
  manager: ChromeManager;
}

export class ChromePool {
  private browser: Browser | null = null;
  private available: ChromeSlot[] = [];
  private inUse: Map<string, ChromeSlot> = new Map();
  private waitQueue: Array<(slot: ChromeSlot) => void> = [];

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    this.browser = await puppeteer.launch({
      headless: true as any,
      args: [
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync', '--disable-translate',
        '--metrics-recording-only', '--mute-audio',
      ],
    });

    this.browser.on('disconnected', () => {
      this.browser = null;
      this.available = [];
      this.inUse.clear();
    });

    return this.browser;
  }

  async acquire(sessionId: string): Promise<ChromeSlot> {
    if (this.inUse.has(sessionId)) return this.inUse.get(sessionId)!;

    if (this.available.length > 0) {
      const slot = this.available.pop()!;
      this.inUse.set(sessionId, slot);
      return slot;
    }

    const total = this.inUse.size + this.available.length;
    if (total < MAX_SIZE) {
      const slot = await this.createSlot();
      this.inUse.set(sessionId, slot);
      return slot;
    }

    return new Promise((resolve) => {
      this.waitQueue.push((slot) => {
        this.inUse.set(sessionId, slot);
        resolve(slot);
      });
    });
  }

  release(sessionId: string): void {
    const slot = this.inUse.get(sessionId);
    if (!slot) return;
    this.inUse.delete(sessionId);

    if (!this.browser || !this.browser.connected) {
      try { slot.page.close(); } catch (e) {}
      try { slot.context.close(); } catch (e) {}
      return;
    }

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next(slot);
    } else {
      this.recycleSlot(slot);
    }
  }

  private async recycleSlot(slot: ChromeSlot): Promise<void> {
    try { await slot.page.close(); } catch (e) {}
    try { await slot.context.close(); } catch (e) {}

    if (!this.browser || !this.browser.connected) return;

    try {
      const newSlot = await this.createSlot();
      this.available.push(newSlot);
    } catch (e) {
      console.error('[chrome-pool] Failed to recycle slot:', (e as Error).message);
    }
  }

  private async createSlot(): Promise<ChromeSlot> {
    const browser = await this.ensureBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const id = `chrome-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const manager = new ChromeManager({ browser, context, page });
    return { id, context, page, manager };
  }

  async shutdown(): Promise<void> {
    for (const slot of this.available) {
      try { await slot.page.close(); } catch (e) {}
      try { await slot.context.close(); } catch (e) {}
    }
    for (const [, slot] of this.inUse) {
      try { await slot.page.close(); } catch (e) {}
      try { await slot.context.close(); } catch (e) {}
    }
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
    }
    this.available = [];
    this.inUse.clear();
    this.waitQueue = [];
  }

  getStats() {
    return {
      total: this.inUse.size + this.available.length,
      available: this.available.length,
      inUse: this.inUse.size,
      maxSize: MAX_SIZE,
      browserConnected: this.browser?.connected ?? false,
    };
  }
}
