use std::sync::Arc;

use slim_atlas::config::Config;
use slim_atlas::error::Result;
use slim_atlas::mcp::serve_stdio;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load()?;
    let state = Arc::new(slim_atlas::state::AppState::new(config).await?);
    serve_stdio(state).await
}
