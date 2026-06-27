import { randomUUID } from 'crypto';
import puppeteer from 'puppeteer';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { ChromeManager } from './chrome.js';
import { log } from './logger.js';
import { applyStealthToPage } from './stealth.js';
import type { FallbackPool, PoolSlot, PoolStats } from './session.js';

interface CloudSlot extends PoolSlot {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

interface CloudConfig {
  name: string;
  /** Throw if required env vars are missing. Called on every acquire. */
  requireEnv: () => void;
  /** Produce the puppeteer WS endpoint (and optional remote id for tracking/teardown). */
  connect: () => Promise<{ ws: string; remoteId?: string }>;
  /** Optional remote teardown (e.g. DELETE a cloud session). Default: nothing. */
  teardown?: (remoteId: string) => Promise<void>;
}

// ponytail: one engine for every cloud provider. Providers differ only in
// data (endpoint shape + optional REST lifecycle), expressed as a CloudConfig.
// No cap / wait queue: cloud browsers aren't kept warm, so each acquire creates
// a fresh remote connection and each release tears it down. Concurrency is
// bounded by MAX_SESSIONS (each session holds at most one fallback slot).
export class CloudBrowserService implements FallbackPool {
  private inUse: Map<string, CloudSlot> = new Map();

  constructor(private readonly cfg: CloudConfig) {}

  private async buildSlot(browser: Browser, id: string): Promise<CloudSlot> {
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
    return { id, browser, context, page, manager };
  }

  async acquire(sessionId: string): Promise<PoolSlot> {
    const existing = this.inUse.get(sessionId);
    if (existing) {
      log.debug(sessionId, `Reusing ${this.cfg.name} slot ${existing.id}`);
      return existing;
    }

    this.cfg.requireEnv();
    const { ws, remoteId } = await this.cfg.connect();
    log.info(sessionId, `Connecting to ${this.cfg.name} cloud`);
    let browser: Browser | undefined;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: 30000 });
      const id = remoteId ?? randomUUID();
      const slot = await this.buildSlot(browser, id);
      this.inUse.set(sessionId, slot);
      log.info(sessionId, `Acquired ${this.cfg.name} slot ${id}`);
      return slot;
    } catch (e) {
      // ponytail: never leak a billed remote session — tear down whatever we
      // opened (WS disconnect for Browserless, REST DELETE for Browserbase).
      if (browser) { try { await browser.disconnect(); } catch (_) {} }
      if (remoteId && this.cfg.teardown) { try { await this.cfg.teardown(remoteId); } catch (_) {} }
      throw e;
    }
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.inUse.get(sessionId);
    if (!slot) return;
    this.inUse.delete(sessionId);
    try { await slot.browser.disconnect(); } catch (e) {}
    if (this.cfg.teardown) {
      try {
        await this.cfg.teardown(slot.id);
      } catch (e) {
        log.warn(this.cfg.name, `teardown failed for ${slot.id}: ${(e as Error).message}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const slot of this.inUse.values()) {
      try { await slot.browser.disconnect(); } catch (e) {}
      if (this.cfg.teardown) {
        try { await this.cfg.teardown(slot.id); } catch (e) {}
      }
    }
    this.inUse.clear();
  }

  async getStats(): Promise<PoolStats> {
    const n = this.inUse.size;
    // maxSize: 0 reads as "unlimited" — consistent with MAX_SESSIONS=0.
    return { total: n, available: 0, inUse: n, maxSize: 0, memoryBytes: 0 };
  }

  getMemoryUsageBytes(): Promise<number> {
    return Promise.resolve(0);
  }

  // ponytail: no-op — cloud browsers aren't pooled warm, so there's nothing
  // local to drift out of sync. Each remote session is created on acquire and
  // torn down on release; orphans can't accumulate.
  async killOrphaned(_activeSlotIds: Set<string>): Promise<void> {}
}

function browserbaseConfig(): CloudConfig {
  const API_KEY = process.env.BROWSERBASE_API_KEY || '';
  const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';
  const API_BASE = process.env.BROWSERBASE_API_URL || 'https://api.browserbase.com/v1';
  const CONNECT_HOST = process.env.BROWSERBASE_CONNECT_HOST || 'wss://connect.browserbase.com';

  async function createSession(): Promise<string> {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Browserbase create session failed (${res.status}): ${text}`);
    }
    const data = await res.json() as { id: string };
    return data.id;
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/sessions/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${API_KEY}` },
      });
    } catch (e) {
      log.warn('browserbase', `Failed to delete session ${id}: ${(e as Error).message}`);
    }
  }

  return {
    name: 'browserbase',
    requireEnv: () => {
      if (!API_KEY || !PROJECT_ID) {
        throw new Error('Browserbase requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID');
      }
    },
    connect: async () => {
      const id = await createSession();
      log.info('browserbase', `Created remote session ${id}`);
      return { ws: `${CONNECT_HOST}?apiKey=${API_KEY}&projectId=${PROJECT_ID}&sessionId=${id}`, remoteId: id };
    },
    teardown: deleteSession,
  };
}

function browserlessConfig(): CloudConfig {
  const TOKEN = process.env.BROWSERLESS_TOKEN || '';
  const ENDPOINT = process.env.BROWSERLESS_ENDPOINT || 'wss://production-sfo.browserless.io';
  return {
    name: 'browserless',
    requireEnv: () => {
      if (!TOKEN) throw new Error('Browserless requires BROWSERLESS_TOKEN');
    },
    // ponytail: cloud token connect — no REST session lifecycle; the remote
    // browser is torn down when the WebSocket closes (browser.disconnect()).
    connect: async () => ({ ws: `${ENDPOINT}?token=${TOKEN}` }),
  };
}

export type CloudProvider = 'browserbase' | 'browserless';

export function createCloudService(type: CloudProvider): CloudBrowserService {
  return new CloudBrowserService(type === 'browserbase' ? browserbaseConfig() : browserlessConfig());
}
