import { spawn, exec, type ChildProcess } from 'child_process';
import { log } from './logger.js';

export interface DisplayHandle {
  kill(): void;
  display: string;
}

const NOOP_HANDLE: DisplayHandle = { kill: () => {}, display: process.env.DISPLAY || ':0' };

function probeXvfb(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('command -v Xvfb', (err) => resolve(!err));
  });
}

function tryStartXvfb(display: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      proc.removeAllListeners('exit');
      resolve(proc);
    }, 500);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb on ${display} exited immediately (code ${code}); display may be in use`));
    });
  });
}

export async function ensureDisplay(): Promise<DisplayHandle> {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return { kill: () => {}, display: process.env.DISPLAY || ':0' };
  }

  if (process.env.DISPLAY) {
    return { kill: () => {}, display: process.env.DISPLAY };
  }

  const hasXvfb = await probeXvfb();
  if (!hasXvfb) {
    throw new Error('Xvfb not installed. Install with: apt-get install xvfb');
  }

  const candidates = [99, 100, 98, 101, 102, 103];
  let lastErr: Error | null = null;
  for (const n of candidates) {
    const display = `:${n}`;
    try {
      const proc = await tryStartXvfb(display);
      process.env.DISPLAY = display;
      log.info('xvfb', `Started Xvfb on ${display}`);
      return {
        kill: () => {
          try { proc.kill('SIGTERM'); } catch {}
        },
        display,
      };
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw new Error(`Failed to start Xvfb on any candidate display: ${lastErr?.message || 'unknown error'}`);
}
