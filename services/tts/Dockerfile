ARG BASE_IMAGE=rocm/pytorch:latest
FROM ${BASE_IMAGE}

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/hf
ENV TORCH_HOME=/models/torch
ENV TTS_DEVICE=cuda:0
ENV TTS_PORT=8860
ENV TTS_REF_AUDIO=/app/voice_samples/ultron.mp3
ENV TTS_VOCODER_NAME=vocos
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY services/tts/requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

COPY voice_samples/ultron.mp3 /app/voice_samples/ultron.mp3
COPY services/tts/app /app/app

RUN mkdir -p /app/data /models/hf /models/torch \
    && chmod -R 777 /app/data /models

EXPOSE 8860

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=300s \
    CMD curl -f http://localhost:8860/healthz || exit 1

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8860", "--workers", "1"]
