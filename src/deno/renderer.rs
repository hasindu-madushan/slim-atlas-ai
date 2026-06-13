//! Deno subprocess renderer. Owns the host-allowlist computation,
//! cookie round-trip, and the request shape. The `McpServer` (and
//! through it, the agents) only ever sees four high-level methods:
//! `render`, `click`, `fill`, `submit`. They all return a `PageResult`
//! that the caller commits into the session.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::cookie::{CookieStore, Jar};
use scraper::{Html, Selector};
use url::Url;

use crate::config::{DenoConfig, HttpConfig};
use crate::deno_runtime::pool::DenoPool;
use crate::deno_runtime::protocol::{CookieEntry, DenoRequest, DenoResult, Mode, PROTOCOL_VERSION};
use crate::deno_runtime::DenoRuntime;
use crate::error::{BrowserError, Result};
use crate::state::SecurityPolicy;
use crate::deno::framework::FrameworkHint;
use crate::utils::Link;

/// The output of a Deno render/click/fill/submit call.
#[derive(Debug, Clone)]
pub struct PageResult {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub links: Vec<Link>,
    pub framework: Option<FrameworkHint>,
    /// New URL if the call caused navigation (click, submit). None
    /// for render and fill.
    pub new_url: Option<String>,
}

impl PageResult {
    /// Construct a PageResult from a `DenoResult`, resolving relative
    /// link hrefs against `base_url`.
    pub fn from_deno(result: DenoResult, base_url: &Url) -> Self {
        let new_url = result.new_url.clone();
        let framework = result.parsed_framework();
        let links = result
            .links
            .into_iter()
            .filter_map(|l| {
                let absolute = base_url.join(&l.href).ok()?.to_string();
                if l.text.is_empty() && l.href.starts_with('#') {
                    return None;
                }
                Some(Link {
                    text: l.text,
                    href: l.href,
                    absolute,
                })
            })
            .collect();
        Self {
            url: new_url.clone().unwrap_or_else(|| base_url.to_string()),
            title: result.title,
            text: result.text,
            html: result.html,
            links,
            framework,
            new_url,
        }
    }
}

/// Cap on the number of hosts in a single `--allow-net` argument.
/// Deno's CLI takes a comma-separated list, but unbounded lists are
/// easy to abuse (a page that includes 1000 ad-network hosts would
/// try to grant 1000 network permissions). We cap at 16 to keep the
/// spawn arguments manageable. The 17th+ host causes a `tracing::warn`
/// and is dropped.
const MAX_ALLOW_NET_HOSTS: usize = 16;

/// Deno renderer facade over the Deno subprocess pool. Handles
/// host-allowlist computation, cookie round-trip, and request shape.
#[derive(Debug, Clone)]
pub struct DenoRenderer {
    pool: Arc<DenoPool>,
    config: Arc<DenoConfig>,
    security: Arc<SecurityPolicy>,
    http_config: HttpConfig,
}

impl DenoRenderer {
    /// Build a Deno renderer. Resolves the `deno` binary path lazily
    /// — the first call to `render` / `click` etc. pays the cost
    /// (PATH lookup, possibly install). Construction itself only
    /// verifies that the `deno` script file exists.
    pub fn new(
        deno_runtime: Arc<DenoRuntime>,
        security: Arc<SecurityPolicy>,
        http_config: HttpConfig,
    ) -> Result<Self> {
        let config = deno_runtime.config().clone();
        // We don't actually need to resolve deno here; the pool
        // resolves the binary lazily on every call. But we do want
        // the script to exist so a typo fails fast at startup
        // rather than on first click.
        let script = std::path::PathBuf::from(&config.script_path);
        if !script.exists() {
            return Err(BrowserError::DenoInstallFailed {
                reason: format!(
                    "deno script not found: {} (set [deno].script_path in config.toml)",
                    script.display()
                ),
            });
        }
        let pool = Arc::new(DenoPool::new(
            deno_runtime.clone(),
            script,
            config.pool_size,
        ));
        Ok(Self {
            pool,
            config: Arc::new(config),
            security,
            http_config,
        })
    }

    /// Render a page (Deno fetches it). Used by `navigate`.
    ///
    /// `jar` is the session's cookie jar; we send its cookies as the
    /// `Cookie:` header and merge any `Set-Cookie` headers from the
    /// response back into it.
    pub async fn render(
        &self,
        url: &Url,
        jar: &std::sync::Arc<reqwest::cookie::Jar>,
        wait_for: Option<&str>,
        wait_timeout_ms: Option<u64>,
    ) -> Result<PageResult> {
        self.security.assert_host_allowed(url)?;
        let mut req = DenoRequest::new_render(url.to_string(), self.config.render_timeout_ms);
        req.cookies = jar_cookies_for(jar.as_ref(), url);
        req.headers = request_headers(&self.http_config);
        req.wait_for = wait_for.map(str::to_string);
        req.wait_timeout_ms = wait_timeout_ms;

        let allowed = self.compute_allowed_hosts(url, &Html::new_document());
        let result = self
            .execute(
                req,
                allowed,
                Duration::from_millis(self.config.render_timeout_ms),
            )
            .await?;
        merge_set_cookies(jar.as_ref(), url, &result.set_cookies);
        Ok(PageResult::from_deno(result, url))
    }

