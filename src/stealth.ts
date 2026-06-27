import type { Page } from 'puppeteer';

const STEALTH_ENABLED = process.env.STEALTH_ENABLED !== 'false';
const HUMAN_DELAYS_ENABLED = process.env.HUMAN_DELAYS_ENABLED !== 'false';

// ponytail: removed the stale Chrome 124/125 UA pool — Reddit's "whoa there,
// pardner" block flags spoofed/alternate UAs. By default we now send Chrome's
// real UA. Set USER_AGENT to force an override for sites that need one.

const VIEWPORT_POOL = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
];

export interface StealthConfig {
  userAgent: string | null;
  viewport: { width: number; height: number };
  typingDelay: { min: number; max: number };
  clickDelay: { min: number; max: number };
}

function getRandomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getStealthConfig(): StealthConfig {
  const userAgent = process.env.USER_AGENT || null;
  const viewport = getRandomElement(VIEWPORT_POOL);

  return {
    userAgent,
    viewport,
    typingDelay: { min: 50, max: 150 },
    clickDelay: { min: 100, max: 300 },
  };
}

export function getAntiDetectionArgs(headless: boolean = true): string[] {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
  ];

  if (headless) {
    args.push('--disable-gpu');
  }

  const proxy = process.env.PROXY_SERVER;
  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  return args;
}

export async function applyStealthToPage(page: Page): Promise<void> {
  if (!STEALTH_ENABLED) return;

  const config = getStealthConfig();

  if (config.userAgent) {
    await page.setUserAgent(config.userAgent);
  }
  await page.setViewport(config.viewport);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });
  });
}

export function isStealthEnabled(): boolean {
  return STEALTH_ENABLED;
}

export function isHumanDelaysEnabled(): boolean {
  return HUMAN_DELAYS_ENABLED;
}

export function getRandomTypingDelay(): number {
  const config = getStealthConfig();
  return getRandomInt(config.typingDelay.min, config.typingDelay.max);
}

export function getRandomClickDelay(): number {
  const config = getStealthConfig();
  return getRandomInt(config.clickDelay.min, config.clickDelay.max);
}

export async function applyLightpandaStealth(page: Page): Promise<void> {
  if (!STEALTH_ENABLED) return;

  const config = getStealthConfig();

  if (config.userAgent) {
    await page.setUserAgent(config.userAgent);
  }
  await page.setViewport(config.viewport);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });
  });
}
