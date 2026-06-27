import { LightpandaPool } from './pool.js';
import { ChromePool } from './chrome-pool.js';
import { HeadfulChromePool } from './headful-chrome-pool.js';
import { createCloudService } from './cloud-browser-service.js';
import { ChromeManager } from './chrome.js';
import { log } from './logger.js';
import { SessionHistory } from './history.js';

const RESOURCE_LOGGING_ENABLED = process.env.RESOURCE_LOGGING_ENABLED !== 'false';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '0', 10); // 0 = unlimited

export type FallbackType = 'none' | 'headless' | 'headful' | 'browserbase' | 'browserless';

export const FALLBACK_TYPE: FallbackType = (() => {
  const v = (process.env.FALLBACK_BROWSER || 'none').toLowerCase();
  return (v === 'headless' || v === 'headful' || v === 'browserbase' || v === 'browserless' || v === 'none') ? v : 'none';
})();

export interface PoolSlot {
  id: string;
  manager: ChromeManager;
}

export interface FallbackPool {
  acquire(sessionId: string): Promise<PoolSlot>;
  release(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  getStats(): Promise<PoolStats>;
  killOrphaned(activeSlotIds: Set<string>): Promise<void>;
  getMemoryUsageBytes(): Promise<number>;
}

export interface PoolStats {
  total: number;
  available: number;
  inUse: number;
  maxSize: number;
  memoryBytes: number;
}

interface SessionState {
  onLightpanda: boolean;
  lpInstanceId?: string;
  fallbackSlotId?: string;
  manager: ChromeManager | null;
  lastActiveTime: number;
  history: SessionHistory;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private lpPool: LightpandaPool = new LightpandaPool();
  private fallbackPoolInstance: FallbackPool | null = null;

  getFallbackType(): FallbackType {
    return FALLBACK_TYPE;
  }

  hasFallback(): boolean {
    return FALLBACK_TYPE !== 'none';
  }

  private get fallbackPool(): FallbackPool {
    if (!this.fallbackPoolInstance) {
      this.fallbackPoolInstance = this.createFallbackPool();
    }
    return this.fallbackPoolInstance;
  }

