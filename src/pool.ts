import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'fs';
import { log } from './logger.js';
import { applyLightpandaStealth, getProxyConfig } from './stealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIGHTPANDA_PATH = path.join(__dirname, '..', 'lightpanda');

function lightpandaAsset(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'lightpanda-aarch64-macos';
    if (arch === 'x64') return 'lightpanda-x86_64-macos';
  } else if (platform === 'linux') {
    if (arch === 'arm64') return 'lightpanda-aarch64-linux';
    if (arch === 'x64') return 'lightpanda-x86_64-linux';
  }
  throw new Error(`Unsupported platform for Lightpanda: ${platform}/${arch}. Set LIGHTPANDA_PATH or download manually.`);
}

export async function ensureLightpanda(): Promise<void> {
  if (existsSync(LIGHTPANDA_PATH)) return;

  const version = process.env.LIGHTPANDA_VERSION || 'nightly';
  const asset = lightpandaAsset();
  const url = `https://github.com/lightpanda-io/browser/releases/download/${version}/${asset}`;

  log.info('pool', `Downloading Lightpanda ${version} from ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download Lightpanda (${res.status} ${res.statusText}) from ${url}`);
  }
  const tmp = `${LIGHTPANDA_PATH}.tmp`;
  try {
    await Bun.write(tmp, res);
    chmodSync(tmp, 0o755);
    renameSync(tmp, LIGHTPANDA_PATH);
  } catch (err) {
    try { unlinkSync(tmp); } catch { }
    throw err;
  }
  const stat = existsSync(LIGHTPANDA_PATH) ? 0 : 0;
  log.info('pool', `Lightpanda ${version} installed`);
}

const BASE_PORT = parseInt(process.env.LIGHTPANDA_BASE_PORT || '9222', 10);
const MAX_SIZE = parseInt(process.env.LIGHTPANDA_POOL_SIZE || '5', 10);

export function buildLightpandaServeArgs(port: number, proxy?: string): string[] {
  // No --timeout: newer nightly lightpanda builds (observed on x86_64) reject it with
  // a fatal "unknown argument"; instance lifetime is managed by the pool anyway.
  const args = [
    'serve', '--log_level', 'warn',
    '--host', '127.0.0.1', '--port', port.toString(),
  ];
  if (proxy) args.push('--http-proxy', proxy);
  return args;
}

interface LightpandaInstance {
  id: string;
  port: number;
  proxied: boolean;  // false = direct instance for PROXY_BYPASS_DOMAINS traffic
  process: any;
  browser: any;
  context: any;
  page: any;
  ready: boolean;
}

