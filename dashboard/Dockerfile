FROM node:22-alpine AS builder

WORKDIR /app

# CI builds with repo root as context; dev compose uses dashboard/ as context.
# Copy the dashboard's own package files from the dashboard/ subdir.
COPY dashboard/package*.json ./
RUN npm install --legacy-peer-deps

# Copy the dashboard source and build.
COPY dashboard/ ./
RUN npx svelte-kit sync && npx vite build

FROM node:22-alpine

ARG BUILD_SHA=dev
LABEL org.opencontainers.image.revision="${BUILD_SHA}"

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/server.js ./server.js

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
