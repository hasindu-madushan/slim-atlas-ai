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
RUN if [ "$FALLBACK_BROWSER" = "headful" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
        xvfb chromium ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
        libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
        libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
        libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
        libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
        libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils && \
    rm -rf /var/lib/apt/lists/*; \
    fi
ENV FALLBACK_BROWSER=$FALLBACK_BROWSER \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    LIGHTPANDA_VERSION=nightly
# ponytail: Bun runs TypeScript natively — no build step needed
CMD ["bun", "run", "src/index.ts"]