    /// Click an element on the current page. Given the page's
    /// already-fetched HTML; for the click it walks the DOM
    /// to resolve the new URL (anchor href, form action, etc.).
    pub async fn click(
        &self,
        url: &Url,
        jar: &std::sync::Arc<reqwest::cookie::Jar>,
        current_html: &str,
        selector: &str,
        wait_for: Option<&str>,
        wait_timeout_ms: Option<u64>,
    ) -> Result<PageResult> {
        self.security.assert_host_allowed(url)?;
        let mut req = DenoRequest {
            protocol_version: PROTOCOL_VERSION,
            mode: Mode::Click,
            url: url.to_string(),
            html: Some(current_html.to_string()),
            cookies: jar_cookies_for(jar.as_ref(), url),
            headers: BTreeMap::new(),
            selector: Some(selector.to_string()),
            value: None,
            wait_for: wait_for.map(str::to_string),
            wait_timeout_ms,
            render_timeout_ms: self.config.render_timeout_ms,
        };
        req.headers = request_headers(&self.http_config);
        let allowed = {
            let page_doc = Html::parse_document(current_html);
            self.compute_allowed_hosts(url, &page_doc)
        };
        let result = self
            .execute(
                req,
                allowed,
                Duration::from_millis(self.config.render_timeout_ms),
            )
            .await?;
        merge_set_cookies(jar.as_ref(), url, &result.set_cookies);
        let effective = result
            .new_url
            .as_deref()
            .and_then(|s| Url::parse(s).ok())
            .unwrap_or_else(|| url.clone());
        Ok(PageResult::from_deno(result, &effective))
    }

    /// Type a value into an input/textarea on the current page.
    pub async fn fill(
        &self,
        url: &Url,
        jar: &std::sync::Arc<reqwest::cookie::Jar>,
        current_html: &str,
        selector: &str,
        value: &str,
    ) -> Result<PageResult> {
        self.security.assert_host_allowed(url)?;
        let mut req = DenoRequest {
            protocol_version: PROTOCOL_VERSION,
            mode: Mode::Fill,
            url: url.to_string(),
            html: Some(current_html.to_string()),
            cookies: jar_cookies_for(jar.as_ref(), url),
            headers: BTreeMap::new(),
            selector: Some(selector.to_string()),
            value: Some(value.to_string()),
            wait_for: None,
            wait_timeout_ms: None,
            render_timeout_ms: self.config.render_timeout_ms,
        };
        req.headers = request_headers(&self.http_config);
        let allowed = {
            let page_doc = Html::parse_document(current_html);
            self.compute_allowed_hosts(url, &page_doc)
        };
        let result = self
            .execute(
                req,
                allowed,
                Duration::from_millis(self.config.render_timeout_ms),
            )
            .await?;
        merge_set_cookies(jar.as_ref(), url, &result.set_cookies);
        Ok(PageResult::from_deno(result, url))
    }

    /// Submit a form on the current page. If `selector` is None,
    /// the first form on the page is submitted.
    pub async fn submit(
        &self,
        url: &Url,
        jar: &std::sync::Arc<reqwest::cookie::Jar>,
        current_html: &str,
        selector: Option<&str>,
    ) -> Result<PageResult> {
        self.security.assert_host_allowed(url)?;
        let mut req = DenoRequest {
            protocol_version: PROTOCOL_VERSION,
            mode: Mode::Submit,
            url: url.to_string(),
            html: Some(current_html.to_string()),
            cookies: jar_cookies_for(jar.as_ref(), url),
            headers: BTreeMap::new(),
            selector: selector.map(str::to_string),
            value: None,
            wait_for: None,
            wait_timeout_ms: None,
            render_timeout_ms: self.config.render_timeout_ms,
        };
        req.headers = request_headers(&self.http_config);
        let allowed = {
            let page_doc = Html::parse_document(current_html);
            self.compute_allowed_hosts(url, &page_doc)
        };
        let result = self
            .execute(
                req,
                allowed,
                Duration::from_millis(self.config.render_timeout_ms),
            )
            .await?;
        merge_set_cookies(jar.as_ref(), url, &result.set_cookies);
        let effective = result
            .new_url
            .as_deref()
            .and_then(|s| Url::parse(s).ok())
            .unwrap_or_else(|| url.clone());
        Ok(PageResult::from_deno(result, &effective))
    }

    /// Pool concurrency cap. Surfaced for diagnostics.
    pub fn pool_concurrency(&self) -> usize {
        self.pool.max_concurrency()
    }

