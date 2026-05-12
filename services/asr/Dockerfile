# syntax=docker/dockerfile:1.7

# ── Stage 1: Build whisper.cpp with Vulkan support ───────────────────────────
FROM ubuntu:24.04 AS whisper-build

ENV DEBIAN_FRONTEND=noninteractive
ENV CCACHE_DIR=/ccache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git \
      build-essential \
      cmake \
      ccache \
      pkg-config \
      libvulkan-dev \
      mesa-vulkan-drivers \
      vulkan-tools \
      glslc \
      ca-certificates

WORKDIR /opt

# Pin this so whisper.cpp only rebuilds when you intentionally change it
ARG WHISPER_CPP_REF=v1.7.6
RUN git clone --depth 1 --branch ${WHISPER_CPP_REF} https://github.com/ggerganov/whisper.cpp.git

WORKDIR /opt/whisper.cpp
RUN --mount=type=cache,target=/ccache \
    cmake -B build \
      -DWHISPER_VULKAN=ON \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER_LAUNCHER=ccache \
      -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
 && cmake --build build --config Release -j"$(nproc)"

# ── Stage 2: Python runtime ───────────────────────────────────────────────────
FROM ubuntu:24.04

# Embed the commit SHA as a label so the image manifest digest always changes
# on every push, even when all layers are cache hits. Watchtower compares
# manifest digests — without this, a fully-cached build produces the same
# digest as the previous :latest and Watchtower skips the pull.
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.revision="${BUILD_SHA}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-dev \
      libvulkan1 \
      mesa-vulkan-drivers \
      vulkan-tools \
      ffmpeg \
      libsndfile1 \
      curl \
      ca-certificates

COPY --from=whisper-build /opt/whisper.cpp /opt/whisper.cpp
ENV WHISPER_CPP_PATH=/opt/whisper.cpp

WORKDIR /app

COPY services/asr/requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --break-system-packages -r requirements.txt

COPY services/asr/app ./app
COPY services/asr/scripts ./scripts
RUN chmod +x ./scripts/download-model.sh

RUN mkdir -p /app/models

EXPOSE 8765

COPY services/asr/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]