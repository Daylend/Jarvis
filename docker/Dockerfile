FROM node:18-slim AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

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

FROM node:18-slim

# Install dependencies including Python and TTS requirements
RUN apt-get update && apt-get install -y \
    openssl \
    python3 \
    python3-pip \
    ffmpeg \
    libsndfile1 \
    git \
    gosu \
    passwd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/tts-service ./tts-service

# Clone LuxTTS repository
RUN git clone https://github.com/ysharma3501/LuxTTS.git tts-service/LuxTTS

# Install Python requirements
RUN pip3 install --no-cache-dir --break-system-packages -r tts-service/requirements.txt

# Copy entrypoint script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories for data and logs with wide permissions
RUN mkdir -p /app/data /app/logs && \
    chmod 777 /app/data /app/logs

# Set the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
