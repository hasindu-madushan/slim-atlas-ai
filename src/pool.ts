import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'fs';
import { log } from './logger.js';
import { applyLightpandaStealth } from './stealth.js';

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
  const args = [
    'serve', '--log_level', 'warn',
    '--host', '127.0.0.1', '--port', port.toString(), '--timeout', '86400',
  ];
  if (proxy) args.push('--http-proxy', proxy);
  return args;
}

interface LightpandaInstance {
  id: string;
  port: number;
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
  private waitQueue: Array<(instance: LightpandaInstance) => void> = [];
  private nextPort = BASE_PORT;

  async acquire(sessionId: string): Promise<LightpandaInstance> {
    if (this.inUse.has(sessionId)) {
      log.debug(sessionId, `Reusing existing Lightpanda instance`);
      return this.inUse.get(sessionId)!;
    }

    while (this.available.length > 0) {
      const instance = this.available.pop()!;
      const alive = !instance.process.killed && instance.process.exitCode === null && instance.browser.connected;
      if (alive) {
        log.info(sessionId, `Acquired Lightpanda instance ${instance.id} (port ${instance.port})`);
        this.inUse.set(sessionId, instance);
        return instance;
      }
      log.warn(sessionId, `Lightpanda instance ${instance.id} is dead, removing`);
      const idx = this.instances.findIndex(i => i.id === instance.id);
      if (idx >= 0) this.instances.splice(idx, 1);
      try { instance.browser?.disconnect(); } catch (e) {}
      try { instance.process.kill('SIGKILL'); } catch (e) {}
    }

    if (this.instances.length < MAX_SIZE) {
      log.info(sessionId, `Spawning new Lightpanda instance (port ${this.nextPort})`);
      const instance = await this.spawnInstance();
      this.instances.push(instance);
      this.inUse.set(sessionId, instance);
      return instance;
    }

    log.warn(sessionId, `All Lightpanda instances in use, waiting`);
    return new Promise((resolve) => {
      this.waitQueue.push((instance) => {
        log.info(sessionId, `Got Lightpanda instance ${instance.id} from wait queue`);
        this.inUse.set(sessionId, instance);
        resolve(instance);
      });
    });
  }

  async release(sessionId: string): Promise<void> {
    const instance = this.inUse.get(sessionId);
    if (!instance) return;
    this.inUse.delete(sessionId);

    try {
      const newInstance = await this.recycleInstance(instance);
      if (!newInstance) return;

      if (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift()!;
        next(newInstance);
      } else {
        this.available.push(newInstance);
      }
    } catch (e) {
      console.error(`[pool] Failed to recycle ${instance.id}:`, (e as Error).message);
    }
  }

  private async recycleInstance(instance: LightpandaInstance): Promise<LightpandaInstance | null> {
    try { await instance.page?.close(); } catch (e) {}
    try { await instance.context?.close(); } catch (e) {}
    try { instance.browser?.disconnect(); } catch (e) {}
    try { instance.process.kill('SIGKILL'); } catch (e) {}
    await killPort(instance.port);

    try {
      const newInstance = await this.spawnInstanceOnPort(instance.port);
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

  private async spawnInstance(): Promise<LightpandaInstance> {
    const port = this.nextPort++;
    return this.spawnInstanceOnPort(port);
  }

  private async spawnInstanceOnPort(port: number): Promise<LightpandaInstance> {
    const id = `lp-${port}`;
    const lightpandaPath = path.join(__dirname, '..', 'lightpanda');

    if (!existsSync(lightpandaPath)) {
      await ensureLightpanda();
    }

    await killPort(port);
    await Bun.sleep(200);

    log.info('pool', `Spawning Lightpanda ${id} on port ${port}`);
    // Lightpanda's --http-proxy supports inline basic auth (user:pass@host:port),
    // verified against an authenticated proxy; credentials pass through untouched.
    const proc = Bun.spawn([lightpandaPath, ...buildLightpandaServeArgs(port, process.env.PROXY_SERVER)], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.exited.then((code) => {
      log.warn('pool', `${id} exited with code ${code}`);
      const inst = this.instances.find(i => i.id === id);
      if (inst) inst.ready = false;
    });

    await Bun.sleep(1000);

    const wsEndpoint = `ws://127.0.0.1:${port}`;
    let browser: any = null;
    for (let i = 0; i < 15; i++) {
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, protocolTimeout: 30000 });
        log.info('pool', `${id} connected`);
        break;
      } catch (e) {
        await Bun.sleep(200);
      }
    }

    if (!browser) {
      proc.kill('SIGKILL');
      throw new Error(`Failed to connect to lightpanda on port ${port}`);
    }

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await applyLightpandaStealth(page);
    } catch (e) {
      log.warn('pool', `${id} stealth setup failed: ${(e as Error).message}`);
    }

    return { id, port, process: proc, browser, context, page, ready: true };
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
