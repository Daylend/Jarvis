# syntax=docker/dockerfile:1.7

# ── Stage 1: Build pywhispercpp from source with Vulkan support ──────────────
# The PyPI wheel bundles its own CPU-only libwhisper.so (auditwheel-repaired)
# and ignores WHISPER_CPP_PATH at runtime. Building from source with
# GGML_VULKAN=ON makes pywhispercpp compile whisper.cpp internally with Vulkan.
#
# We must clone from git (not pip sdist) because pywhispercpp embeds whisper.cpp
# as a git submodule — the PyPI sdist tarball omits the submodule contents,
# causing "Cannot find source file: ggml.h" during cmake.
FROM ubuntu:24.04 AS pywhispercpp-build

ENV DEBIAN_FRONTEND=noninteractive
ENV CCACHE_DIR=/ccache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git \
      build-essential \
      cmake \
      ninja-build \
      ccache \
      pkg-config \
      libvulkan-dev \
      glslc \
      python3 \
      python3-pip \
      python3-dev \
      ca-certificates

# Install ALL Python requirements here so the runtime stage just copies /usr/local.
# This avoids pip version conflicts between the build-stage torch (pulled in by
# pywhispercpp) and the runtime-stage silero-vad torch dependency.
#
# pywhispercpp notes:
# - Use absadiki/pywhispercpp (the maintained fork; abdeladim-s is abandoned/malicious).
# - pip install git+... handles submodule init automatically (whisper.cpp is a submodule;
#   the PyPI sdist omits it, causing "Cannot find source file: ggml.h").
# - CMAKE_POLICY_VERSION_MINIMUM=3.5 silences the pybind11 cmake_minimum_required
#   deprecation error on cmake >= 3.27 (Ubuntu 24.04 ships cmake 3.28).
COPY services/asr/requirements.txt /tmp/requirements.txt
ARG PYWHISPERCPP_REF=v1.2.0
ENV CMAKE_ARGS="-DGGML_VULKAN=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5"
RUN --mount=type=cache,target=/ccache \
    pip3 install --break-system-packages --no-cache-dir \
      "git+https://github.com/absadiki/pywhispercpp.git@${PYWHISPERCPP_REF}" && \
    grep -v '^pywhispercpp' /tmp/requirements.txt | \
    pip3 install --break-system-packages --no-cache-dir -r /dev/stdin

# ── Diagnostics: print install locations so build logs show exactly where ────
# pywhispercpp and its shared libs landed. Useful for debugging linker issues.
RUN echo "=== pywhispercpp package location ===" && \
    python3 -c "import pywhispercpp; print(pywhispercpp.__file__)" 2>&1 || true
RUN echo "=== _pywhispercpp extension .so ===" && \
    find / -name '_pywhispercpp*.so' 2>/dev/null | grep -v '^/proc' || echo "(not found)"
RUN echo "=== libwhisper / libggml shared libs ===" && \
    find / \( -name 'libwhisper*.so*' -o -name 'libggml*.so*' \) 2>/dev/null \
    | grep -v '^/proc' || echo "(not found)"
RUN echo "=== site-packages dirs ===" && \
    python3 -c "import site; print('\n'.join(site.getsitepackages()))" 2>&1 || true

# Ensure libwhisper.so / libggml*.so are in /usr/local/lib so the runtime
# stage's "COPY /usr/local /usr/local" picks them up.
# pip --break-system-packages on Ubuntu 24.04 may install the extension and its
# bundled .so files under /usr/lib/python3/dist-packages instead of /usr/local.
# We find every whisper/ggml shared library anywhere on the system and copy it
# into /usr/local/lib so ldconfig in the runtime stage can register them.
RUN find / \( -name 'libwhisper*.so*' -o -name 'libggml*.so*' \) 2>/dev/null \
    | grep -v '^/proc' \
    | xargs -I{} cp -v {} /usr/local/lib/ 2>/dev/null || true
RUN echo "=== /usr/local/lib after staging ===" && \
    ls -lh /usr/local/lib/libwhisper*.so* /usr/local/lib/libggml*.so* 2>/dev/null || echo "(none staged)"

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

# Copy Python packages from the build stage.
# On Ubuntu 24.04, pip --break-system-packages may install to either:
#   /usr/local/lib/python3.12/dist-packages  (preferred)
#   /usr/lib/python3/dist-packages           (system fallback)
# We copy both to ensure _pywhispercpp.so and all dependencies are present.
# The libwhisper*.so / libggml*.so files were already staged into /usr/local/lib
# by the find+cp step above, so ldconfig will register them from there.
COPY --from=pywhispercpp-build /usr/local /usr/local
COPY --from=pywhispercpp-build /usr/lib/python3 /usr/lib/python3
RUN ldconfig

WORKDIR /app

COPY services/asr/app ./app
COPY services/asr/scripts ./scripts
RUN chmod +x ./scripts/download-model.sh

RUN mkdir -p /app/models

EXPOSE 8765

COPY services/asr/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]