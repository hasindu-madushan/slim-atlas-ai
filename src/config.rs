use std::time::Duration;

use serde::Deserialize;

use crate::error::BrowserError;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub http: HttpConfig,
    #[serde(default)]
    pub tiers: TiersConfig,
    #[serde(default)]
    pub tier2: Tier2Config,
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
        if let Ok(v) = std::env::var("MCP_MAX_TIER") {
            let n: u8 = v
                .parse()
                .map_err(|_| BrowserError::Parse(format!("MCP_MAX_TIER not a u8: {v}")))?;
            builder = builder
                .set_override("tiers.max_tier", n)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        if let Ok(v) = std::env::var("MCP_LOG_LEVEL") {
            builder = builder
                .set_override("server.log_level", v)
                .map_err(|e| BrowserError::Parse(format!("config override: {e}")))?;
        }
        if let Ok(v) = std::env::var("DENO_PATH") {
            builder = builder
                .set_override("tier2.deno_path", v)
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
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            user_agent: "Mozilla/5.0 (compatible; slim-atlas/0.1)".into(),
            timeout_secs: 30,
            max_redirects: 10,
            max_body_bytes: 10_485_760,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TiersConfig {
    pub enabled: Vec<u8>,
    pub max_tier: u8,
    pub escalate_on_empty_dom: bool,
    pub escalate_threshold_bytes: usize,
}

impl Default for TiersConfig {
    fn default() -> Self {
        Self {
            enabled: vec![1],
            max_tier: 1,
            escalate_on_empty_dom: false,
            escalate_threshold_bytes: 50,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tier2Config {
    pub deno_path: String,
    pub script_path: String,
    pub pool_size: usize,
    pub idle_timeout_secs: u64,
    pub render_timeout_ms: u64,
}

impl Default for Tier2Config {
    fn default() -> Self {
        Self {
            deno_path: "/usr/local/bin/deno".into(),
            script_path: "./deno/render.ts".into(),
            pool_size: 2,
            idle_timeout_secs: 30,
            render_timeout_ms: 10_000,
        }
    }
}

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
        assert_eq!(cfg.tiers.enabled, vec![1]);
        assert_eq!(cfg.tiers.max_tier, 1);
        assert_eq!(cfg.tier2.pool_size, 2);
        assert_eq!(cfg.session.ttl_minutes, 30);
        assert!(cfg.security.block_third_party_cookies);
    }
}
