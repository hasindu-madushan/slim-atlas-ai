import type { Page } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const STEALTH_ENABLED = process.env.STEALTH_ENABLED !== 'false';
const HUMAN_DELAYS_ENABLED = process.env.HUMAN_DELAYS_ENABLED !== 'false';

// Real browser, real UA: the plugin's user-agent-override evasion rewrites the UA to a
// Windows profile while the underlying build is Linux; risk engines flag the mismatch
// (Reddit walls it). Everything else the plugin patches stays enabled.
export const createStealthPlugin = (): ReturnType<typeof StealthPlugin> => {
  const plugin = StealthPlugin();
  plugin.enabledEvasions.delete('user-agent-override');
  return plugin;
};

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
    // Chrome >=132 gates the SwiftShader software-WebGL fallback behind this flag; in a
    // GPU-less container (Xvfb) getContext('webgl') otherwise returns null, which risk
    // engines read as an instant "headless container" classification.
    '--enable-unsafe-swiftshader',
  ];

  if (headless) {
    args.push('--disable-gpu');
  }

  const proxy = getProxyConfig();
  if (proxy) {
    // Clean scheme://host:port — Chromium silently discards the whole value
    // (and connects DIRECT) if credentials are embedded in --proxy-server.
    args.push(`--proxy-server=${proxy.url}`);
  }

  return args;
}

// PROXY_SERVER accepts http://user:pass@host:port (credentials optional) or the
// host:port:user:pass form proxy dashboards print. Credentials are stripped from
// the launch URL and supplied per-page via page.authenticate() instead, because
// neither Chromium's --proxy-server nor Lightpanda's --http-proxy honors them.
export interface ProxyConfig {
  url: string;  // clean scheme://host:port for browser launch flags
  auth: { username: string; password: string } | null;
}

export function getProxyConfig(): ProxyConfig | null {
  const raw = process.env.PROXY_SERVER;
  if (!raw) return null;

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const parts = candidate.split(':');
    candidate = parts.length === 4
      ? `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`  // host:port:user:pass
      : `http://${candidate}`;
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }

  // URL getters percent-encode userinfo characters (=, @, ...) per the WHATWG spec,
  // so decode back to the raw credentials the proxy expects.
  const auth = u.username && u.password
    ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
    : null;
  return { url: `${u.protocol}//${u.host}`, auth };
}

export async function applyStealthToPage(page: Page): Promise<void> {
  // Proxy auth applies regardless of the stealth toggle — an authenticated proxy
  // without it returns 407 on every request.
  const proxy = getProxyConfig();
  if (proxy?.auth) {
    await page.authenticate({ username: proxy.auth.username, password: proxy.auth.password });
  }

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
    // No navigator.platform override: claiming Win32 on a Linux build contradicts the
    // rest of the fingerprint (UA, fonts, WebGL) and risk engines flag the mismatch.
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });

    // Containers render with no GPU (Xvfb + SwiftShader), so the WebGL renderer string
    // reads "headless container" to risk engines. Report a plausible desktop Intel iGPU
    // instead — consistent with a Linux x86_64 desktop UA. 37445/37446 are
    // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL from WEBGL_debug_renderer_info.
    const w = globalThis as any;
    const gpuVendor = 'Intel Inc.';
    const gpuRenderer = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)';
    for (const proto of [w.WebGLRenderingContext, w.WebGL2RenderingContext]) {
      if (!proto?.prototype?.getParameter) continue;
      const original = proto.prototype.getParameter;
      proto.prototype.getParameter = function (this: any, parameter: number) {
        if (parameter === 37445) return gpuVendor;
        if (parameter === 37446) return gpuRenderer;
        return original.call(this, parameter);
      };
    }
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
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });
  });
}
