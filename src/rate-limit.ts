import { log } from './logger.js';

const ENV_DOMAINS = (process.env.RATE_LIMIT_DOMAINS || '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

const ENV_MIN_DELAY_MS = parseInt(process.env.RATE_LIMIT_MIN_DELAY_MS || '0', 10);
const ENV_JITTER_MS = parseInt(process.env.RATE_LIMIT_JITTER_MS || '0', 10);

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class RateLimiter {
  // Global per-domain next-allowed ts. throttle() advances it synchronously BEFORE
  // sleeping, so concurrent callers queue in distinct slots instead of all reading
  // the same snapshot and waking as one burst.
  private lastHit: Map<string, number> = new Map();
  private readonly patterns: string[];
  private readonly minDelayMs: number;
  private readonly jitterMs: number;

  constructor(patterns: string[] = ENV_DOMAINS, minDelayMs: number = ENV_MIN_DELAY_MS, jitterMs: number = ENV_JITTER_MS) {
    this.patterns = patterns;
    this.minDelayMs = minDelayMs;
    this.jitterMs = jitterMs;
  }

  isEnabled(): boolean {
    return this.patterns.length > 0 && this.minDelayMs > 0;
  }

  // Resolves a url to its throttle-bucket key, or null if no pattern matches.
  //   "*"          -> any host; key = host (each domain throttled independently)
  //   "*.suffix"   -> subdomains of suffix only (excludes suffix itself); key = suffix
  //   "literal"    -> host or its subdomains; key = literal (subdomains share a bucket)
  matchedDomain(url: string): string | null {
    if (!this.patterns.length) return null;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    for (const p of this.patterns) {
      if (p === '*') return host;
      if (p.startsWith('*.')) {
        const suffix = p.slice(2);
        if (host.endsWith('.' + suffix)) return suffix;
      } else if (host === p || host.endsWith('.' + p)) {
        return p;
      }
    }
    return null;
  }

  async throttle(sessionId: string, url: string): Promise<void> {
    if (!this.isEnabled()) return;
    const domain = this.matchedDomain(url);
    if (!domain) return;

    // ponytail: reserve the slot synchronously BEFORE sleeping. Writing lastHit only
    // after the sleep let a burst of concurrent callers read the same snapshot, sleep
    // identical waits in parallel, wake together, and all hit the domain at once.
    // Single-threaded JS makes the read-modify-write atomic — no lock needed.
    // effective min delay = minDelayMs + random(0, jitterMs); jitter is drawn fresh
    // per hit so pacing isn't a fixed, fingerprintable interval.
    const effective = this.minDelayMs + Math.random() * this.jitterMs;
    const now = Date.now();
    const slot = Math.max(now, (this.lastHit.get(domain) ?? 0) + effective);
    this.lastHit.set(domain, slot);
    const wait = slot - now;
    if (wait > 0) {
      log.info(sessionId, `Rate limit: sleeping ${Math.round(wait)}ms before hitting ${domain}`);
      await sleep(wait);
    }
  }
}
