import { spawn, ChildProcess, exec } from 'child_process';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'fs';
import { log } from './logger.js';
import { applyLightpandaStealth } from './stealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIGHTPANDA_PATH = path.join(__dirname, '..', 'lightpanda');

// ponytail: platform→asset map. Asset naming is identical across nightly + stable tags,
// so any LIGHTPANDA_VERSION resolves via the same URL shape. Add a new tuple here only
// when lightpanda-io ships a new target.
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

// Fetches the binary into place if missing. Idempotent — no-op when the file already
// exists (e.g. Docker baked it in, or a previous run succeeded). Buffers the ~60MB
// asset in memory once at startup; fine for a server, avoids stream/edge runtime drift.
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
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${LIGHTPANDA_PATH}.tmp`;
  try {
    writeFileSync(tmp, buf);
    chmodSync(tmp, 0o755);
    renameSync(tmp, LIGHTPANDA_PATH); // atomic move → never leaves a corrupt half-binary
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ponytail: best-effort cleanup */ }
    throw err;
  }
  log.info('pool', `Lightpanda ${version} installed (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

const BASE_PORT = parseInt(process.env.LIGHTPANDA_BASE_PORT || '9222', 10);
const MAX_SIZE = parseInt(process.env.LIGHTPANDA_POOL_SIZE || '5', 10);

// ponytail: pure builder so spawn args are unit-testable without launching the binary.
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
  process: ChildProcess;
  browser: any;
  context: any;
  page: any;
  ready: boolean;
}

function killPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`lsof -i :${port} -t | xargs kill -9 2>/dev/null`, () => resolve());
  });
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`lsof -i :${port} -t`, (err, stdout) => {
      resolve(!!stdout && stdout.trim().length > 0);
    });
  });
}

function getProcessMemoryBytes(pid: number): Promise<number> {
  return new Promise((resolve) => {
    exec(`ps -p ${pid} -o rss=`, (err, stdout) => {
      if (err) return resolve(0);
      const kb = parseInt(stdout.trim(), 10);
      resolve(isNaN(kb) ? 0 : kb * 1024);
    });
  });
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
    await new Promise((r) => setTimeout(r, 200));

    log.info('pool', `Spawning Lightpanda ${id} on port ${port}`);
    const proc = spawn(lightpandaPath, buildLightpandaServeArgs(port, process.env.PROXY_SERVER), { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.on('error', (err) => log.error('pool', `${id} error: ${err.message}`));
    proc.on('exit', (code) => {
      log.warn('pool', `${id} exited with code ${code}`);
      const inst = this.instances.find(i => i.id === id);
      if (inst) inst.ready = false;
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const wsEndpoint = `ws://127.0.0.1:${port}`;
    let browser: any = null;
    for (let i = 0; i < 15; i++) {
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, protocolTimeout: 30000 });
        log.info('pool', `${id} connected`);
        break;
      } catch (e) {
        await new Promise((resolve) => setTimeout(resolve, 200));
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
