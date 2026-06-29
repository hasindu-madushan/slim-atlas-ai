FROM node:18-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build


# Fetch the Lightpanda binary at build time so the runtime image is self-contained
# and the app never re-downloads. Override version via build arg:
# docker build --build-arg LIGHTPANDA_VERSION=0.3.3 -t slimatlas .
#
# uname -m reports the container's actual build arch (x86_64 / aarch64) and maps
# 1:1 to the asset suffix, so the binary always matches the platform being built —
# no TARGETARG shadowing ambiguity across builders.
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


FROM node:18-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=lightpanda /app/lightpanda ./lightpanda


# Headful Chrome runtime libs + Xvfb, installed only when building the headful
# variant:
# docker build --build-arg FALLBACK_BROWSER=headful .
# Default build (no arg) skips this RUN entirely and gains zero bytes.
# Puppeteer launches its own bundled Chrome, so we install shared libs only.
ARG FALLBACK_BROWSER=none

RUN if [ "$FALLBACK_BROWSER" = "headful" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
        xvfb ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
        libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
        libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
        libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
        libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
        libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils && \
    rm -rf /var/lib/apt/lists/*; \
    fi

ENV FALLBACK_BROWSER=$FALLBACK_BROWSER

EXPOSE 8080

ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    LIGHTPANDA_VERSION=nightly

CMD ["node", "dist/index.js"]