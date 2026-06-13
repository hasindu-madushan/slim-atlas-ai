// Tier 2 Deno subprocess entry point. Reads a single JSON request
// from stdin, performs the requested action (render / click / fill /
// submit), writes a single JSON response to stdout, exits.
//
// We use `happy-dom` (npm:happy-dom@^16) to run the page's inline
// JavaScript. External `<script src="...">` bundles are pre-fetched
// with Deno's `fetch` (which respects `--allow-net=host:port`) and
// inlined into the HTML before parsing, so the sandbox is preserved
// end-to-end. happy-dom's own `Browser.goto` bypasses Deno's
// permissions (it uses node:http internally), so we can't use it.
//
// We chose happy-dom over jsdom for its smaller footprint (~3MB vs
// ~30MB npm deps) and faster cold start (~50ms vs ~250ms). The
// trade-off is a smaller W3C DOM surface and that some browser-only
// APIs (WebGL, Canvas, WebRTC) are not implemented; pages that
// need full browser parity can fall back to `force_tier: 1`.
//
// Protocol details: see src/deno_runtime/protocol.rs and the
// PROTOCOL_VERSION constant. Both ends assert the version on entry.

import { Window } from "happy-dom";
import {
  detectFramework,
  dispatchClick,
  fillInput,
  submitForm,
  waitForSelector,
} from "./dom_shim.ts";

const PROTOCOL_VERSION = 1;

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  http_only: boolean;
  expires: number | null;
}

interface DenoRequest {
  protocol_version: number;
  mode: "render" | "click" | "fill" | "submit";
  url: string;
  html?: string;
  cookies: CookieEntry[];
  headers: Record<string, string>;
  selector?: string;
  value?: string;
  wait_for?: string;
  wait_timeout_ms?: number;
  render_timeout_ms: number;
}

interface DenoResult {
  ok: boolean;
  html: string;
  text: string;
  title: string;
  links: Array<{ text: string; href: string }>;
  new_url: string | null;
  set_cookies: string[];
  framework: string | null;
  error: string | null;
}

function fail(msg: string): DenoResult {
  return {
    ok: false,
    html: "",
    text: "",
    title: "",
    links: [],
    new_url: null,
    set_cookies: [],
    framework: null,
    error: msg,
  };
}

async function readRequest(): Promise<DenoRequest> {
  const buf = await new Response(Deno.stdin.readable).arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return JSON.parse(text) as DenoRequest;
}

/** Build a `Cookie:` header string from a list of `CookieEntry`s, but
 * only for cookies that match `url`'s origin. Used to seed
 * `document.cookie` with the session's existing cookies. */
function cookieHeaderFor(cookies: CookieEntry[], url: string): string {
  const origin = new URL(url).origin;
  const out: string[] = [];
  for (const c of cookies) {
    if (c.domain && !origin.endsWith(c.domain)) continue;
    out.push(`${c.name}=${c.value}`);
  }
  return out.join("; ");
}

/** Pull cookies the page's JS set via `document.cookie` and format
 * them as `Set-Cookie` header strings. happy-dom's `document.cookie`
 * is a plain `"name1=value1; name2=value2"` string; we fabricate
 * the `Domain=`/`Path=`/`Secure` attributes from the page URL. */
function collectSetCookies(
  document: HappyDoc,
  url: string,
): string[] {
  const cookieHeader = document.cookie;
  if (!cookieHeader) return [];
  const u = new URL(url);
  const host = u.hostname;
  const path = u.pathname || "/";
  const secure = u.protocol === "https:";
  const out: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    out.push(
      `${name}=${value}; Domain=${host}; Path=${path}` +
        (secure ? "; Secure" : ""),
    );
  }
  return out;
}

/** Best-effort fetch wrapper. Deno's `fetch` works inside the
 * `--allow-net=host:port` sandbox. We only set headers the caller
 * supplied; we don't add a default User-Agent so the page's own
 * UA logic (or the server's bot detection) gets the unmodified
 * experience. */
async function fetchPage(
  url: string,
  headers: Record<string, string>,
): Promise<{ html: string; finalUrl: string }> {
  const resp = await fetch(url, { headers, redirect: "follow" });
  const html = await resp.text();
  return { html, finalUrl: resp.url };
}

