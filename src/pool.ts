import { spawn, ChildProcess, exec } from 'child_process';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { log } from './logger.js';
import { applyLightpandaStealth } from './stealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_PORT = parseInt(process.env.LIGHTPANDA_BASE_PORT || '9222', 10);
const MAX_SIZE = parseInt(process.env.LIGHTPANDA_POOL_SIZE || '5', 10);

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

  release(sessionId: string): void {
    const instance = this.inUse.get(sessionId);
    if (!instance) return;
    this.inUse.delete(sessionId);

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next(instance);
    } else {
      this.recycleInstance(instance);
    }
  }

  private async recycleInstance(instance: LightpandaInstance): Promise<void> {
    try { await instance.page?.close(); } catch (e) {}
    try { await instance.context?.close(); } catch (e) {}
    try { instance.browser?.disconnect(); } catch (e) {}
    try { instance.process.kill('SIGKILL'); } catch (e) {}
    await killPort(instance.port);

    try {
      const newInstance = await this.spawnInstanceOnPort(instance.port);
      const idx = this.instances.findIndex(i => i.id === instance.id);
      if (idx >= 0) this.instances[idx] = newInstance;
      this.available.push(newInstance);
    } catch (e) {
      console.error(`[pool] Failed to recycle ${instance.id}:`, (e as Error).message);
      const idx = this.instances.findIndex(i => i.id === instance.id);
      if (idx >= 0) this.instances.splice(idx, 1);
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
      throw new Error(`Lightpanda binary not found at ${lightpandaPath}. Run browser_install first.`);
    }

    await killPort(port);
    await new Promise((r) => setTimeout(r, 200));

    log.info('pool', `Spawning Lightpanda ${id} on port ${port}`);
    const proc = spawn(lightpandaPath, [
      'serve', '--log_level', 'warn',
      '--host', '127.0.0.1', '--port', port.toString(), '--timeout', '86400',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

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
