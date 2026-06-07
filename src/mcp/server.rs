use std::sync::Arc;

use rmcp::transport::stdio;
use rmcp::ServiceExt;
use tracing_subscriber::EnvFilter;

use crate::error::{BrowserError, Result};
use crate::mcp::tools::McpServer;
use crate::state::AppState;

/// Build the MCP service. The `#[tool_router(server_handler)]` macro on
/// `McpServer` generates the `ServerHandler` impl, so all we need to do is
/// construct the struct and hand it to the transport.
pub fn build_server(state: Arc<AppState>) -> McpServer {
    McpServer::new(state)
}

/// Serve over stdio. Installs the `tracing` subscriber first, then blocks
/// until the stdio transport shuts down.
pub async fn serve_stdio(state: Arc<AppState>) -> Result<()> {
    install_tracing(&state.config.server.log_level);

    let server = build_server(state);
    let service = server
        .serve(stdio())
        .await
        .map_err(|e| BrowserError::Parse(format!("mcp serve: {e}")))?;
    service
        .waiting()
        .await
        .map_err(|e| BrowserError::Parse(format!("mcp waiting: {e}")))?;
    Ok(())
}

fn install_tracing(log_level: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(log_level));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}