/** Walk the HTML, find every `<script src="..."></script>`, fetch
 * the URL with Deno's `fetch` (allowlist-enforced), and replace
 * the external script with an inline copy. happy-dom then runs the
 * inlined script during parse, so SPAs that bootstrap from a
 * `<script src="/chunk.js">` actually mount.
 *
 * Errors fetching any individual script are swallowed: the page
 * just renders without that bundle. We don't fail the whole render.
 *
 * The `async` / `defer` / `type="module"` attributes are preserved
 * (we only strip the `src` attribute). happy-dom respects them. */
async function inlineExternalScripts(
  html: string,
  baseUrl: string,
  fetchHeaders: Record<string, string>,
): Promise<string> {
  const matches: { raw: string; abs: string; tag: string }[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>\s*<\/script>/gi)) {
    const attrs = m[1];
    const tag = m[0];
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!srcMatch) continue;
    const raw = srcMatch[1] ?? srcMatch[2];
    try {
      const abs = new URL(raw, baseUrl).href;
      matches.push({ raw, abs, tag });
    } catch {
      // Bad URL; leave the tag alone.
    }
  }
  if (matches.length === 0) return html;

  // Fetch all external scripts in parallel, each through Deno's
  // permission-checked fetch.
  const bodies = await Promise.all(
    matches.map(async ({ abs }) => {
      try {
        const resp = await fetch(abs, { headers: fetchHeaders });
        if (!resp.ok) return "";
        return await resp.text();
      } catch {
        return "";
      }
    }),
  );

  let out = html;
  for (let i = 0; i < matches.length; i++) {
    const { tag } = matches[i];
    const body = bodies[i];
    if (!body) continue;
    // Build: <script>body</script> from the original
    // <script src="..." [async] [defer]></script> by stripping the
    // src attribute and the closing </script>, then re-closing
    // with the body. async/defer/type attributes are preserved.
    const openTag = tag
      .replace(/\s*\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\s*<\/script>\s*$/i, "")
      .replace(/\s*$/, "");
    const inline = openTag.endsWith(">")
      ? `${openTag}${body}</script>`
      : `${openTag}>${body}</script>`;
    out = out.replace(tag, inline);
  }
  return out;
}

// happy-dom's `Window.document` is a happy-dom `Document`; the
// shim's `AnyDocument = any` means we don't need to spell out the
// full type at every call site.
// deno-lint-ignore no-explicit-any
type HappyDoc = any;

function buildResult(
  document: HappyDoc,
  initialHtml: string,
  newUrl: string | null,
  requestUrl: string,
  effectiveBaseUrl: string,
): DenoResult {
  const links: Array<{ text: string; href: string }> = [];
  const anchors = document.querySelectorAll("a[href]");
  for (const a of anchors) {
    links.push({
      text: (a.textContent || "").trim(),
      href: a.getAttribute("href") || "",
    });
  }
  return {
    ok: true,
    html: document.documentElement?.outerHTML ?? "",
    // happy-dom's `textContent` includes the contents of `<script>`
    // and `<style>` elements, which real browsers exclude. Walk the
    // tree to get a true "visible text" string.
    text: visibleText(document.body) ?? "",
    title: document.title ?? "",
    links,
    new_url: newUrl && newUrl !== requestUrl ? newUrl : null,
    set_cookies: collectSetCookies(document, effectiveBaseUrl),
    framework: detectFramework(document, initialHtml),
    error: null,
  };
}

/** Recursively collect text content, skipping `<script>` and
 * `<style>` elements. Mirrors the behavior of a real browser's
 * `element.textContent` (which excludes script and style content). */
function visibleText(node: HappyDoc): string {
  if (!node) return "";
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return node.nodeValue || "";
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return "";
  const tag = (node.tagName || "").toUpperCase();
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") {
    return "";
  }
  let out = "";
  for (const child of node.childNodes || []) {
    out += visibleText(child);
  }
  return out;
}

