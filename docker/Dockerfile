FROM node:22-alpine AS builder

WORKDIR /app

# Install build deps: OpenSSL for Prisma, ffmpeg + opus for prism-media audio pipeline.
# python3/make/g++/opus-dev are required to compile @discordjs/opus (native Node addon).
# libsodium-wrappers is pure JS — no extra deps needed for encryption.
RUN apk add --no-cache \
    openssl \
    ffmpeg \
    opus-dev \
    python3 \
    make \
    g++

# Copy package files first for better layer caching
COPY package*.json ./
# Use npm install so the lock file is always regenerated when package.json changes.
# (npm ci would fail if package-lock.json is out of sync with package.json)
RUN npm install

# Copy Prisma schema and migrations
COPY prisma ./prisma/

# Generate Prisma client BEFORE TypeScript compilation
RUN npx prisma generate

# Copy the rest of the application
COPY . .

# Build the application
RUN npm run build

FROM node:22-alpine

# Embed the commit SHA as a label so the image manifest digest always changes
# on every push, even when all layers are cache hits. Watchtower compares
# manifest digests — without this, a fully-cached build produces the same
# digest as the previous :latest and Watchtower skips the pull.
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.revision="${BUILD_SHA}"

# Install runtime deps: OpenSSL (Prisma), ffmpeg + opus (audio pipeline),
# libstdc++ (required by @discordjs/opus native addon on Alpine),
# shadow + su-exec (entrypoint user switching)
RUN apk add --no-cache openssl shadow su-exec ffmpeg opus libstdc++ && \
    ln -s /usr/lib/libssl.so.3 /lib/libssl.so.3

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/personalities ./personalities

# Copy entrypoint script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories for data and logs with wide permissions
RUN mkdir -p /app/data /app/logs && \
    chmod 777 /app/data /app/logs

# Set the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
