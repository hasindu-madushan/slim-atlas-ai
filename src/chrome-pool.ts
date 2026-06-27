import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { exec } from 'child_process';
import { ChromeManager } from './chrome.js';
import { log } from './logger.js';
import { getAntiDetectionArgs, applyStealthToPage } from './stealth.js';
import type { FallbackPool } from './session.js';

puppeteer.use(StealthPlugin());

const MAX_SIZE = parseInt(process.env.CHROME_POOL_SIZE || '1', 10);

function getProcessMemoryBytes(pid: number): Promise<number> {
  return new Promise((resolve) => {
    exec(`ps -p ${pid} -o rss=`, (err, stdout) => {
      if (err) return resolve(0);
      const kb = parseInt(stdout.trim(), 10);
      resolve(isNaN(kb) ? 0 : kb * 1024);
    });
  });
}

interface ChromeSlot {
  id: string;
  context: BrowserContext;
  page: Page;
  manager: ChromeManager;
}

export class ChromePool implements FallbackPool {
  private browser: Browser | null = null;
  private available: ChromeSlot[] = [];
  private inUse: Map<string, ChromeSlot> = new Map();
  private waitQueue: Array<(slot: ChromeSlot) => void> = [];

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    log.info('chrome-pool', 'Launching Chrome browser');
    this.browser = await puppeteer.launch({
      headless: true as any,
      protocolTimeout: 30000,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage',
        '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync', '--disable-translate',
        '--metrics-recording-only', '--mute-audio',
        ...getAntiDetectionArgs(true),
      ],
    });

    this.browser.on('disconnected', () => {
      log.warn('chrome-pool', 'Chrome browser disconnected');
      this.browser = null;
      this.available = [];
      this.inUse.clear();
    });

    return this.browser;
  }

  async acquire(sessionId: string): Promise<ChromeSlot> {
    if (this.inUse.has(sessionId)) {
      log.debug(sessionId, `Reusing existing Chrome slot`);
      return this.inUse.get(sessionId)!;
    }

    if (this.available.length > 0) {
      const slot = this.available.pop()!;
      log.info(sessionId, `Acquired Chrome slot ${slot.id}`);
      this.inUse.set(sessionId, slot);
      return slot;
    }

    const total = this.inUse.size + this.available.length;
    if (total < MAX_SIZE) {
      log.info(sessionId, `Creating new Chrome slot`);
      const slot = await this.createSlot();
      this.inUse.set(sessionId, slot);
      return slot;
    }

    log.warn(sessionId, `All Chrome slots in use, waiting`);
    return new Promise((resolve) => {
      this.waitQueue.push((slot) => {
        log.info(sessionId, `Got Chrome slot ${slot.id} from wait queue`);
        this.inUse.set(sessionId, slot);
        resolve(slot);
      });
    });
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.inUse.get(sessionId);
    if (!slot) return;
    this.inUse.delete(sessionId);

    if (!this.browser || !this.browser.connected) {
      try { slot.page.close(); } catch (e) {}
      try { slot.context.close(); } catch (e) {}
      return;
    }

    try {
      const newSlot = await this.recycleSlot(slot);
      if (!newSlot) return;

      if (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift()!;
        next(newSlot);
      } else {
        this.available.push(newSlot);
      }
    } catch (e) {
      console.error('[chrome-pool] Failed to recycle slot:', (e as Error).message);
    }
  }

  private async recycleSlot(slot: ChromeSlot): Promise<ChromeSlot | null> {
    try { await slot.page.close(); } catch (e) {}
    try { await slot.context.close(); } catch (e) {}

    if (!this.browser || !this.browser.connected) return null;

    try {
      return await this.createSlot();
    } catch (e) {
      console.error('[chrome-pool] Failed to recycle slot:', (e as Error).message);
      return null;
    }
  }

  private async createSlot(): Promise<ChromeSlot> {
    const browser = await this.ensureBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await applyStealthToPage(page);
    const id = `chrome-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('chrome-pool', `Created slot ${id}`);
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

  async getStats() {
    const memoryBytes = await this.getMemoryUsageBytes();
    return {
      total: this.inUse.size + this.available.length,
      available: this.available.length,
      inUse: this.inUse.size,
      maxSize: MAX_SIZE,
      browserConnected: this.browser?.connected ?? false,
      memoryBytes,
    };
  }

  async getMemoryUsageBytes(): Promise<number> {
    const proc = this.browser?.process();
    if (!proc?.pid) return 0;
    return getProcessMemoryBytes(proc.pid);
  }

  async killOrphaned(activeSlotIds: Set<string>): Promise<void> {
    const toKill = this.available.filter(slot => !activeSlotIds.has(slot.id));
    this.available = this.available.filter(slot => activeSlotIds.has(slot.id));

    for (const slot of toKill) {
      log.info('chrome-pool', `Killing orphaned Chrome slot ${slot.id}`);
      try { await slot.page.close(); } catch (e) {}
      try { await slot.context.close(); } catch (e) {}
    }
  }
}