    // --- internals ---

    /// Execute a deno request through the pool.
    async fn execute(
        &self,
        req: DenoRequest,
        allowed_hosts: Vec<String>,
        timeout: Duration,
    ) -> Result<DenoResult> {
        self.pool.execute(req, allowed_hosts, timeout).await
    }

    /// Compute the host:port list for `--allow-net=...`. Always
    /// includes the page's own origin. Also pulls form actions,
    /// `<script src>`, `<link href>`, and `<img src>` from the
    /// current HTML, capped at `MAX_ALLOW_NET_HOSTS` total.
    fn compute_allowed_hosts(&self, page_url: &Url, page_doc: &Html) -> Vec<String> {
        let mut hosts: BTreeSet<String> = BTreeSet::new();
        let origin_host = page_url.host_str().unwrap_or("").to_string();
        let origin_port = page_url.port_or_known_default().unwrap_or(443);
        if !origin_host.is_empty() {
            hosts.insert(format!("{origin_host}:{origin_port}"));
        }

        let selectors = [
            "form[action]",
            "script[src]",
            "link[href]",
            "img[src]",
            "iframe[src]",
            "source[src]",
            "audio[src]",
            "video[src]",
        ];
        for sel in selectors {
            let Ok(s) = Selector::parse(sel) else {
                continue;
            };
            for el in page_doc.select(&s) {
                let attr = match sel {
                    "form[action]" => el.value().attr("action"),
                    _ => el.value().attr("src").or_else(|| el.value().attr("href")),
                };
                let Some(attr) = attr else { continue };
                let Ok(u) = page_url.join(attr) else { continue };
                if let Some(h) = u.host_str() {
                    let p = u
                        .port_or_known_default()
                        .unwrap_or(if u.scheme() == "https" { 443 } else { 80 });
                    hosts.insert(format!("{h}:{p}"));
                    if hosts.len() >= MAX_ALLOW_NET_HOSTS {
                        break;
                    }
                }
            }
            if hosts.len() >= MAX_ALLOW_NET_HOSTS {
                break;
            }
        }

        if hosts.len() > MAX_ALLOW_NET_HOSTS {
            tracing::warn!(
                page_hosts = hosts.len(),
                cap = MAX_ALLOW_NET_HOSTS,
                "page references more hosts than the --allow-net cap; truncating"
            );
        }
        hosts.into_iter().take(MAX_ALLOW_NET_HOSTS).collect()
    }
}

// ---------------- helpers ----------------

fn jar_cookies_for(jar: &Jar, url: &Url) -> Vec<CookieEntry> {
    let Some(cookie_header) = jar.cookies(url) else {
        return Vec::new();
    };
    let Ok(s) = cookie_header.to_str() else {
        return Vec::new();
    };
    s.split(';')
        .filter_map(|kv| {
            let kv = kv.trim();
            let (name, value) = kv.split_once('=')?;
            Some(CookieEntry {
                name: name.trim().to_string(),
                value: value.trim().to_string(),
                domain: url.host_str().unwrap_or("").to_string(),
                path: url.path().split('/').next().unwrap_or("/").to_string(),
                secure: url.scheme() == "https",
                http_only: false,
                expires: None,
            })
        })
        .collect()
}

fn merge_set_cookies(jar: &Jar, url: &Url, set_cookies: &[String]) {
    let host = url.host_str().unwrap_or("");
    for sc in set_cookies {
        let Ok(mut header_value) = sc.parse::<http::HeaderValue>() else {
            continue;
        };
        if !sc.to_ascii_lowercase().contains("domain=") {
            let appended = format!("{sc}; Domain={host}");
            let Ok(parsed) = appended.parse::<http::HeaderValue>() else {
                continue;
            };
            header_value = parsed;
        }
        let mut iter = std::iter::once(&header_value);
        jar.set_cookies(&mut iter, url);
    }
}

fn request_headers(config: &HttpConfig) -> std::collections::BTreeMap<String, String> {
    let mut h = std::collections::BTreeMap::new();
    h.insert("user-agent".into(), config.user_agent.clone());
    h.insert(
        "accept".into(),
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
            .into(),
    );
    h.insert("accept-language".into(), "en-US,en;q=0.9".into());
    h.insert("sec-fetch-dest".into(), "document".into());
    h.insert("sec-fetch-mode".into(), "navigate".into());
    h.insert("sec-fetch-site".into(), "none".into());
    h.insert("sec-fetch-user".into(), "?1".into());
    h.insert("upgrade-insecure-requests".into(), "1".into());
    h.insert(
        "sec-ch-ua".into(),
        r#""Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24""#.into(),
    );
    h.insert("sec-ch-ua-mobile".into(), "?0".into());
    h.insert("sec-ch-ua-platform".into(), r#""macOS""#.into());
    for (k, v) in &config.extra_headers {
        h.insert(k.clone(), v.clone());
    }
    h
}