const main = async () => {
  let req: DenoRequest;
  try {
    req = await readRequest();
  } catch (e) {
    console.log(JSON.stringify(fail(`malformed request: ${(e as Error).message}`)));
    return;
  }

  if (req.protocol_version !== PROTOCOL_VERSION) {
    console.log(
      JSON.stringify(
        fail(
          `protocol version mismatch: rust=${
            PROTOCOL_VERSION
          } deno=${req.protocol_version}`,
        ),
      ),
    );
    return;
  }

  const targetUrl = req.url;
  let initialHtml: string;
  let effectiveBaseUrl = targetUrl;

  try {
    if (req.mode === "render") {
      const fetched = await fetchPage(targetUrl, req.headers);
      initialHtml = fetched.html;
      effectiveBaseUrl = fetched.finalUrl;
    } else {
      if (!req.html) {
        console.log(
          JSON.stringify(fail(`mode=${req.mode} requires req.html`)),
        );
        return;
      }
      initialHtml = req.html;
    }
  } catch (e) {
    console.log(
      JSON.stringify(fail(`fetch failed: ${(e as Error).message}`)),
    );
    return;
  }

  // --- pre-fetch external scripts and inline them ---
  // For `render` mode: the page is already fetched above; inline
  //   external scripts so happy-dom runs them during parse.
  // For `click`/`fill`/`submit` mode: the caller already provided
  //   `req.html` (the T1 output); run the inliner on that too in
  //   case it contains <script src=...> from the original T1 fetch.
  let documentHtml = initialHtml;
  if (req.mode === "render") {
    try {
      documentHtml = await inlineExternalScripts(
        initialHtml,
        effectiveBaseUrl,
        req.headers,
      );
    } catch (e) {
      console.log(
        JSON.stringify(
          fail(`inline scripts failed: ${(e as Error).message}`),
        ),
      );
      return;
    }
  }

  // --- happy-dom Window construction ---
  // deno-lint-ignore no-explicit-any
  let document: any;
  try {
    const window = new Window({
      url: effectiveBaseUrl,
      settings: {
        // We pre-fetched all <script src> via Deno's fetch above.
        // Disable happy-dom's own subresource loader so it doesn't
        // bypass our --allow-net sandbox via node:http.
        disableJavaScriptFileLoading: true,
        disableJavaScriptEvaluation: false,
        // CSS isn't needed for DOM/JS behavior.
        disableCSSFileLoading: true,
        // happy-dom 16 timer safety — prevent waitUntilComplete()
        // hanging on long-running setTimeout/setInterval loops in
        // adversarial pages. `maxIntervalIterations: 1` caps each
        // interval at a single tick before happy-dom kills it.
        timer: {
          maxTimeout: 200,
          maxIntervalTime: 10,
          maxIntervalIterations: 1,
        },
        // Block main-frame navigations: the script's window.location
        // changes should not trigger a network fetch in the worker.
        navigation: { disableMainFrameNavigation: true },
      },
    });
    document = window.document;
    document.write(documentHtml);
    document.close();
    await window.happyDOM.waitUntilComplete();

    // Seed cookies onto document.cookie now that the Window is alive.
    const cookieHeader = cookieHeaderFor(req.cookies || [], effectiveBaseUrl);
    if (cookieHeader) {
      try {
        // happy-dom parses the string and respects Domain=/Path=.
        document.cookie = cookieHeader;
      } catch {
        // Ignore malformed cookies from the session jar.
      }
    }
  } catch (e) {
    console.log(
      JSON.stringify(
        fail(`happy-dom construct failed: ${(e as Error).message}`),
      ),
    );
    return;
  }

  let newUrl: string | null = null;
  try {
    switch (req.mode) {
      case "render": {
        newUrl = effectiveBaseUrl;
        break;
      }
      case "click": {
        if (!req.selector) {
          console.log(JSON.stringify(fail("click requires selector")));
          return;
        }
        newUrl = dispatchClick(
          document,
          req.selector,
          effectiveBaseUrl,
        );
        break;
      }
      case "fill": {
        if (!req.selector || req.value === undefined) {
          console.log(JSON.stringify(fail("fill requires selector and value")));
          return;
        }
        fillInput(document, req.selector, req.value);
        break;
      }
      case "submit": {
        newUrl = submitForm(
          document,
          req.selector ?? null,
          effectiveBaseUrl,
        );
        break;
      }
    }
  } catch (e) {
    console.log(
      JSON.stringify(fail(`action failed: ${(e as Error).message}`)),
    );
    return;
  }

  if (req.wait_for) {
    const found = await waitForSelector(
      document,
      req.wait_for,
      req.wait_timeout_ms ?? 5000,
    );
    if (!found) {
      console.log(
        JSON.stringify(
          fail(`wait_for selector not found: ${req.wait_for}`),
        ),
      );
      return;
    }
  }

  console.log(
    JSON.stringify(
      buildResult(document, initialHtml, newUrl, targetUrl, effectiveBaseUrl),
    ),
  );
};

await main();
