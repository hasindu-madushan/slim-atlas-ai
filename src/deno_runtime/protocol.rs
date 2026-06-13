//! Wire protocol between the Rust host and the Deno subprocess.
//!
//! One JSON request per call, written to Deno's stdin. One JSON response
//! per call, read from Deno's stdout. Deno exits after each call (it's
//! cheaper to spawn a fresh process per call than to maintain a long-
//! lived worker — deno startup is ~150ms, which is acceptable for the
//! agent use case and avoids whole classes of "stale worker" bugs).
//!
//! ## Schema stability
//!
//! The Rust side is the only consumer; the Deno side (render.ts) is the
//! only producer. We bump a `protocol_version` field on both ends; a
//! mismatch surfaces as a `BrowserError::DenoFailed` with a clear
//! message. This makes future schema changes safe.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{BrowserError, Result};
use crate::deno::framework::FrameworkHint;

/// Bump this whenever the wire shape changes. The Deno side checks it
/// at startup and refuses to run on a mismatch.
pub const PROTOCOL_VERSION: u32 = 1;

/// Action the Deno subprocess should perform. Serialized in lowercase
/// to keep the wire format compact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Fetch the URL via Deno's global `fetch()` and return the
    /// post-script-execution DOM. Used by `navigate`.
    Render,
    /// Find the element matching `selector` and dispatch a click.
    /// Returns the resolved href (for `<a>`) or the post-submit form
    /// action URL (for buttons inside forms), whichever applies. None
    /// if the click doesn't navigate.
    Click,
    /// Set `.value` on the input/textarea matching `selector`.
    Fill,
    /// Submit the form (or the form containing the button) matching
    /// `selector` (or the page's first form if `selector` is None).
    Submit,
}

/// One cookie as it travels from Rust to Deno. We pass structured
/// fields rather than a serialized `Cookie:` header so Deno can set
/// each cookie's attributes (path, domain, secure) correctly.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    /// Unix epoch seconds, or `None` for session cookies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
}

/// One link in the rendered DOM, surfaced to the agent.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LinkEntry {
    pub text: String,
    /// The `href` attribute as it appears in the DOM, *not* resolved
    /// against the page URL. The Rust layer resolves it.
    pub href: String,
}

/// Request body. Serialized as JSON, written to Deno's stdin, followed
/// by EOF.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DenoRequest {
    /// Always present. Both ends assert it matches.
    pub protocol_version: u32,
    pub mode: Mode,
    /// The URL the action is operating on. For `render` this is the
    /// fetch target; for `click`/`fill`/`submit` it's the base URL
    /// used to resolve relative hrefs.
    pub url: String,
    /// Pre-fetched HTML for non-render modes. Required for `click`,
    /// `fill`, `submit`; ignored for `render` (where Deno fetches).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// Cookies to set on the page's `document.cookie` before any
    /// script runs. Sourced from the session jar at request build
    /// time.
    #[serde(default)]
    pub cookies: Vec<CookieEntry>,
    /// Custom request headers (for `render`'s `fetch()` call).
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// CSS selector. Required for `click`/`fill`, optional for
    /// `submit` (default: first form on the page), ignored for
    /// `render`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Value to set (fill only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Wait for this selector to appear in the DOM after the action.
    /// Polled up to `wait_timeout_ms` (default 5000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_timeout_ms: Option<u64>,
    /// Overall render budget. Surfaced to Deno for logging; the actual
    /// timeout is enforced by the Rust side via `tokio::time::timeout`.
    pub render_timeout_ms: u64,
}

impl DenoRequest {
    pub fn new_render(url: String, render_timeout_ms: u64) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            mode: Mode::Render,
            url,
            html: None,
            cookies: Vec::new(),
            headers: BTreeMap::new(),
            selector: None,
            value: None,
            wait_for: None,
            wait_timeout_ms: None,
            render_timeout_ms,
        }
    }
}

