import type { Page } from 'puppeteer';

export interface BotDetectionResult {
  blocked: boolean;
  reason: string;
}

// ponytail: detection runs on the Lightpanda layer only (a lightweight JS
// engine, not a full desktop browser), so a near-empty body is itself a strong
// escalation signal. Weak markers and the non-strict path were only relevant
// for the (now-removed) Chrome/CDP detection.
const STRONG_MARKERS = [
  'cf-chl-bypass', 'cdn-cgi/challenge-platform', 'px-captcha',
  'bm-challenge', '/_bm/', 'datadome',
];
const CHALLENGE_TITLE_PREFIX = /^(just a moment|checking your browser|access denied|ddos protection|human verification|verify you are human|attention required)\b/i;

const PROBE_SCRIPT = `
  (function() {
    var body = document.body;
    function visibleText(el) {
      var s = '', c = el.childNodes;
      for (var i = 0; i < c.length; i++) {
        var n = c[i];
        if (n.nodeType === 3) s += n.textContent;
        else if (n.nodeType === 1) {
          var tag = n.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
          s += visibleText(n);
        }
      }
      return s;
    }
    return {
      html: document.documentElement.outerHTML.toLowerCase(),
      bodyText: (body ? visibleText(body) : '').trim(),
      elCount: body ? body.querySelectorAll('*').length : 0,
      title: document.title,
      hostname: location.hostname.replace(/^www\\./, ''),
    };
  })()
`;

interface ProbeResult {
  html: string;
  bodyText: string;
  elCount: number;
  title: string;
  hostname: string;
}

export class BotDetectionService {
  async detect(page: Page): Promise<BotDetectionResult> {
    let info: ProbeResult;
    try {
      info = await page.evaluate(PROBE_SCRIPT) as ProbeResult;
    } catch (e: any) {
      // Render/evaluate failed on Lightpanda -> treat as needing a real browser.
      return { blocked: true, reason: `detection failed: ${e?.message || e}` };
    }

    const t = (info.title || '').trim();

    for (const m of STRONG_MARKERS) {
      if (info.html.includes(m)) return { blocked: true, reason: `marker: ${m}` };
    }

    if (CHALLENGE_TITLE_PREFIX.test(t)) {
      return { blocked: true, reason: `challenge title: "${t}"` };
    }

    const isNearEmpty = info.bodyText.length < 50 && info.elCount < 20;
    if (isNearEmpty) {
      return {
        blocked: true,
        reason: `near-empty body (${info.bodyText.length} chars, ${info.elCount} elements; title="${t}")`,
      };
    }

    return { blocked: false, reason: '' };
  }
}
