FROM node:18-alpine AS builder

WORKDIR /app

# Install build deps: OpenSSL for Prisma, ffmpeg + opus for prism-media audio pipeline.
# No native build tools needed: opusscript is pure JS (WASM), replacing @discordjs/opus.
RUN apk add --no-cache \
    openssl \
    ffmpeg \
    opus-dev

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

FROM node:18-alpine

# Install runtime deps: OpenSSL (Prisma), ffmpeg + opus (prism-media), shadow + su-exec (entrypoint)
RUN apk add --no-cache openssl shadow su-exec ffmpeg libopus && \
    ln -s /usr/lib/libssl.so.3 /lib/libssl.so.3

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Copy entrypoint script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories for data and logs with wide permissions
RUN mkdir -p /app/data /app/logs && \
    chmod 777 /app/data /app/logs

# Set the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
