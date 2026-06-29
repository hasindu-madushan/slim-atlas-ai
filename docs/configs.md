# Configuration

Every env var can also be passed as a lower-case CLI flag in `--flag=value` form. CLI flags override env vars. Unknown flags cause the server to exit at startup.

```bash
# Example: CLI flags
npx tsx src/index.ts --fallback-browser=headful --lightpanda-pool-size=3 --navigate-timeout=60000

# Example: .env file
FALLBACK_BROWSER=headful
LIGHTPANDA_POOL_SIZE=3
NAVIGATE_TIMEOUT=60000
```

## Transport

The server runs over **stdio** by default (for local MCP clients that spawn it as a subprocess). Set `MCP_TRANSPORT=http` to run as a standalone Streamable HTTP MCP server on a single `/mcp` endpoint (for remote / multi-client use).

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `MCP_TRANSPORT` | `--transport` | enum | `stdio` | Transport mode. One of: `stdio`, `http`. |
| `MCP_PORT` | `--port` | number | `3000` | HTTP listen port (only when `MCP_TRANSPORT=http`). |
| `MCP_HOST` | `--host` | string | `127.0.0.1` | HTTP bind host (only when `MCP_TRANSPORT=http`). Use `0.0.0.0` to expose remotely — combine with `MCP_AUTH_TOKEN`. |
| `MCP_AUTH_TOKEN` | `--auth-token` | string | (empty) | When set, HTTP requests must carry `Authorization: Bearer <token>`. Only enforced in `http` mode. Empty = open access (safe only behind loopback). |
| `LOG_TO_STDOUT` | `--log-to-stdout` | boolean | (auto) | Mirror INFO/DEBUG logs to stdout. When unset, auto-enabled if `MCP_TRANSPORT=http` (so `docker logs` works); in stdio mode stdout stays clean for the JSON-RPC stream. Set explicitly to override the auto rule. |

```bash
# Local, open (loopback only)
npx tsx src/index.ts --transport=http --port=8080

# Remote, authenticated
MCP_AUTH_TOKEN=s3cret npx tsx src/index.ts --transport=http --host=0.0.0.0 --port=8080
```

## Browser (Core)

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `LIGHTPANDA_BASE_PORT` | `--lightpanda-base-port` | number | `9222` | Base port for the lightweight browser instances. Each instance gets an incremented port. |
| `LIGHTPANDA_POOL_SIZE` | `--lightpanda-pool-size` | number | `5` | Number of lightweight browser instances to keep in the pool. |
| `LIGHTPANDA_VERSION` | `--lightpanda-version` | string | `nightly` | Release tag fetched if the binary is missing on startup. Any `lightpanda-io/browser` tag (`nightly`, `0.3.3`, …) works. The Docker image bakes the binary in at build time; override via `--build-arg LIGHTPANDA_VERSION=…`. |

## Fallback Browser

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `FALLBACK_BROWSER` | `--fallback-browser` | enum | `none` | Level 2 browser. One of: `headful`, `browserbase`, `browserless`, `none`. When the default browser crashes, times out, or is bot-detected, the session switches once to this fallback. `none` = no fallback, errors propagate. |
| `SKIP_LIGHTPANDA_DOMAINS` | `--skip-lightpanda-domains` | string | (empty) | Comma-separated list of domains that skip the lightweight browser and start directly on the fallback. Subdomain-aware (e.g. `g2.com` matches `www.g2.com`). Requires `FALLBACK_BROWSER != none`. |
| `CHROME_POOL_SIZE` | `--chrome-pool-size` | number | `1` | Number of headless Chrome instances in the fallback pool (when using `headless`). |

## Browserbase (Cloud)

Required only when `FALLBACK_BROWSER=browserbase`.

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `BROWSERBASE_API_KEY` | `--browserbase-api-key` | string | (empty) | Browserbase API key. |
| `BROWSERBASE_PROJECT_ID` | `--browserbase-project-id` | string | (empty) | Browserbase project ID. |
| `BROWSERBASE_API_URL` | `--browserbase-api-url` | string | `https://api.browserbase.com/v1` | Browserbase REST API base URL. |
| `BROWSERBASE_CONNECT_HOST` | `--browserbase-connect-host` | string | `wss://connect.browserbase.com` | Browserbase WebSocket connect host. |

## Browserless (Cloud)

Required only when `FALLBACK_BROWSER=browserless`.

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `BROWSERLESS_TOKEN` | `--browserless-token` | string | (empty) | Browserless authentication token. |
| `BROWSERLESS_ENDPOINT` | `--browserless-endpoint` | string | `wss://production-sfo.browserless.io` | Browserless WebSocket endpoint. Region-specific: `sfo`, `lon`, `ams`. |

## Session Management

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `MAX_SESSIONS` | `--max-sessions` | number | `0` | Hard cap on concurrent sessions. `0` = unlimited. |

## Stealth / Anti-Detection

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `STEALTH_ENABLED` | `--stealth-enabled` | boolean | `true` | Enable stealth plugins to reduce bot detection fingerprinting. |
| `HUMAN_DELAYS_ENABLED` | `--human-delays-enabled` | boolean | `true` | Add random human-like delays between actions to avoid detection. |
| `USER_AGENT` | `--user-agent` | string | (Chrome default) | Custom User-Agent string for all requests. |

## Proxy

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `PROXY_SERVER` | `--proxy-server` | string | (empty) | HTTP proxy applied to all browser layers. Supports inline basic auth: `http://user:pass@host:port`. |

## Navigation

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `NAVIGATE_WAIT_UNTIL` | `--navigate-wait-until` | enum | `domcontentloaded` | When to consider navigation complete. One of: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. |
| `NAVIGATE_TIMEOUT` | `--navigate-timeout` | number | `30000` | Maximum time (ms) to wait for navigation before timing out. |

## Snapshot

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `SNAPSHOT_FLATTEN` | `--snapshot-flatten` | boolean | `true` | Flatten nested accessibility tree nodes for compact output. |
| `SNAPSHOT_TEXT_TRIM_LENGTH` | `--snapshot-text-trim-length` | number | `200` | Maximum characters for text content in snapshot nodes. Longer text is truncated. |

## Rate Limiting

Disabled by default. Enable with a non-empty domain list **and** a non-zero delay.

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `RATE_LIMIT_DOMAINS` | `--rate-limit-domains` | string | (empty) | Comma-separated domains to rate-limit. Supports wildcards: `*` (all hosts), `*.reddit.com` (subdomains only), `g2.com` (apex + subdomains). |
| `RATE_LIMIT_MIN_DELAY_MS` | `--rate-limit-min-delay-ms` | number | `0` | Minimum delay (ms) between navigates to rate-limited domains. |
| `RATE_LIMIT_JITTER_MS` | `--rate-limit-jitter-ms` | number | `0` | Random jitter (0..value ms) added to each delay to avoid fixed-interval fingerprinting. |

## Cleanup

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `CLEANUP_INTERVAL_MS` | `--cleanup-interval-ms` | number | `600000` | How often (ms) the idle cleanup timer runs. |
| `SESSION_IDLE_TIMEOUT_MS` | `--session-idle-timeout-ms` | number | `300000` | Sessions idle longer than this (ms) are released automatically. |

## Resource Logging

| Env Var | CLI Flag | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `RESOURCE_LOGGING_ENABLED` | `--resource-logging-enabled` | boolean | `true` | Periodically log session count and browser memory usage. |
