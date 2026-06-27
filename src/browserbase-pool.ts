import puppeteer from 'puppeteer';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { ChromeManager } from './chrome.js';
import { log } from './logger.js';
import { applyStealthToPage } from './stealth.js';
import type { FallbackPool, PoolSlot, PoolStats } from './session.js';

const API_KEY = process.env.BROWSERBASE_API_KEY || '';
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';
const API_BASE = process.env.BROWSERBASE_API_URL || 'https://api.browserbase.com/v1';
const CONNECT_HOST = process.env.BROWSERBASE_CONNECT_HOST || 'wss://connect.browserbase.com';
const MAX_SIZE = parseInt(process.env.BROWSERBASE_POOL_SIZE || process.env.CHROME_POOL_SIZE || '1', 10);

function ensureConfigured(): void {
  if (!API_KEY || !PROJECT_ID) {
    throw new Error('Browserbase requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID');
  }
}

async function createBrowserbaseSession(): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId: PROJECT_ID }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Browserbase create session failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

async function deleteBrowserbaseSession(bbId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/sessions/${bbId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
  } catch (e) {
    log.warn('browserbase-pool', `Failed to delete session ${bbId}: ${(e as Error).message}`);
  }
}

interface BBSlot extends PoolSlot {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export class BrowserbasePool implements FallbackPool {
  private inUse: Map<string, BBSlot> = new Map();
  private available: BBSlot[] = [];
  private waitQueue: Array<(slot: BBSlot) => void> = [];

  async acquire(sessionId: string): Promise<PoolSlot> {
    ensureConfigured();

    const existing = this.inUse.get(sessionId);
    if (existing) {
      log.debug(sessionId, `Reusing browserbase slot ${existing.id}`);
      return existing;
    }

    if (this.available.length > 0) {
      const slot = this.available.pop()!;
      log.info(sessionId, `Acquired browserbase slot ${slot.id}`);
      this.inUse.set(sessionId, slot);
      return slot;
    }

    const total = this.inUse.size + this.available.length;
    if (total < MAX_SIZE) {
      const slot = await this.createSlot(sessionId);
      this.inUse.set(sessionId, slot);
      return slot;
    }

    log.warn(sessionId, `All browserbase slots in use, waiting`);
    return new Promise((resolve) => {
      this.waitQueue.push((slot) => {
        log.info(sessionId, `Got browserbase slot ${slot.id} from wait queue`);
        this.inUse.set(sessionId, slot);
        resolve(slot);
      });
    });
  }

  private async createSlot(_sessionId: string): Promise<BBSlot> {
    const bbId = await createBrowserbaseSession();
    log.info('browserbase-pool', `Created remote session ${bbId}`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `${CONNECT_HOST}?apiKey=${API_KEY}&projectId=${PROJECT_ID}&sessionId=${bbId}`,
      protocolTimeout: 30000,
    });

    let context: BrowserContext;
    let page: Page;
    const pages = await browser.pages();
    if (pages.length > 0) {
      page = pages[0];
      context = page.browserContext();
    } else {
      context = await browser.createBrowserContext();
      page = await context.newPage();
    }
    await applyStealthToPage(page);

    const manager = new ChromeManager({ browser, context, page });
    return { id: bbId, browser, context, page, manager };
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.inUse.get(sessionId);
    if (!slot) return;
    this.inUse.delete(sessionId);

    try { await slot.browser.disconnect(); } catch (e) {}
    await deleteBrowserbaseSession(slot.id);

    if (this.waitQueue.length > 0) {
      // Cloud sessions can't be safely recycled; spin a fresh one for the next waiter.
      try {
        const fresh = await this.createSlot(sessionId);
        const next = this.waitQueue.shift()!;
        next(fresh);
      } catch (e: any) {
        log.error('browserbase-pool', `Failed to serve waiter: ${e.message}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    const all = [...this.available, ...this.inUse.values()];
    for (const slot of all) {
      try { await slot.browser.disconnect(); } catch (e) {}
      await deleteBrowserbaseSession(slot.id);
    }
    this.available = [];
    this.inUse.clear();
    this.waitQueue = [];
  }

  async getStats(): Promise<PoolStats> {
    return {
      total: this.inUse.size + this.available.length,
      available: this.available.length,
      inUse: this.inUse.size,
      maxSize: MAX_SIZE,
      memoryBytes: 0, // remote
    };
  }

  getMemoryUsageBytes(): Promise<number> {
    return Promise.resolve(0);
  }

  async killOrphaned(activeSlotIds: Set<string>): Promise<void> {
    const toKill = this.available.filter(slot => !activeSlotIds.has(slot.id));
    this.available = this.available.filter(slot => activeSlotIds.has(slot.id));
    for (const slot of toKill) {
      log.info('browserbase-pool', `Killing orphaned browserbase session ${slot.id}`);
      try { await slot.browser.disconnect(); } catch (e) {}
      await deleteBrowserbaseSession(slot.id);
    }
  }
}
