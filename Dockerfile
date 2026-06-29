FROM node:18-bookworm-slim AS builder
WORKDIR /app
# Skip Puppeteer's own Chrome download — Google doesn't ship an official
# Linux arm64 build, so it would silently fetch an x64 binary that can't
# run on an arm64 image without a working Rosetta/qemu loader. We use
# Debian's native `chromium` package in the runtime stage instead.
ENV PUPPETEER_SKIP_DOWNLOAD=true
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
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=lightpanda /app/lightpanda ./lightpanda

# Headful Chrome runtime: install Debian's native `chromium` package (built
# for both amd64 and arm64, so no cross-arch binary mismatch) plus Xvfb,
# only when building the headful variant:
# docker build --build-arg FALLBACK_BROWSER=headful .
# Default build (no arg) skips this RUN entirely and gains zero bytes.
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
CMD ["node", "dist/index.js"]