/// Response body. Serialized as JSON by Deno, read from its stdout.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DenoResult {
    /// Always present. The Deno side sets it to `false` on any
    /// unrecoverable error (uncaught exception, parse failure, etc.).
    pub ok: bool,
    /// Final HTML of the page (post-script-execution for `render`).
    pub html: String,
    /// `body.textContent` of the final DOM.
    pub text: String,
    /// `document.title`.
    pub title: String,
    /// All `<a href>` elements in the final DOM.
    pub links: Vec<LinkEntry>,
    /// New URL if the action caused navigation. None for `fill` (no
    /// nav) or for actions that didn't change the URL.
    pub new_url: Option<String>,
    /// Cookies that the page's JS set via `document.cookie`. Each
    /// entry is a raw `Set-Cookie` header value that the Rust side
    /// merges into the session jar.
    #[serde(default)]
    pub set_cookies: Vec<String>,
    /// Detected framework. None if no markers matched.
    pub framework: Option<String>,
    /// Error message if `ok: false`. The Rust side wraps this in
    /// `BrowserError::DenoFailed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DenoResult {
    /// Build an error result on the Rust side (used when the subprocess
    /// couldn't be spawned at all, or its JSON output was malformed —
    /// in which case the caller fabricates a result rather than
    /// returning one).
    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            html: String::new(),
            text: String::new(),
            title: String::new(),
            links: Vec::new(),
            new_url: None,
            set_cookies: Vec::new(),
            framework: None,
            error: Some(msg.into()),
        }
    }

    /// Parse a `framework` string from Deno into the project-wide
    /// `FrameworkHint` enum. Deno mirrors the same classification
    /// logic as `HtmlPage::detect_framework`; keeping the mapping here
    /// in Rust avoids version skew between the two implementations.
    pub fn parsed_framework(&self) -> Option<FrameworkHint> {
        self.framework.as_deref().and_then(|s| match s {
            "next_ssr" => Some(FrameworkHint::NextSsr),
            "next_csr" => Some(FrameworkHint::NextCsr),
            "react_csr" => Some(FrameworkHint::ReactCsr),
            "angular_univ" => Some(FrameworkHint::AngularUniv),
            "angular_csr" => Some(FrameworkHint::AngularCsr),
            "vue_ssr" => Some(FrameworkHint::VueSsr),
            "static" => Some(FrameworkHint::Static),
            _ => None,
        })
    }
}

/// Serialize a request to JSON bytes. Wraps `serde_json::to_vec` so
/// call sites don't have to import the trait.
pub fn encode_request(req: &DenoRequest) -> Result<Vec<u8>> {
    serde_json::to_vec(req).map_err(|e| BrowserError::Parse(format!("encode deno request: {e}")))
}

/// Parse a JSON byte slice into a `DenoResult`. Returns a
/// `BrowserError::Parse` on malformed input.
pub fn decode_result(bytes: &[u8]) -> Result<DenoResult> {
    serde_json::from_slice::<DenoResult>(bytes)
        .map_err(|e| BrowserError::Parse(format!("decode deno result: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip_render() {
        let mut req = DenoRequest::new_render("https://example.com/".into(), 10_000);
        req.cookies.push(CookieEntry {
            name: "session".into(),
            value: "abc123".into(),
            domain: "example.com".into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            expires: Some(1_700_000_000),
        });
        req.headers.insert("user-agent".into(), "test".into());

        let bytes = encode_request(&req).unwrap();
        let json = String::from_utf8(bytes.clone()).unwrap();
        // Sanity-check a couple of fields
        assert!(json.contains("\"mode\":\"render\""));
        assert!(json.contains("\"protocol_version\":1"));
        assert!(json.contains("\"value\":\"abc123\""));
        // Round-trip
        let back: DenoRequest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.mode, Mode::Render);
        assert_eq!(back.url, "https://example.com/");
        assert_eq!(back.cookies.len(), 1);
        assert_eq!(back.cookies[0].name, "session");
    }

    #[test]
    fn mode_serializes_lowercase() {
        let m = Mode::Click;
        let s = serde_json::to_string(&m).unwrap();
        assert_eq!(s, "\"click\"");
        let back: Mode = serde_json::from_str(&s).unwrap();
        assert_eq!(back, Mode::Click);
    }

    #[test]
    fn result_error_helper() {
        let r = DenoResult::error("boom");
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("boom"));
    }

    #[test]
    fn framework_string_mapping() {
        let r = DenoResult {
            ok: true,
            html: String::new(),
            text: String::new(),
            title: String::new(),
            links: Vec::new(),
            new_url: None,
            set_cookies: Vec::new(),
            framework: Some("next_csr".into()),
            error: None,
        };
        assert_eq!(r.parsed_framework(), Some(FrameworkHint::NextCsr));

        let unknown = DenoResult {
            framework: Some("garbage".into()),
            ..r.clone()
        };
        assert_eq!(unknown.parsed_framework(), None);

        let none = DenoResult {
            framework: None,
            ..r
        };
        assert_eq!(none.parsed_framework(), None);
    }
}
