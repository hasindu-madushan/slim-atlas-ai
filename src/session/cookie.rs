use std::sync::Arc;

use reqwest::cookie::{CookieStore, Jar};
use url::Url;

/// Per-session cookie store backed by a `reqwest::cookie::Jar`.
///
/// We hold the `Arc<Jar>` directly because `reqwest::ClientBuilder::cookie_provider`
/// takes an `Arc<Jar>`. The `Session` keeps a clone of this `Arc` alongside its
/// `reqwest::Client`.
///
/// Clearing cookies in Phase 1 means the `Session` rebuilds its `reqwest::Client`
/// with a fresh `Arc<Jar>`. This drops the per-session connection pool on reset,
/// which is acceptable (reset is rare, and connection pools are cheap to rebuild).
pub struct SessionCookies {
    jar: Arc<Jar>,
}

impl SessionCookies {
    pub fn new() -> Self {
        Self {
            jar: Arc::new(Jar::default()),
        }
    }

    /// Borrow the underlying `Arc<Jar>` for plugging into a reqwest client.
    pub fn jar(&self) -> Arc<Jar> {
        self.jar.clone()
    }

    /// Consume `self` and return the inner `Arc<Jar>`. Used by `Session::soft_reset`
    /// to swap in a fresh jar atomically.
    pub fn into_inner(self) -> Arc<Jar> {
        self.jar
    }

    /// Replace the stored `Arc<Jar>` with a fresh empty one. Returns the old one
    /// so the caller can rebuild any associated reqwest client.
    pub fn replace_with_empty(&mut self) -> Arc<Jar> {
        std::mem::replace(&mut self.jar, Arc::new(Jar::default()))
    }

    /// Render the cookies that should be attached to a request for `url`.
    /// Currently unused in Phase 1 (the reqwest `cookie_provider` does this
    /// automatically). Kept for the Phase 3 Deno cookie round-trip.
    #[allow(dead_code)]
    pub fn to_header_value(&self, url: &Url) -> Option<String> {
        self.jar
            .cookies(url)
            .and_then(|c| c.to_str().ok().map(|s| s.to_string()))
    }

    /// Merge a `Set-Cookie` header value into the jar.
    /// Phase 3+ Deno cookie round-trip will use this.
    #[allow(dead_code)]
    pub fn merge_from_header(&self, set_cookie: &str, url: &Url) {
        let host = url.host_str().unwrap_or("");
        let header_value = format!("{set_cookie}; Domain={host}; Path=/");
        if let Ok(parsed) = header_value.parse::<http::HeaderValue>() {
            self.jar.set_cookies(&mut std::iter::once(&parsed), url);
        }
    }
}

impl Default for SessionCookies {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_with_empty_empties_jar() {
        let mut c = SessionCookies::new();
        let url = Url::parse("https://example.com/").unwrap();
        let header = "session=abc; Domain=example.com; Path=/"
            .parse::<http::HeaderValue>()
            .unwrap();
        c.jar().set_cookies(&mut std::iter::once(&header), &url);
        assert!(c.to_header_value(&url).is_some());
        let _old = c.replace_with_empty();
        assert!(c.to_header_value(&url).is_none());
    }
}
