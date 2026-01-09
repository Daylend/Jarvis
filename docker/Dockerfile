FROM node:18-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy package files first for better layer caching
COPY package*.json ./
# Use npm ci if package-lock.json exists, otherwise use npm install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy Prisma schema and migrations
COPY prisma ./prisma/

# Generate Prisma client BEFORE TypeScript compilation
RUN npx prisma generate

# Copy the rest of the application
COPY . .

# Build the application
RUN npm run build

FROM node:18-alpine

# Install OpenSSL, shadow (for usermod), su-exec, and fix for Prisma engine on Alpine Linux
RUN apk add --no-cache openssl shadow su-exec && \
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