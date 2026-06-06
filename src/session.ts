import { LightpandaPool } from './pool.js';
import { ChromePool } from './chrome-pool.js';
import { ChromeManager } from './chrome.js';
import type { NavigateOptions, PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';

const CHROME_ENABLED = process.env.CHROME_ENABLED !== 'false';

export type BrowserType = 'lightpanda' | 'chrome';

interface SessionState {
  browserType: BrowserType;
  preferChrome: boolean;
  queue: Promise<void>;
  lpInstanceId?: string;
  chromeSlotId?: string;
  manager: ChromeManager | null;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private lpPool: LightpandaPool;
  private chromePool: ChromePool;

  constructor() {
    this.lpPool = new LightpandaPool();
    this.chromePool = new ChromePool();
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async acquire(sessionId: string, preferChrome = false): Promise<ChromeManager> {
    let state = this.sessions.get(sessionId);

    if (state && state.manager) {
      if ((preferChrome || state.preferChrome) && state.browserType === 'lightpanda' && CHROME_ENABLED) {
        await this.switchToChrome(sessionId, state);
      }
      return state.manager;
    }

    state = {
      browserType: preferChrome && CHROME_ENABLED ? 'chrome' : 'lightpanda',
      preferChrome: preferChrome && CHROME_ENABLED,
      queue: Promise.resolve(),
      manager: null,
    };

    if (state.browserType === 'chrome') {
      await this.attachChrome(sessionId, state);
    } else {
      try {
        await this.attachLightpanda(sessionId, state);
      } catch (e: any) {
        console.error(`[session:${sessionId}] Lightpanda failed: ${e.message}, falling back to Chrome`);
        if (CHROME_ENABLED) {
          state.preferChrome = true;
          state.browserType = 'chrome';
          if (state.lpInstanceId) {
            this.lpPool.release(sessionId);
            state.lpInstanceId = undefined;
          }
          await this.attachChrome(sessionId, state);
        } else {
          throw e;
        }
      }
    }

    this.sessions.set(sessionId, state);
    return state.manager!;
  }

  private async attachLightpanda(sessionId: string, state: SessionState): Promise<void> {
    const lpInstance = await this.lpPool.acquire(sessionId);
    state.lpInstanceId = lpInstance.id;
    state.manager = new ChromeManager({ browser: lpInstance.browser, context: lpInstance.context, page: lpInstance.page });
  }

  private async attachChrome(sessionId: string, state: SessionState): Promise<void> {
    const slot = await this.chromePool.acquire(sessionId);
    state.chromeSlotId = slot.id;
    state.manager = slot.manager;
  }

  private async switchToChrome(sessionId: string, state: SessionState): Promise<void> {
    console.error(`[session] ${sessionId} switching from lightpanda to Chrome`);
    state.preferChrome = true;
    state.browserType = 'chrome';

    if (state.lpInstanceId) {
      await this.detachLightpanda(sessionId, state);
    }

    await this.attachChrome(sessionId, state);
  }

  private async detachLightpanda(sessionId: string, state: SessionState): Promise<void> {
    if (state.manager) {
      try { await state.manager.close(); } catch (e) {}
      state.manager = null;
    }
    if (state.lpInstanceId) {
      this.lpPool.release(sessionId);
      state.lpInstanceId = undefined;
    }
  }

  async release(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (state.manager) {
      try { await state.manager.close(); } catch (e) {}
    }

    if (state.browserType === 'lightpanda' && state.lpInstanceId) {
      this.lpPool.release(sessionId);
    } else if (state.browserType === 'chrome' && state.chromeSlotId) {
      this.chromePool.release(sessionId);
    }

    this.sessions.delete(sessionId);
  }

  async releaseAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.release(sessionId);
    }
  }

  markPreferChrome(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.preferChrome = true;
  }

  shouldPreferChrome(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.preferChrome ?? false;
  }

  getManager(sessionId: string): ChromeManager | null {
    return this.sessions.get(sessionId)?.manager ?? null;
  }

  getBrowserType(sessionId: string): BrowserType | null {
    return this.sessions.get(sessionId)?.browserType ?? null;
  }

  async shutdown(): Promise<void> {
    await this.releaseAll();
    await this.lpPool.shutdown();
    await this.chromePool.shutdown();
  }

  getStats() {
    return {
      sessions: this.sessions.size,
      lightpanda: this.lpPool.getStats(),
      chrome: this.chromePool.getStats(),
    };
  }
}
