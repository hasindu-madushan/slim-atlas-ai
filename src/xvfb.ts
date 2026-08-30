import { log } from './logger.js';

export interface DisplayHandle {
  kill(): void;
  display: string;
}

const NOOP_HANDLE: DisplayHandle = { kill: () => {}, display: process.env.DISPLAY || ':0' };

async function probeXvfb(): Promise<boolean> {
  try {
    // ponytail: `which`, not `command -v` — Bun's shell has no `command` builtin.
    const { exitCode } = await Bun.$`which Xvfb`.quiet();
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function tryStartXvfb(display: string): Promise<any> {
  const proc = Bun.spawn(['Xvfb', display, '-screen', '0', '1920x1080x24'], { stdio: ['ignore', 'ignore', 'ignore'] });
  await Bun.sleep(500);
  if (proc.killed || proc.exitCode !== null) {
    throw new Error(`Xvfb on ${display} exited immediately; display may be in use`);
  }
  return proc;
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
          // We set DISPLAY for this Xvfb; clear it so a later relaunch
          // doesn't skip Xvfb startup against the now-dead display.
          if (process.env.DISPLAY === display) delete process.env.DISPLAY;
        },
        display,
      };
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw new Error(`Failed to start Xvfb on any candidate display: ${lastErr?.message || 'unknown error'}`);
}
