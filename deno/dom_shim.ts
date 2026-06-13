// DOM helpers used by `deno/render.ts`. Pure: take a Document
// (happy-dom or anything with the W3C DOM surface) and return data.
// Never touch the network — that's render.ts's job.

/** Minimal Document shape we depend on. happy-dom implements the
 * W3C DOM; this alias keeps the helpers framework-agnostic. */
// deno-lint-ignore no-explicit-any
export type AnyDocument = any;

/** Best-effort framework detection. Mirrors HtmlPage::detect_framework
 * in src/tiers/tier1_http.rs. Keep the two in sync. */
export function detectFramework(
  doc: AnyDocument,
  initialHtml: string,
): string | null {
  const lower = initialHtml.toLowerCase();
  const hasNextData = lower.includes("__next_data__");
  const hasNgServer = lower.includes("ng-server-context");
  const hasDataServer = lower.includes("data-server-rendered");

  // Empty-shell detection on the same roots the Rust side uses.
  let isShell = false;
  for (const sel of ["#root", "#app", "#__next", "app-root", "ng-app"]) {
    const el = doc.querySelector(sel);
    if (el) {
      const text = (el.textContent || "").trim();
      if (text === "") {
        isShell = true;
        break;
      }
    }
  }

  if (hasNextData) {
    return isShell ? "next_csr" : "next_ssr";
  }
  if (hasNgServer) return "angular_univ";
  if (hasDataServer) return "vue_ssr";
  if (isShell) {
    return lower.includes("react") ? "react_csr" : "angular_csr";
  }
  return "static";
}

/** Poll `doc` for `selector` to appear, up to `timeoutMs`. Returns
 * true if found, false on timeout. */
export async function waitForSelector(
  doc: AnyDocument,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  const interval = 50;
  while (Date.now() - start < timeoutMs) {
    if (doc.querySelector(selector)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return doc.querySelector(selector) !== null;
}

/** Dispatch a "click" on the first element matching `selector`.
 * Returns the new URL the click would navigate to, or null if the
 * click has no observable navigation effect.
 *
 * Algorithm:
 * 1. Walk up the matched element's ancestors to find a <form>. If
 *    found, treat the click as a submit on that form (use
 *    `submitFormEl`).
 * 2. Walk up to find an <a> with an href. If found, resolve the href
 *    against the page URL and return it.
 * 3. Otherwise, the click is a no-op as far as navigation is
 *    concerned. Return null.
 */
export function dispatchClick(
  doc: AnyDocument,
  selector: string,
  baseUrl: string,
): string | null {
  const target = doc.querySelector(selector);
  if (!target) return null;

  const form = closest(target, "form");
  if (form) {
    return submitFormEl(form, baseUrl);
  }

  const anchor = closest(target, "a");
  if (anchor) {
    const href = anchor.getAttribute("href");
    if (href) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Set `.value` on the first input/textarea/contenteditable matching
 * `selector`. Returns true if a value was set. */
export function fillInput(
  doc: AnyDocument,
  selector: string,
  value: string,
): boolean {
  const el = doc.querySelector(selector);
  if (!el) return false;

  if ("value" in el) {
    // happy-dom tracks `value` as a property; setting only the
    // property doesn't show up in `outerHTML`. We also set the
    // attribute so the agent can see the change either way.
    el.value = value;
    if (typeof el.setAttribute === "function") {
      el.setAttribute("value", value);
    }
    return true;
  }
  if ("textContent" in el) {
    el.textContent = value;
    return true;
  }
  el.setAttribute("value", value);
  return true;
}

/** Submit a form. If `selector` is provided, find the form (or the
 * form containing the matched element). If `selector` is null,
 * submit the first form on the page. Returns the URL the form would
 * navigate to. */
export function submitForm(
  doc: AnyDocument,
  selector: string | null,
  baseUrl: string,
): string | null {
  let form: AnyDocument = null;
  if (selector) {
    const target = doc.querySelector(selector);
    if (target) {
      form = target.tagName?.toLowerCase() === "form"
        ? target
        : closest(target, "form");
    }
  } else {
    form = doc.querySelector("form");
  }
  if (!form) return null;
  return submitFormEl(form, baseUrl);
}

// ---------------- internals ----------------

function closest(start: AnyDocument, tag: string): AnyDocument {
  let cur: AnyDocument = start;
  while (cur) {
    if (cur.tagName?.toLowerCase() === tag) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function submitFormEl(form: AnyDocument, baseUrl: string): string | null {
  const action = form.getAttribute("action");
  const method = (form.getAttribute("method") || "GET").toUpperCase();
  try {
    const url = new URL(action || "", baseUrl);
    if (method === "GET") {
      const params = new URLSearchParams();
      const inputs = form.querySelectorAll(
        "input[name], textarea[name], select[name]",
      );
      for (const inp of inputs) {
        const name = inp.getAttribute("name");
        if (!name) continue;
        const type = (inp.getAttribute("type") || "text").toLowerCase();
        if (type === "submit" || type === "button") continue;
        const value = inp.getAttribute("value") ??
          inp.value ?? "";
        params.append(name, value);
      }
      url.search = params.toString();
    }
    return url.toString();
  } catch {
    return null;
  }
}