  private createFallbackPool(): FallbackPool {
    switch (FALLBACK_TYPE) {
      case 'headless': return new ChromePool();
      case 'headful': return new HeadfulChromePool();
      case 'browserbase': return createCloudService('browserbase');
      case 'browserless': return createCloudService('browserless');
      default: throw new Error(`No fallback browser configured (FALLBACK_BROWSER=${FALLBACK_TYPE})`);
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async acquire(sessionId: string): Promise<ChromeManager> {
    if (this.sessions.has(sessionId)) {
      return this.ensureConnected(sessionId);
    }

    if (MAX_SESSIONS > 0 && this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Max sessions reached (${MAX_SESSIONS}). Close an existing session first.`);
    }

    const state: SessionState = {
      onLightpanda: true,
      manager: null,
      lastActiveTime: Date.now(),
      history: new SessionHistory(),
    };

    log.info(sessionId, `New session on lightpanda`);
    await this.attachLightpanda(sessionId, state);
    this.sessions.set(sessionId, state);
    return state.manager!;
  }

  // Level 2 switch: detach Lightpanda, attach the configured fallback, replay history.
  async switchToFallback(sessionId: string): Promise<ChromeManager> {
    if (!this.hasFallback()) {
      throw new Error('No fallback browser configured (FALLBACK_BROWSER=none)');
    }
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session ${sessionId} not found`);

    if (!state.onLightpanda) {
      // Already on the fallback pool.
      return this.ensureConnected(sessionId);
    }

    log.info(sessionId, `Switching lightpanda -> fallback (${FALLBACK_TYPE})`);
    await this.detachLightpanda(sessionId, state);
    await this.attachFallback(sessionId, state);
    state.onLightpanda = false;

    await state.history.replay(state.manager!, sessionId);
    log.debug(sessionId, `Replayed history after switching to ${FALLBACK_TYPE}`);
    return state.manager!;
  }

  // Re-acquire from the same layer if the underlying browser died mid-session.
  async ensureConnected(sessionId: string): Promise<ChromeManager> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session ${sessionId} not found`);
    if (state.manager && state.manager.isConnected()) return state.manager;

    log.warn(sessionId, `Manager disconnected, re-acquiring (${state.onLightpanda ? 'lightpanda' : FALLBACK_TYPE})`);
    if (state.onLightpanda) {
      await this.detachLightpanda(sessionId, state);
      await this.attachLightpanda(sessionId, state);
    } else {
      await this.detachFallback(sessionId, state);
      await this.attachFallback(sessionId, state);
    }
    await state.history.replay(state.manager!, sessionId);
    return state.manager!;
  }

  isOnLightpanda(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.onLightpanda ?? true;
  }

  private async attachLightpanda(sessionId: string, state: SessionState): Promise<void> {
    const inst = await this.lpPool.acquire(sessionId);
    state.lpInstanceId = inst.id;
    state.manager = new ChromeManager({ browser: inst.browser, context: inst.context, page: inst.page });
  }

  private async attachFallback(sessionId: string, state: SessionState): Promise<void> {
    const slot = await this.fallbackPool.acquire(sessionId);
    state.fallbackSlotId = slot.id;
    state.manager = slot.manager;
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

  private async detachFallback(sessionId: string, state: SessionState): Promise<void> {
    if (state.manager) {
      try { await state.manager.close(); } catch (e) {}
      state.manager = null;
    }
    if (state.fallbackSlotId) {
      await this.fallbackPool.release(sessionId);
      state.fallbackSlotId = undefined;
    }
  }

  async release(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    log.info(sessionId, `Releasing session`);
    if (state.onLightpanda) {
      await this.detachLightpanda(sessionId, state);
    } else {
      await this.detachFallback(sessionId, state);
    }
    this.sessions.delete(sessionId);
  }

  async releaseAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.release(sessionId);
    }
  }

  touchSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastActiveTime = Date.now();
  }

  getIdleSessionIds(idleTimeoutMs: number): string[] {
    const now = Date.now();
    const idle: string[] = [];
    for (const [sessionId, state] of this.sessions) {
      if (now - state.lastActiveTime > idleTimeoutMs) idle.push(sessionId);
    }
    return idle;
  }

  getActiveSessionIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  private activeFallbackSlotIds(): Set<string> {
    const ids = new Set<string>();
    for (const [, state] of this.sessions) {
      if (!state.onLightpanda && state.fallbackSlotId) ids.add(state.fallbackSlotId);
    }
    return ids;
  }

  private activeLpInstanceIds(): Set<string> {
    const ids = new Set<string>();
    for (const [, state] of this.sessions) {
      if (state.onLightpanda && state.lpInstanceId) ids.add(state.lpInstanceId);
    }
    return ids;
  }

  async purgeOrphanedInstances(_activeSessionIds: Set<string>): Promise<void> {
    await this.lpPool.killOrphaned(this.activeLpInstanceIds());
    if (this.fallbackPoolInstance) {
      await this.fallbackPoolInstance.killOrphaned(this.activeFallbackSlotIds());
    }
  }

  getManager(sessionId: string): ChromeManager | null {
    return this.sessions.get(sessionId)?.manager ?? null;
  }

  getHistory(sessionId: string): SessionHistory | null {
    return this.sessions.get(sessionId)?.history ?? null;
  }

  async shutdown(): Promise<void> {
    await this.releaseAll();
    await this.lpPool.shutdown();
    if (this.fallbackPoolInstance) {
      await this.fallbackPoolInstance.shutdown();
      this.fallbackPoolInstance = null;
    }
  }

  async getStats() {
    const lightpanda = await this.lpPool.getStats();
    const fallback = this.fallbackPoolInstance ? await this.fallbackPoolInstance.getStats() : {
      total: 0, available: 0, inUse: 0, maxSize: 0, memoryBytes: 0,
    };
    return { sessions: this.sessions.size, lightpanda, fallback };
  }

  async logResourceUsage(): Promise<void> {
    if (!RESOURCE_LOGGING_ENABLED) return;
    const stats = await this.getStats();
    const lpMb = (stats.lightpanda.memoryBytes / 1024 / 1024).toFixed(1);
    const fbMb = (stats.fallback.memoryBytes / 1024 / 1024).toFixed(1);
    log.info('resources', `Sessions: ${stats.sessions} (cap ${MAX_SESSIONS || '∞'}) | Lightpanda: ${stats.lightpanda.total} (${lpMb} MB) | Fallback [${FALLBACK_TYPE}]: ${stats.fallback.total} (${fbMb} MB)`);
  }
}
