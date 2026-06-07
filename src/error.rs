use rmcp::model::ErrorCode;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("HTTP error: {status} for {url}")]
    Http { status: u16, url: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Deno subprocess failed: {stderr}")]
    DenoFailed { stderr: String },

    #[error("Deno not found at path: {path}")]
    DenoNotFound { path: String },

    #[error("Tier {tier} disabled in config or not yet implemented")]
    TierDisabled { tier: u8 },

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("No current page in session")]
    NoCurrentPage,

    #[error("Selector not found: {selector}")]
    SelectorNotFound { selector: String },

    #[error("Security: host not in allowlist: {host}")]
    SecurityViolation { host: String },

    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

pub type Result<T> = std::result::Result<T, BrowserError>;

/// Custom MCP error codes (negative, in the JSON-RPC -32000 to -32099 range).
#[allow(dead_code)]
mod code {
    pub const SESSION_NOT_FOUND: i32 = -32001;
    pub const NO_CURRENT_PAGE: i32 = -32002;
    pub const TIER_DISABLED: i32 = -32003;
    pub const SECURITY_VIOLATION: i32 = -32004;
    pub const TIMEOUT: i32 = -32005;
}

/// Extension trait that converts a [`BrowserError`] into an MCP [`ErrorData`].
///
/// Mapping rules (Q8):
/// - `SelectorNotFound` -> `ErrorData::invalid_params` (-32602)
/// - `Http`, `Network`, `Parse`, generic I/O, URL -> `ErrorData::internal_error` (-32603)
/// - `SessionNotFound`, `NoCurrentPage`, `TierDisabled`, `SecurityViolation`, `Timeout`
///   -> custom application codes in the -32000 range
/// - Everything else -> `ErrorData::internal_error` (-32603)
pub trait IntoMcpError {
    fn into_mcp_error(self) -> rmcp::model::ErrorData;
}

impl IntoMcpError for BrowserError {
    fn into_mcp_error(self) -> rmcp::model::ErrorData {
        use rmcp::model::ErrorData as McpError;
        match self {
            BrowserError::SelectorNotFound { .. } => {
                McpError::invalid_params(self.to_string(), None)
            }
            BrowserError::Http { status, url } => {
                McpError::internal_error(format!("HTTP {status} for {url}"), None)
            }
            BrowserError::Network(e) => McpError::internal_error(format!("network: {e}"), None),
            BrowserError::Parse(msg) => McpError::internal_error(format!("parse: {msg}"), None),
            BrowserError::Io(e) => McpError::internal_error(format!("io: {e}"), None),
            BrowserError::Url(e) => McpError::internal_error(format!("url: {e}"), None),
            BrowserError::SessionNotFound { id } => McpError::new(
                ErrorCode(code::SESSION_NOT_FOUND),
                format!("session not found: {id}"),
                None,
            ),
            BrowserError::NoCurrentPage => McpError::new(
                ErrorCode(code::NO_CURRENT_PAGE),
                "no current page in session".to_string(),
                None,
            ),
            BrowserError::TierDisabled { tier } => McpError::new(
                ErrorCode(code::TIER_DISABLED),
                format!("tier {tier} disabled in config or not yet implemented"),
                None,
            ),
            BrowserError::SecurityViolation { host } => McpError::new(
                ErrorCode(code::SECURITY_VIOLATION),
                format!("host not in allowlist: {host}"),
                None,
            ),
            BrowserError::Timeout { ms } => McpError::new(
                ErrorCode(code::TIMEOUT),
                format!("timeout after {ms}ms"),
                None,
            ),
            // Deno-related and any future variants fall through to internal_error
            other => McpError::internal_error(other.to_string(), None),
        }
    }
}

/// `?` glue: lets us write `BrowserError::X?` inside a fn returning
/// `Result<_, rmcp::model::ErrorData>`.
impl From<BrowserError> for rmcp::model::ErrorData {
    fn from(e: BrowserError) -> Self {
        e.into_mcp_error()
    }
}
