import { LightpandaPool } from './pool.js';
import { ChromePool } from './chrome-pool.js';
import { ChromeManager } from './chrome.js';
import { log } from './logger.js';
import { SessionHistory } from './history.js';
import type { NavigateOptions, PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';

const CHROME_ENABLED = process.env.CHROME_ENABLED !== 'false';
const RESOURCE_LOGGING_ENABLED = process.env.RESOURCE_LOGGING_ENABLED !== 'false';

export type BrowserType = 'lightpanda' | 'chrome';

interface SessionState {
  browserType: BrowserType;
  preferChrome: boolean;
  queue: Promise<void>;
  lpInstanceId?: string;
  chromeSlotId?: string;
  manager: ChromeManager | null;
  lastActiveTime: number;
  history: SessionHistory;
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
        log.info(sessionId, `Existing session, switching from lightpanda to Chrome`);
        await this.switchToChrome(sessionId, state);
      }
      return state.manager;
    }

    state = {
      browserType: preferChrome && CHROME_ENABLED ? 'chrome' : 'lightpanda',
      preferChrome: preferChrome && CHROME_ENABLED,
      queue: Promise.resolve(),
      manager: null,
      lastActiveTime: Date.now(),
      history: new SessionHistory(),
    };

    log.info(sessionId, `New session, browser=${state.browserType}`);

    if (state.browserType === 'chrome') {
      await this.attachChrome(sessionId, state);
    } else {
      try {
        await this.attachLightpanda(sessionId, state);
      } catch (e: any) {
        log.warn(sessionId, `Lightpanda failed: ${e.message}, falling back to Chrome`);
        if (CHROME_ENABLED) {
          state.preferChrome = true;
          state.browserType = 'chrome';
          if (state.lpInstanceId) {
            await this.lpPool.release(sessionId);
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
    log.info(sessionId, `Switching from lightpanda to Chrome`);
    state.preferChrome = true;
    state.browserType = 'chrome';

    if (state.lpInstanceId) {
      await this.detachLightpanda(sessionId, state);
    }

    await this.attachChrome(sessionId, state);

    if (state.manager) {
      await state.history.replay(state.manager, sessionId);
      log.debug(sessionId, `Replayed history after switching to Chrome`);
    }
  }

  private async detachLightpanda(sessionId: string, state: SessionState): Promise<void> {
    if (state.manager) {
      try { await state.manager.close(); } catch (e) {}
      state.manager = null;
    }
    if (state.lpInstanceId) {
      await this.lpPool.release(sessionId);
      state.lpInstanceId = undefined;
    }
  }

  async release(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    log.info(sessionId, `Releasing session`);

    if (state.browserType === 'lightpanda' && state.lpInstanceId) {
      await this.lpPool.release(sessionId);
    } else if (state.browserType === 'chrome' && state.chromeSlotId) {
      await this.chromePool.release(sessionId);
    } else if (state.manager) {
      // Fallback for any session not backed by a pool slot
      try { await state.manager.close(); } catch (e) {}
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

  touchSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastActiveTime = Date.now();
  }

  getIdleSessionIds(idleTimeoutMs: number): string[] {
    const now = Date.now();
    const idle: string[] = [];
    for (const [sessionId, state] of this.sessions) {
      if (now - state.lastActiveTime > idleTimeoutMs) {
        idle.push(sessionId);
      }
    }
    return idle;
  }

  getActiveSessionIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  async purgeOrphanedInstances(activeSessionIds: Set<string>): Promise<void> {
    const activeLpIds = new Set<string>();
    for (const [sessionId, state] of this.sessions) {
      if (activeSessionIds.has(sessionId) && state.lpInstanceId) {
        activeLpIds.add(state.lpInstanceId);
      }
    }
    await this.lpPool.killOrphaned(activeLpIds);

    const activeChromeIds = new Set<string>();
    for (const [sessionId, state] of this.sessions) {
      if (activeSessionIds.has(sessionId) && state.chromeSlotId) {
        activeChromeIds.add(state.chromeSlotId);
      }
    }
    await this.chromePool.killOrphaned(activeChromeIds);
  }

  getManager(sessionId: string): ChromeManager | null {
    return this.sessions.get(sessionId)?.manager ?? null;
  }

  getHistory(sessionId: string): SessionHistory | null {
    return this.sessions.get(sessionId)?.history ?? null;
  }

  getBrowserType(sessionId: string): BrowserType | null {
    return this.sessions.get(sessionId)?.browserType ?? null;
  }

  async shutdown(): Promise<void> {
    await this.releaseAll();
    await this.lpPool.shutdown();
    await this.chromePool.shutdown();
  }

  async getStats() {
    return {
      sessions: this.sessions.size,
      lightpanda: await this.lpPool.getStats(),
      chrome: await this.chromePool.getStats(),
    };
  }

  async logResourceUsage(): Promise<void> {
    if (!RESOURCE_LOGGING_ENABLED) return;
    const stats = await this.getStats();
    const lpMb = (stats.lightpanda.memoryBytes / 1024 / 1024).toFixed(1);
    const chromeMb = (stats.chrome.memoryBytes / 1024 / 1024).toFixed(1);
    log.info('resources', `Sessions: ${stats.sessions} | Lightpanda: ${stats.lightpanda.total} instances (${lpMb} MB) | Chrome: ${stats.chrome.total} instances (${chromeMb} MB)`);
  }
}
