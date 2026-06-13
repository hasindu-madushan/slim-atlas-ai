use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::error::BrowserError;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub http: HttpConfig,
    #[serde(default)]
    pub deno: DenoConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    #[serde(default)]
    pub session: SessionConfig,
    #[serde(default)]
    pub server: ServerConfig,
}

impl Config {
    pub fn load() -> Result<Self, BrowserError> {
        let path = std::env::var("SLIM_ATLAS_CONFIG").unwrap_or_else(|_| "config.toml".to_string());
        let mut builder = config::Config::builder()
            .add_source(config::File::with_name(&path).required(false))
            // Re-add defaults so missing keys still resolve.
            .add_source(config::File::from_str(
                include_str!("../config.toml"),
                config::FileFormat::Toml,
            ));
        if let Ok(v) = std::env::var("MCP_TRANSPORT") {
            builder = builder
                .set_override("server.transport", v)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        if let Ok(v) = std::env::var("MCP_LOG_LEVEL") {
            builder = builder
                .set_override("server.log_level", v)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        if let Ok(v) = std::env::var("DENO_PATH") {
            builder = builder
                .set_override("deno.deno_path", v)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        if let Ok(v) = std::env::var("DENO_VERSION") {
            builder = builder
                .set_override("deno.deno_version", v)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        let cfg: Config = builder
            .build()
            .map_err(|e| BrowserError::Parse(format!("config build: {e}")))?
            .try_deserialize()
            .map_err(|e| BrowserError::Parse(format!("config deserialize: {e}")))?;
        Ok(cfg)
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.http.timeout_secs)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct HttpConfig {
    pub user_agent: String,
    pub timeout_secs: u64,
    pub max_redirects: usize,
    pub max_body_bytes: usize,
    /// Additional headers sent with every T1 and T2 request. Keys are
    /// header names; values are header values. These are merged after
    /// the built-in browser-like defaults, so they can override them.
    #[serde(default)]
    pub extra_headers: HashMap<String, String>,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".into(),
            timeout_secs: 30,
            max_redirects: 10,
            max_body_bytes: 10_485_760,
            extra_headers: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DenoConfig {
    /// Path to the `deno` binary. Empty string means "use auto-install":
    /// first check `~/.cache/slim-atlas/deno/<version>/deno`, then `deno`
    /// on `$PATH`, then download + extract to the cache.
    pub deno_path: String,
    /// Pinned Deno version for auto-install. Defaults to the latest known
    /// stable at build time. Override with the `DENO_VERSION` env var.
    pub deno_version: String,
    pub script_path: String,
    pub pool_size: usize,
    pub idle_timeout_secs: u64,
    pub render_timeout_ms: u64,
}

impl Default for DenoConfig {
    fn default() -> Self {
        Self {
            deno_path: String::new(),
            deno_version: LATEST_KNOWN_DENO_VERSION.into(),
            script_path: "./deno/render.ts".into(),
            pool_size: 2,
            idle_timeout_secs: 30,
            render_timeout_ms: 10_000,
        }
    }
}

/// Latest Deno version known at build time. Bumped when the project upgrades
/// its tested-against version. Overridable via `[deno].deno_version` or the
/// `DENO_VERSION` env var. Each release here MUST be accompanied by a
/// matching entry in `src/deno_runtime/install.rs::MANIFEST` (sha256 of the
/// per-platform zip).
pub const LATEST_KNOWN_DENO_VERSION: &str = "2.8.2";

#[derive(Debug, Clone, Deserialize)]
pub struct SecurityConfig {
    pub allowed_hosts: Vec<String>,
    pub block_third_party_cookies: bool,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            allowed_hosts: Vec::new(),
            block_third_party_cookies: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionConfig {
    pub ttl_minutes: u64,
    pub max_sessions: usize,
    pub persist: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            ttl_minutes: 30,
            max_sessions: 50,
            persist: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub transport: String,
    pub sse_port: u16,
    pub log_level: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            transport: "stdio".into(),
            sse_port: 3000,
            log_level: "info".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_config_string() {
        let cfg: Config = config::Config::builder()
            .add_source(config::File::from_str(
                include_str!("../config.toml"),
                config::FileFormat::Toml,
            ))
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!(cfg.http.timeout_secs, 30);
        assert!(cfg.http.user_agent.contains("Chrome"));
        assert!(cfg.http.extra_headers.is_empty());
        assert_eq!(cfg.deno.pool_size, 2);
        assert_eq!(cfg.deno.deno_version, LATEST_KNOWN_DENO_VERSION);
        assert!(cfg.deno.deno_path.is_empty());
        assert_eq!(cfg.session.ttl_minutes, 30);
        assert!(cfg.security.block_third_party_cookies);
    }

    #[test]
    fn latest_known_deno_version_is_semver_parsable() {
        // Defensive: the version string is embedded in download URLs and
        // cache directory names. Fail loudly if it gets malformed rather
        // than producing a bad URL.
        let v = LATEST_KNOWN_DENO_VERSION;
        let mut parts = v.split('.');
        let major: u32 = parts.next().unwrap().parse().expect("major");
        let minor: u32 = parts.next().unwrap().parse().expect("minor");
        let patch: u32 = parts.next().unwrap().parse().expect("patch");
        assert!(major >= 1);
        assert!(parts.next().is_none(), "no pre-release suffix");
        assert!(minor < 100);
        assert!(patch < 1000);
    }
}