async function killPort(port: number): Promise<void> {
  const result = await Bun.$`lsof -i :${port} -t`.quiet().text().catch(() => '');
  const pids = result.trim().split('\n').filter(Boolean);
  for (const pid of pids) {
    try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch {}
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  const result = await Bun.$`lsof -i :${port} -t`.quiet().text().catch(() => '');
  return result.trim().length > 0;
}

async function getProcessMemoryBytes(pid: number): Promise<number> {
  const result = await Bun.$`ps -p ${pid} -o rss=`.quiet().text().catch(() => '');
  const kb = parseInt(result.trim(), 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export class LightpandaPool {
  private instances: LightpandaInstance[] = [];
  private available: LightpandaInstance[] = [];
  private inUse: Map<string, LightpandaInstance> = new Map();
  private waitQueue: Array<{ direct: boolean; handoff: (instance: LightpandaInstance) => void }> = [];
  private nextPort = BASE_PORT;
  // Concurrent acquires can each pass the size check before any spawn finishes
  // (await gaps), overshooting MAX_SIZE — count in-flight spawns against the cap.
  private pendingSpawns = 0;

  async acquire(sessionId: string, direct = false): Promise<LightpandaInstance> {
    if (this.inUse.has(sessionId)) {
      log.debug(sessionId, `Reusing existing Lightpanda instance`);
      return this.inUse.get(sessionId)!;
    }

    const matchesType = (inst: LightpandaInstance) => inst.proxied !== direct;
    const alive = (inst: LightpandaInstance) =>
      !inst.process.killed && inst.process.exitCode === null && inst.browser.connected;

    // Prefer a live instance of the right type (proxied vs direct).
    const readyIdx = this.available.findIndex(inst => matchesType(inst) && alive(inst));
    if (readyIdx >= 0) {
      const instance = this.available.splice(readyIdx, 1)[0];
      log.info(sessionId, `Acquired ${instance.proxied ? 'proxied' : 'direct'} Lightpanda instance ${instance.id} (port ${instance.port})`);
      this.inUse.set(sessionId, instance);
      return instance;
    }

    // Drop dead instances of any type while we are here.
    for (let i = this.available.length - 1; i >= 0; i--) {
      const inst = this.available[i];
      if (!alive(inst)) {
        log.warn(sessionId, `Lightpanda instance ${inst.id} is dead, removing`);
        const idx = this.instances.findIndex(x => x.id === inst.id);
        if (idx >= 0) this.instances.splice(idx, 1);
        try { inst.browser?.disconnect(); } catch (e) {}
        try { inst.process.kill('SIGKILL'); } catch (e) {}
        this.available.splice(i, 1);
      }
    }

    if (this.instances.length + this.pendingSpawns < MAX_SIZE) {
      log.info(sessionId, `Spawning new ${direct ? 'direct' : 'proxied'} Lightpanda instance (port ${this.nextPort})`);
      this.pendingSpawns++;
      try {
        const instance = await this.spawnInstance(!direct);
        this.instances.push(instance);
        this.inUse.set(sessionId, instance);
        return instance;
      } finally {
        this.pendingSpawns--;
      }
    }

    log.warn(sessionId, `All Lightpanda instances in use, waiting`);
    return new Promise((resolve) => {
      this.waitQueue.push({ direct, handoff: (instance) => {
        log.info(sessionId, `Got Lightpanda instance ${instance.id} from wait queue`);
        this.inUse.set(sessionId, instance);
        resolve(instance);
      }});
    });
  }

  async release(sessionId: string): Promise<void> {
    const instance = this.inUse.get(sessionId);
    if (!instance) return;
    this.inUse.delete(sessionId);

    try {
      // Fast path: reuse the SAME lightpanda process with a fresh page. Killing and
      // respawning per release (lsof + spawn per page read) generated enough process
      // churn to freeze the whole runtime under load — reserve full respawns for
      // instances that fail the page refresh.
      const newInstance = await this.refreshInstance(instance);

      // Hand off to a waiter that wants this instance's type (proxied/direct);
      // otherwise return it to the available list.
      const waiterIdx = this.waitQueue.findIndex(w => w.direct !== newInstance.proxied);
      if (waiterIdx >= 0) {
        const waiter = this.waitQueue.splice(waiterIdx, 1)[0];
        waiter.handoff(newInstance);
      } else {
        this.available.push(newInstance);
      }
    } catch (e) {
      console.error(`[pool] Failed to refresh ${instance.id}:`, (e as Error).message);
      // Refresh failed — fall back to the old kill-and-respawn path, and drop the
      // instance entirely if that fails too.
      try {
        const recycled = await this.recycleInstance(instance);
        if (!recycled) return;
        const waiterIdx = this.waitQueue.findIndex(w => w.direct !== recycled.proxied);
        if (waiterIdx >= 0) {
          const waiter = this.waitQueue.splice(waiterIdx, 1)[0];
          waiter.handoff(recycled);
        } else {
          this.available.push(recycled);
        }
      } catch (e2) {
        console.error(`[pool] Failed to recycle ${instance.id}:`, (e2 as Error).message);
      }
    }
  }

  // Fresh page/context on the same lightpanda browser. Keeps the proxied flag and
  // port; returns a new instance object with the swapped page.
  private async refreshInstance(instance: LightpandaInstance): Promise<LightpandaInstance> {
    const alive = !instance.process.killed && instance.process.exitCode === null && instance.browser?.connected;
    if (!alive) throw new Error(`${instance.id} is not alive`);

    try { await instance.page?.close(); } catch (e) {}
    try { await instance.context?.close(); } catch (e) {}
    const context = await instance.browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await applyLightpandaStealth(page);
    } catch (e) {
      log.warn('pool', `${instance.id} stealth setup failed: ${(e as Error).message}`);
    }
    return { ...instance, context, page, ready: true };
  }

  private async recycleInstance(instance: LightpandaInstance): Promise<LightpandaInstance | null> {
    try { await instance.page?.close(); } catch (e) {}
    try { await instance.context?.close(); } catch (e) {}
    try { instance.browser?.disconnect(); } catch (e) {}
    try { instance.process.kill('SIGKILL'); } catch (e) {}
    await killPort(instance.port);

    try {
      const newInstance = await this.spawnInstanceOnPort(instance.port, instance.proxied);
      const idx = this.instances.findIndex(i => i.id === instance.id);
      if (idx >= 0) this.instances[idx] = newInstance;
      return newInstance;
    } catch (e) {
      console.error(`[pool] Failed to recycle ${instance.id}:`, (e as Error).message);
      const idx = this.instances.findIndex(i => i.id === instance.id);
      if (idx >= 0) this.instances.splice(idx, 1);
      return null;
    }
  }

  private async spawnInstance(proxied = true): Promise<LightpandaInstance> {
    const port = this.nextPort++;
    return this.spawnInstanceOnPort(port, proxied);
  }

  private async spawnInstanceOnPort(port: number, proxied = true): Promise<LightpandaInstance> {
    const id = `lp-${port}`;
    const lightpandaPath = path.join(__dirname, '..', 'lightpanda');

    if (!existsSync(lightpandaPath)) {
      await ensureLightpanda();
    }

    await killPort(port);
    await Bun.sleep(200);

    log.info('pool', `Spawning Lightpanda ${id} on port ${port} (${proxied ? 'proxied' : 'direct'})`);
    // Lightpanda's --http-proxy supports inline basic auth (user:pass@host:port),
    // verified against an authenticated proxy; getProxyConfig normalizes the
    // host:port:user:pass dashboard form. Direct instances (PROXY_BYPASS_DOMAINS
    // traffic) spawn without the flag — the proxy is process-wide per instance.
    // stdio ignore: pipes nobody reads fill up and can stall the child under load.
    const proc = Bun.spawn([lightpandaPath, ...buildLightpandaServeArgs(port, proxied ? getProxyConfig()?.fullUrl : undefined)], { stdio: ['ignore', 'ignore', 'ignore'] });

    proc.exited.then((code) => {
      log.warn('pool', `${id} exited with code ${code}`);
      const inst = this.instances.find(i => i.id === id);
      if (inst) inst.ready = false;
    });

    // A spawn that never settles (observed under load: no connect success, no exit,
    // whole MCP server unresponsive behind it) must be bounded hard: kill the child,
    // free the port, and let the caller fail. One bad instance never wedges the server.
    const SPAWN_TIMEOUT_MS = 30_000;
    let spawnSettled = false;
    let spawnTimer: any;
    const spawnPromise = (async (): Promise<LightpandaInstance> => {
      await Bun.sleep(1000);

      const wsEndpoint = `ws://127.0.0.1:${port}`;
      let browser: any = null;
      for (let i = 0; i < 15; i++) {
        if (proc.exitCode !== null) {
          throw new Error(`Lightpanda ${id} exited during startup (code ${proc.exitCode})`);
        }
        try {
          browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, protocolTimeout: 30000 });
          log.info('pool', `${id} connected`);
          break;
        } catch (e) {
          await Bun.sleep(200);
        }
      }

      if (!browser) {
        throw new Error(`Failed to connect to lightpanda on port ${port}`);
      }

      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      try {
        await applyLightpandaStealth(page);
      } catch (e) {
        log.warn('pool', `${id} stealth setup failed: ${(e as Error).message}`);
      }

      return { id, port, proxied, process: proc, browser, context, page, ready: true };
    })().then((instance) => {
      if (spawnSettled) {
        // Lost the race to the timeout guard — clean up the late arrival.
        try { instance.browser?.disconnect(); } catch (e) {}
        try { instance.process.kill('SIGKILL'); } catch (e) {}
        throw new Error(`Lightpanda ${id} finished after its spawn timeout`);
      }
      return instance;
    });
    const timeoutGuard = new Promise<never>((_, reject) => {
      spawnTimer = setTimeout(() => {
        spawnSettled = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
        killPort(port).catch(() => {});
        reject(new Error(`Lightpanda ${id} did not become ready within ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);
    });

    try {
      return await Promise.race([spawnPromise, timeoutGuard]);
    } finally {
      clearTimeout(spawnTimer);
    }
  }

  async shutdown(): Promise<void> {
    for (const instance of this.instances) {
      try { await instance.page?.close(); } catch (e) {}
      try { await instance.context?.close(); } catch (e) {}
      try { instance.browser?.disconnect(); } catch (e) {}
      try { instance.process.kill('SIGKILL'); } catch (e) {}
      await killPort(instance.port);
    }
    this.instances = [];
    this.available = [];
    this.inUse.clear();
    this.waitQueue = [];
  }

  async getStats() {
    const memoryBytes = await this.getMemoryUsageBytes();
    return {
      total: this.instances.length,
      available: this.available.length,
      inUse: this.inUse.size,
      maxSize: MAX_SIZE,
      memoryBytes,
    };
  }

  async getMemoryUsageBytes(): Promise<number> {
    let total = 0;
    for (const inst of this.instances) {
      if (inst.process.pid) {
        total += await getProcessMemoryBytes(inst.process.pid);
      }
    }
    return total;
  }

  async killOrphaned(activeInstanceIds: Set<string>): Promise<void> {
    const toKill = this.available.filter(inst => !activeInstanceIds.has(inst.id));
    this.available = this.available.filter(inst => activeInstanceIds.has(inst.id));

    for (const inst of toKill) {
      log.info('pool', `Killing orphaned Lightpanda instance ${inst.id} (port ${inst.port})`);
      const idx = this.instances.findIndex(i => i.id === inst.id);
      if (idx >= 0) this.instances.splice(idx, 1);
      try { await inst.page?.close(); } catch (e) {}
      try { await inst.context?.close(); } catch (e) {}
      try { inst.browser?.disconnect(); } catch (e) {}
      try { inst.process.kill('SIGKILL'); } catch (e) {}
      await killPort(inst.port);
    }
  }
}
