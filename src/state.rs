use std::sync::{Arc, Mutex};

use url::Url;

use crate::config::Config;
use crate::deno::DenoRenderer;
use crate::deno_runtime::DenoRuntime;
use crate::error::BrowserError;
use crate::memory::MemoryProbe;
use crate::session::SessionStore;

/// `AppState` is the shared state passed to every MCP tool handler. It holds
/// the immutable config plus a couple of `Arc`s for things that need to be
/// shared (the session store) or per-session (the Deno runtime).
pub struct AppState {
    pub config: Arc<Config>,
    pub sessions: Arc<SessionStore>,
    pub security: Arc<SecurityPolicy>,
    /// Process memory probe. Held in a `Mutex` because `sysinfo::System`
    /// requires `&mut self` to refresh; the lock is held only for the
    /// microsecond duration of a sample.
    pub memory: Arc<Mutex<MemoryProbe>>,
    /// Deno runtime for page rendering.
    pub deno: Arc<DenoRuntime>,
    /// Deno renderer facade (pool + cookie round-trip + host allowlist).
    pub renderer: Arc<DenoRenderer>,
}

impl AppState {
    pub async fn new(config: Config) -> Result<Self, BrowserError> {
        let ttl = std::time::Duration::from_secs(config.session.ttl_minutes * 60);
        let sessions = Arc::new(SessionStore::new(ttl, config.session.max_sessions));
        sessions.clone().spawn_cleanup_task();

        let security = Arc::new(SecurityPolicy::from(&config.security));
        let memory = Arc::new(Mutex::new(MemoryProbe::new()));
        let rt = Arc::new(DenoRuntime::new(Arc::new(config.deno.clone())));
        let renderer = DenoRenderer::new(rt.clone(), security.clone(), config.http.clone())?;
        Ok(Self {
            config: Arc::new(config),
            sessions,
            security,
            memory,
            deno: rt,
            renderer: Arc::new(renderer),
        })
    }

    /// Returns the Deno runtime.
    pub fn deno(&self) -> Result<Arc<DenoRuntime>, BrowserError> {
        Ok(self.deno.clone())
    }

    /// Returns the Deno renderer.
    pub fn renderer(&self) -> Result<Arc<DenoRenderer>, BrowserError> {
        Ok(self.renderer.clone())
    }

    /// PIDs of any Deno subprocesses we want included in `MemoryProbe::sample`.
    pub fn child_pids(&self) -> Vec<u32> {
        Vec::new()
    }
}

#[derive(Debug)]
pub struct SecurityPolicy {
    pub allowed_hosts: Vec<HostPattern>,
    pub block_third_party_cookies: bool,
}

#[derive(Debug, Clone)]
pub enum HostPattern {
    Exact(String),
    WildcardSubdomain(String), // *.example.com — matches subdomains, NOT the bare host
}

impl HostPattern {
    pub fn matches(&self, host: &str) -> bool {
        match self {
            HostPattern::Exact(exact) => host == exact,
            HostPattern::WildcardSubdomain(base) => {
                host.len() > base.len() + 1
                    && host.ends_with(base)
                    && host.as_bytes()[host.len() - base.len() - 1] == b'.'
            }
        }
    }
}

impl SecurityPolicy {
    pub fn from(cfg: &crate::config::SecurityConfig) -> Self {
        let allowed_hosts = cfg
            .allowed_hosts
            .iter()
            .filter_map(|s| {
                if let Some(base) = s.strip_prefix("*.") {
                    Some(HostPattern::WildcardSubdomain(base.to_string()))
                } else if s.is_empty() {
                    None
                } else {
                    Some(HostPattern::Exact(s.clone()))
                }
            })
            .collect();
        Self {
            allowed_hosts,
            block_third_party_cookies: cfg.block_third_party_cookies,
        }
    }

    /// No-op if `allowed_hosts` is empty. Returns `SecurityViolation` if the
    /// URL's host doesn't match any pattern.
    pub fn assert_host_allowed(&self, url: &Url) -> Result<(), BrowserError> {
        if self.allowed_hosts.is_empty() {
            return Ok(());
        }
        let Some(host) = url.host_str() else {
            return Err(BrowserError::SecurityViolation {
                host: url.to_string(),
            });
        };
        if self.allowed_hosts.iter().any(|p| p.matches(host)) {
            Ok(())
        } else {
            Err(BrowserError::SecurityViolation {
                host: host.to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SecurityConfig;

    fn policy(patterns: &[&str]) -> SecurityPolicy {
        let cfg = SecurityConfig {
            allowed_hosts: patterns.iter().map(|s| s.to_string()).collect(),
            block_third_party_cookies: true,
        };
        SecurityPolicy::from(&cfg)
    }

    #[test]
    fn empty_list_allows_all() {
        let p = policy(&[]);
        assert!(p
            .assert_host_allowed(&Url::parse("https://anywhere.test/").unwrap())
            .is_ok());
    }

    #[test]
    fn exact_match() {
        let p = policy(&["example.com"]);
        assert!(p
            .assert_host_allowed(&Url::parse("https://example.com/").unwrap())
            .is_ok());
        assert!(p
            .assert_host_allowed(&Url::parse("https://other.com/").unwrap())
            .is_err());
    }

    #[test]
    fn wildcard_does_not_match_bare_host() {
        let p = policy(&["*.example.com"]);
        assert!(p
            .assert_host_allowed(&Url::parse("https://example.com/").unwrap())
            .is_err());
    }

    #[test]
    fn wildcard_matches_subdomain() {
        let p = policy(&["*.example.com"]);
        assert!(p
            .assert_host_allowed(&Url::parse("https://a.example.com/").unwrap())
            .is_ok());
        assert!(p
            .assert_host_allowed(&Url::parse("https://a.b.example.com/").unwrap())
            .is_ok());
        assert!(p
            .assert_host_allowed(&Url::parse("https://notexample.com/").unwrap())
            .is_err());
    }
}
