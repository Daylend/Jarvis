# syntax=docker/dockerfile:1.7
#
# Moonshine Voice ASR sidecar. CPU only. No Vulkan, no ROCm, no compile-from-source.
# All the GPU plumbing from the previous (whisper.cpp + Vulkan) image is gone.
FROM python:3.12-slim AS base

ARG BUILD_SHA=dev
LABEL org.opencontainers.image.revision="${BUILD_SHA}"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Runtime libs only:
#   - libgomp1: OpenMP runtime ONNX Runtime links against
#   - curl: used by the healthcheck and as a fallback fetcher
#   - ca-certificates: TLS for model downloads
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/asr/requirements.txt .
RUN pip install -r requirements.txt

COPY services/asr/app     ./app
COPY services/asr/scripts ./scripts
COPY services/asr/fixtures ./fixtures
COPY services/asr/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/scripts/*.sh

# Bake the English Medium Streaming model into the image so container start is
# instant and we don't need network access at runtime. The download script is
# idempotent, so a deferred-download image variant (BAKE_MODEL=false) just runs
# the same script at first boot.
ARG BAKE_MODEL=true
ENV MOONSHINE_MODEL_DIR=/app/models
ENV MOONSHINE_LANGUAGE=en
RUN if [ "$BAKE_MODEL" = "true" ]; then /app/scripts/download-model.sh; fi

EXPOSE 8765
ENTRYPOINT ["/app/entrypoint.sh"]
