export const CLI_FLAG_TO_ENV: Record<string, string> = {
  'lightpanda-base-port': 'LIGHTPANDA_BASE_PORT',
  'lightpanda-pool-size': 'LIGHTPANDA_POOL_SIZE',
  'fallback-browser': 'FALLBACK_BROWSER',
  'chrome-pool-size': 'CHROME_POOL_SIZE',
  'skip-lightpanda-domains': 'SKIP_LIGHTPANDA_DOMAINS',
  'browserbase-api-key': 'BROWSERBASE_API_KEY',
  'browserbase-project-id': 'BROWSERBASE_PROJECT_ID',
  'browserbase-api-url': 'BROWSERBASE_API_URL',
  'browserbase-connect-host': 'BROWSERBASE_CONNECT_HOST',
  'browserless-token': 'BROWSERLESS_TOKEN',
  'browserless-endpoint': 'BROWSERLESS_ENDPOINT',
  'max-sessions': 'MAX_SESSIONS',
  'stealth-enabled': 'STEALTH_ENABLED',
  'human-delays-enabled': 'HUMAN_DELAYS_ENABLED',
  'user-agent': 'USER_AGENT',
  'proxy-server': 'PROXY_SERVER',
  'cleanup-interval-ms': 'CLEANUP_INTERVAL_MS',
  'session-idle-timeout-ms': 'SESSION_IDLE_TIMEOUT_MS',
  'resource-logging-enabled': 'RESOURCE_LOGGING_ENABLED',
  'navigate-wait-until': 'NAVIGATE_WAIT_UNTIL',
  'navigate-timeout': 'NAVIGATE_TIMEOUT',
  'rate-limit-domains': 'RATE_LIMIT_DOMAINS',
  'rate-limit-min-delay-ms': 'RATE_LIMIT_MIN_DELAY_MS',
  'rate-limit-jitter-ms': 'RATE_LIMIT_JITTER_MS',
  'snapshot-flatten': 'SNAPSHOT_FLATTEN',
  'snapshot-text-trim-length': 'SNAPSHOT_TEXT_TRIM_LENGTH',
  'transport': 'MCP_TRANSPORT',
  'port': 'MCP_PORT',
  'host': 'MCP_HOST',
  'auth-token': 'MCP_AUTH_TOKEN',
  'lightpanda-version': 'LIGHTPANDA_VERSION',
  'log-to-stdout': 'LOG_TO_STDOUT',
};

const BOOLEAN_FLAGS = new Set([
  'stealth-enabled',
  'human-delays-enabled',
  'resource-logging-enabled',
  'snapshot-flatten',
  'log-to-stdout',
]);

const NUMERIC_FLAGS = new Set([
  'lightpanda-base-port',
  'lightpanda-pool-size',
  'chrome-pool-size',
  'max-sessions',
  'cleanup-interval-ms',
  'session-idle-timeout-ms',
  'navigate-timeout',
  'rate-limit-min-delay-ms',
  'rate-limit-jitter-ms',
  'snapshot-text-trim-length',
  'port',
]);

const ENUM_FLAGS: Record<string, string[]> = {
  'navigate-wait-until': ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
  'fallback-browser': ['headless', 'headful', 'browserbase', 'browserless', 'none'],
  'transport': ['stdio', 'http'],
};

function normalizeBoolean(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return 'true';
  if (lower === 'false' || lower === '0') return 'false';
  throw new Error(`Boolean flag must be true, false, 1, or 0. Got: ${value}`);
}

function parseValue(key: string, value: string): string {
  if (BOOLEAN_FLAGS.has(key)) {
    return normalizeBoolean(value);
  }

  if (NUMERIC_FLAGS.has(key)) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`--${key} must be a non-negative integer. Got: ${value}`);
    }
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 0) {
      throw new Error(`--${key} must be a non-negative integer. Got: ${value}`);
    }
    return String(n);
  }

  const allowed = ENUM_FLAGS[key];
  if (allowed && !allowed.includes(value)) {
    throw new Error(`Invalid value for --${key}: ${value}. Allowed: ${allowed.join(', ')}`);
  }

  return value;
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): Record<string, string> {
  const result: Record<string, string> = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new Error(`Invalid argument (must be --flag=value): ${arg}`);
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq === -1) {
      throw new Error(`Flag must use --flag=value syntax: ${arg}`);
    }

    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);

    if (!Object.prototype.hasOwnProperty.call(CLI_FLAG_TO_ENV, key)) {
      throw new Error(`Unknown flag: --${key}`);
    }

    if (value === '') {
      throw new Error(`Flag --${key} requires a non-empty value`);
    }

    result[key] = parseValue(key, value);
  }

  return result;
}

export function applyCliArgsToEnv(args: Record<string, string>): void {
  for (const [key, value] of Object.entries(args)) {
    process.env[CLI_FLAG_TO_ENV[key]] = value;
  }
}
