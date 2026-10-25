# syntax=docker/dockerfile:1
#
# OpenDBS server image. Build from the release folder (OPENDBSBUILD):
#   docker build -t endurasolution/opendbs:1.0.1 .
# Works for linux/amd64 and linux/arm64 (docker buildx --platform ...).

# ── 1. Rust storage engine for Linux ─────────────────────────────────────────
FROM rust:1-bookworm AS engine
WORKDIR /src
COPY rust-engine/Cargo.toml rust-engine/Cargo.lock ./
COPY rust-engine/src ./src
RUN cargo build --release --locked \
 && cp target/release/libopendbs_engine.so /opendbs-engine.node

# ── 2. Production npm dependencies ───────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /opt/opendbs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ARG TARGETARCH
ARG VERSION=1.0.1

LABEL org.opencontainers.image.title="OpenDBS" \
      org.opencontainers.image.description="Document and SQL database server with an encrypted Rust storage engine, replication and sharding" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/endurasolution/opendbs" \
      org.opencontainers.image.licenses="CC-BY-NC-4.0"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4402 \
    DB_PATH=/data/db \
    BACKUP_PATH=/data/backups \
    OPENDBS_DATA=/data \
    ADMIN_PANEL_ENABLED=true \
    WEB_INTERFACE_ENABLED=true

WORKDIR /opt/opendbs
COPY --from=deps /opt/opendbs/node_modules ./node_modules
COPY package.json package-lock.json LICENSE.md README.md CHANGELOG.md SECURITY.md ./
COPY dist ./dist
COPY public ./public
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=engine /opendbs-engine.node /tmp/opendbs-engine.node

# The server loads opendbs-engine.<platform>.node from the package root.
# (sed: a Windows checkout may have given the script CRLF line endings.)
RUN case "${TARGETARCH:-amd64}" in \
      amd64) suffix=linux-x64-gnu ;; \
      arm64) suffix=linux-arm64-gnu ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && mv /tmp/opendbs-engine.node "./opendbs-engine.${suffix}.node" \
 && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data \
 && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 4402

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4402)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
