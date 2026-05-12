# ── Stage 1: Build whisper.cpp with Vulkan support ───────────────────────────
FROM ubuntu:24.04 AS whisper-build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    cmake \
    pkg-config \
    libvulkan-dev \
    mesa-vulkan-drivers \
    vulkan-tools \
    glslc \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git

WORKDIR /opt/whisper.cpp
# Build with Vulkan backend enabled
RUN cmake -B build \
      -DWHISPER_VULKAN=ON \
      -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build --config Release -j$(nproc)

# ── Stage 2: Python runtime ───────────────────────────────────────────────────
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    # Vulkan runtime
    libvulkan1 \
    mesa-vulkan-drivers \
    vulkan-tools \
    # Audio / misc
    ffmpeg \
    libsndfile1 \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy whisper.cpp build artifacts (shared libs + headers needed by pywhispercpp)
COPY --from=whisper-build /opt/whisper.cpp /opt/whisper.cpp

# Set env so pywhispercpp can find the pre-built whisper.cpp
ENV WHISPER_CPP_PATH=/opt/whisper.cpp

WORKDIR /app

# Install Python dependencies
COPY services/asr/requirements.txt ./requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy application source
COPY services/asr/app ./app
COPY services/asr/scripts ./scripts
RUN chmod +x ./scripts/download-model.sh

# Create models directory
RUN mkdir -p /app/models

EXPOSE 8765

# Entrypoint: download model if missing, then start uvicorn
COPY services/asr/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
