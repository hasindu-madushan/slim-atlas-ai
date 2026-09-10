FROM debian:bookworm-slim AS lightpanda
ARG LIGHTPANDA_VERSION=nightly
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN ARCH=$(uname -m) && \
    curl -fsSL -o lightpanda \
    "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-${ARCH}-linux" && \
    chmod +x lightpanda && \
    test -s lightpanda

FROM oven/bun:1-slim
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./
COPY --from=lightpanda /app/lightpanda ./lightpanda

ARG FALLBACK_BROWSER=none
# TARGETARCH is injected by BuildKit from --platform. The fallback browser is
# Chrome-for-Testing pinned to a version Reddit's bot wall does not target: current
# stable (15x) gets "Prove your humanity" even with full stealth, while 131 passes.
# Verified empirically: same container env + proxy, 131 renders threads, 152 walls.
ARG TARGETARCH
ARG CHROME_CFT_VERSION=131.0.6778.204
RUN if [ "$FALLBACK_BROWSER" = "headful" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
        xvfb ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
        libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
        libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
        libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
        libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
        libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils wget unzip && \
    if [ "$TARGETARCH" = "amd64" ]; then \
        wget -q -O /tmp/chrome.zip \
            "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_CFT_VERSION}/linux64/chrome-linux64.zip" && \
        unzip -q /tmp/chrome.zip -d /opt && rm /tmp/chrome.zip && \
        ln -sf /opt/chrome-linux64/chrome /usr/bin/chromium; \
    else \
        apt-get install -y --no-install-recommends chromium; \
    fi && \
    rm -rf /var/lib/apt/lists/*; \
    fi
ENV FALLBACK_BROWSER=$FALLBACK_BROWSER \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    LIGHTPANDA_VERSION=nightly
# ponytail: Bun runs TypeScript natively — no build step needed.
# The shell watchdog polls the trivial /foo route (auth-gated but always answered by a
# live event loop). If the runtime freezes, the watchdog SIGKILLs the server (SIGTERM
# is useless — a frozen loop never runs the handler) and exits so the container's
# restart policy brings it back — a wedged server self-heals.
HEALTHCHECK --interval=15s --timeout=6s --start-period=10s --retries=3 \
  CMD bun -e "await fetch('http://127.0.0.1:8080/foo').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "bun src/index.ts & SRV=$!; while sleep 30; do bun -e \"await fetch('http://127.0.0.1:8080/foo', { signal: AbortSignal.timeout(8000) }).catch(() => process.exit(1))\" || { echo '[watchdog] server unresponsive, killing for restart' >&2; kill -9 $SRV 2>/dev/null; pkill -9 -P $SRV 2>/dev/null; sleep 1; exit 1; }; done; wait $SRV"]
