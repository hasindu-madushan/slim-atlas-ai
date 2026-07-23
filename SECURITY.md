# Security Policy

## Reporting a vulnerability

If you find a security issue, **do not open a public issue**. Instead, use GitHub's [private vulnerability reporting](https://github.com/hasindu-madushan/slim-atlas-ai/security/advisories/new).

I'll acknowledge within 48 hours and aim to fix within 7 days. If the fix requires a coordinated disclosure timeline, we'll work that out together.

## Supported versions

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| Latest tagged release | ✅ |

No backport releases. Always update to `main` or the latest tag.

## What to report

Anything that could reasonably compromise users or their infrastructure:

- Auth token leaks (MCP_AUTH_TOKEN exposed in logs, responses, or error messages)
- Proxy credential leaks (PROXY_SERVER with inline basic auth appearing in logs)
- Session isolation bugs (one session accessing another session's browser state)
- Remote code execution vectors (unsanitized input in `browser_evaluate`, script injection in tool arguments)
- Unauthenticated access to HTTP transport when MCP_AUTH_TOKEN is set
- Secrets accidentally committed to the repo history

## What's out of scope

- Issues in dependencies (puppeteer, lightpanda, MCP SDK) — report those upstream unless SlimAtlas's usage is the cause
- Theoretical attacks requiring physical access to the machine
- Denial-of-service via resource exhaustion (MAX_SESSIONS exists to cap this; if you find a bypass, that's in scope)

## Browser automation safety

This tool launches real browsers that connect to real websites. A few things to know:

- **Isolation**: Each browser session is isolated via Puppeteer browser contexts. Sessions cannot access each other's cookies, storage, or pages.
- **Proxy layer**: When `PROXY_SERVER` is set, all traffic (both Lightpanda and Chrome fallback) goes through it. The proxy URL is not logged in normal operation.
- **Rate limiting**: Configure `RATE_LIMIT_DOMAINS` and `RATE_LIMIT_MIN_DELAY_MS` to avoid hammering sites. The server does not impose a global default — it's opt-in.
- **Data**: Navigated pages can execute arbitrary JavaScript. Use with trusted URLs or an isolated network environment.

## Token handling

SlimAtlas reads secrets only from environment variables or `.env`. It never:
- Logs auth tokens in debug or error output
- Includes tokens in MCP tool responses
- Stores secrets on disk (except what the OS swaps)

If you find a codepath that leaks a token, that's a reportable vulnerability.
