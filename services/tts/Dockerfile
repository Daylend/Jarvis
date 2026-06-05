ARG BASE_IMAGE=rocm/pytorch:rocm6.4.2_ubuntu22.04_py3.10_pytorch_release_2.6.0
FROM ${BASE_IMAGE}

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/hf
ENV TORCH_HOME=/models/torch
ENV TTS_DEVICE=cuda:0
ENV TTS_PORT=8860
ENV TTS_REF_AUDIO=/app/voice_samples/ultron.mp3
ENV TTS_VOCODER_NAME=vocos
# EPSS step count: must be one of {5,6,7,10,12,16} or EPSS falls back to uniform linspace.
# 12=baseline, 10=balanced, 7=fastest (validate on voice clones before deploying 7).
ENV TTS_CFG_STEPS=12
# CFG strength: 2.0 = full classifier-free guidance (EPSS paper recipe).
# 0.0 was unstable in testing; do not set below 1e-5 without validating.
ENV TTS_CFG_STRENGTH=2.0
ENV TTS_TORCH_COMPILE=true
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git ca-certificates curl \
    libavformat-dev libavcodec-dev libavutil-dev libavdevice-dev libavfilter-dev libswscale-dev libswresample-dev \
    && rm -rf /var/lib/apt/lists/*

COPY services/tts/requirements.txt /app/requirements.txt
COPY services/tts/constraints.txt /app/constraints.txt

# The ROCm base image ships torch + torchvision but NOT torchaudio. Install the matching
# ROCm torchaudio explicitly (the default PyPI torchaudio is a CUDA build → libcudart.so.13).
# A constraints file keeps every transitive dep (f5-tts) from replacing the ROCm torch stack.
RUN python -m pip install --upgrade pip wheel setuptools \
    && pip install --no-cache-dir --no-deps \
         "https://repo.radeon.com/rocm/manylinux/rocm-rel-6.4.2/torchaudio-2.6.0%2Brocm6.4.2.gitd8831425-cp310-cp310-linux_x86_64.whl" \
    && grep -vE '^(torch|torchaudio|torchvision|torchcodec)([<>=~! ]|$)' /app/requirements.txt > /tmp/requirements.runtime.txt \
    && pip install --no-cache-dir -c /app/constraints.txt -r /tmp/requirements.runtime.txt \
    && pip install --no-cache-dir --no-deps \
         --index-url https://download.pytorch.org/whl/cpu \
         "torchcodec==0.2.*"

COPY voice_samples/ultron.mp3 /app/voice_samples/ultron.mp3
COPY services/tts/app /app/app

RUN mkdir -p /app/data /models/hf /models/torch \
    && chmod -R 777 /app/data /models

EXPOSE 8860

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=600s \
    CMD curl -f http://localhost:8860/healthz || exit 1

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8860", "--workers", "1"]
