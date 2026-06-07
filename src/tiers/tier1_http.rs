use std::sync::Arc;
use std::time::Duration;

use reqwest::cookie::Jar;
use reqwest::redirect::Policy;
use scraper::Html;
use url::Url;

use crate::config::HttpConfig;
use crate::error::{BrowserError, Result};
use crate::utils::Link;

/// Plain HTTP + HTML parse tier. One per session for cookie isolation.
pub struct Tier1Http {
    client: reqwest::Client,
    cookies: Arc<Jar>,
    config: HttpConfig,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub html: String,
    pub final_url: Url,
    pub status: reqwest::StatusCode,
}

#[derive(Debug, Clone, serde::Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrameworkHint {
    NextSsr,
    NextCsr,
    ReactCsr,
    AngularUniv,
    AngularCsr,
    VueSsr,
    Static,
}

impl Tier1Http {
    pub fn new(cookies: Arc<Jar>, config: HttpConfig) -> Self {
        let client = reqwest::Client::builder()
            .cookie_provider(cookies.clone())
            .user_agent(&config.user_agent)
            .timeout(Duration::from_secs(config.timeout_secs))
            .redirect(Policy::limited(config.max_redirects))
            .use_rustls_tls()
            .build()
            .expect("reqwest client builder");
        Self {
            client,
            cookies,
            config,
        }
    }

    pub fn cookies(&self) -> Arc<Jar> {
        self.cookies.clone()
    }

    pub fn config(&self) -> &HttpConfig {
        &self.config
    }

    /// Rebuild the inner `reqwest::Client` with a new cookie jar. Called by
    /// `Session::soft_reset` to ensure cleared cookies take effect immediately.
    pub fn rebuild_with_cookies(&mut self, new_cookies: Arc<Jar>) {
        self.cookies = new_cookies.clone();
        self.client = reqwest::Client::builder()
            .cookie_provider(new_cookies)
            .user_agent(&self.config.user_agent)
            .timeout(Duration::from_secs(self.config.timeout_secs))
            .redirect(Policy::limited(self.config.max_redirects))
            .use_rustls_tls()
            .build()
            .expect("reqwest client builder");
    }

    pub async fn fetch(&self, url: &str) -> Result<FetchResult> {
        let response = self.client.get(url).send().await.map_err(|e| {
            if e.is_timeout() {
                BrowserError::Timeout {
                    ms: self.config.timeout_secs * 1000,
                }
            } else {
                BrowserError::Network(e)
            }
        })?;
        let final_url = response.url().clone();
        let status = response.status();
        let html = response.text().await?;
        if !status.is_success() {
            return Err(BrowserError::Http {
                status: status.as_u16(),
                url: final_url.to_string(),
            });
        }
        Ok(FetchResult {
            html,
            final_url,
            status,
        })
    }
}

pub struct HtmlPage {
    document: Html,
    base_url: Url,
}

impl HtmlPage {
    pub fn from_fetch(result: FetchResult) -> Result<Self> {
        let document = Html::parse_document(&result.html);
        Ok(Self {
            document,
            base_url: result.final_url,
        })
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn html(&self) -> String {
        self.document.html()
    }

    pub fn title(&self) -> String {
        use scraper::Selector;
        let Ok(sel) = Selector::parse("title") else {
            return String::new();
        };
        self.document
            .select(&sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default()
    }

    pub fn document(&self) -> &Html {
        &self.document
    }

    /// Returns `true` if the page looks like a client-rendered SPA shell —
    /// a known mount element (`#root`, `<app-root>`, etc.) that has no
    /// visible text content. The `threshold_bytes` argument is reserved
    /// for future tuning (Phase 2) and is currently unused: the heuristic
    /// is purely "is the mount element text empty?".
    pub fn is_empty_shell(&self, _threshold_bytes: usize) -> bool {
        use scraper::Selector;
        let roots = ["#root", "#app", "#__next", "app-root", "ng-app"];
        for sel_str in roots {
            let Ok(sel) = Selector::parse(sel_str) else {
                continue;
            };
            if let Some(el) = self.document.select(&sel).next() {
                let text: String = el.text().collect::<Vec<_>>().join(" ");
                if text.trim().is_empty() {
                    return true;
                }
            }
        }
        false
    }

    pub fn detect_framework(&self) -> FrameworkHint {
        let html_lower = self.document.html().to_lowercase();
        let has_next_data = html_lower.contains("__next_data__");
        let has_ng_server = html_lower.contains("ng-server-context");
        let has_data_server = html_lower.contains("data-server-rendered");
        let is_shell = self.is_empty_shell(50);

        if has_next_data {
            if is_shell {
                FrameworkHint::NextCsr
            } else {
                FrameworkHint::NextSsr
            }
        } else if has_ng_server {
            FrameworkHint::AngularUniv
        } else if has_data_server {
            FrameworkHint::VueSsr
        } else if is_shell {
            // Generic SPA root with no SSR markers.
            if html_lower.contains("react") {
                FrameworkHint::ReactCsr
            } else {
                FrameworkHint::AngularCsr
            }
        } else {
            FrameworkHint::Static
        }
    }

    pub fn extract_text(&self) -> String {
        crate::utils::extract_text(&self.document)
    }

    pub fn extract_links(&self) -> Vec<Link> {
        crate::utils::extract_links(&self.document, &self.base_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(html: &str) -> HtmlPage {
        let fetch = FetchResult {
            html: html.to_string(),
            final_url: Url::parse("https://example.com/").unwrap(),
            status: reqwest::StatusCode::OK,
        };
        HtmlPage::from_fetch(fetch).unwrap()
    }

    #[test]
    fn title_extraction() {
        let p = page("<html><head><title>Hi</title></head><body></body></html>");
        assert_eq!(p.title(), "Hi");
    }

    #[test]
    fn empty_shell_detected() {
        let p = page(r#"<html><body><div id="root"></div></body></html>"#);
        assert!(p.is_empty_shell(50));
    }

    #[test]
    fn populated_root_passes() {
        let p =
            page(r#"<html><body><div id="root"><h1>Hello</h1><p>World</p></div></body></html>"#);
        assert!(!p.is_empty_shell(50));
    }

    #[test]
    fn framework_hints() {
        let next_ssr = page(
            r#"<html><body><div id="__next"><script>self.__NEXT_DATA__ = {}</script><h1>Hi</h1></div></body></html>"#,
        );
        assert!(matches!(
            next_ssr.detect_framework(),
            FrameworkHint::NextSsr
        ));

        let next_csr = page(
            r#"<html><body><div id="__next"></div><script>self.__NEXT_DATA__ = {}</script></body></html>"#,
        );
        assert!(matches!(
            next_csr.detect_framework(),
            FrameworkHint::NextCsr
        ));

        // A bare `#root` with no framework markers classifies as the
        // generic CSR shell — we can't tell React from Angular without
        // additional signal in Phase 1.
        let unknown_csr = page(r#"<html><body><div id="root"></div></body></html>"#);
        assert!(matches!(
            unknown_csr.detect_framework(),
            FrameworkHint::AngularCsr
        ));

        // When the bundle script contains the word "react", we pick React.
        let react_csr = page(
            r#"<html><body><div id="root"></div><script src="/bundle.react.js"></script></body></html>"#,
        );
        assert!(matches!(
            react_csr.detect_framework(),
            FrameworkHint::ReactCsr
        ));

        let static_ = page(r#"<html><body><h1>Plain</h1></body></html>"#);
        assert!(matches!(static_.detect_framework(), FrameworkHint::Static));
    }
}
