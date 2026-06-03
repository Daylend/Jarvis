ARG BASE_IMAGE=rocm/pytorch:latest
FROM ${BASE_IMAGE}

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/hf
ENV TRANSFORMERS_CACHE=/models/hf
ENV TORCH_HOME=/models/torch
ENV ASR_ENGINE=whisper
ENV ASR_MODEL_ID=openai/whisper-large-v3-turbo
ENV ASR_DEVICE=cuda:0
ENV ASR_DTYPE=float16
ENV ASR_PORT=8765
ENV ASR_ENABLE_PARTIALS=false
ENV ASR_LANGUAGE=en
ENV ASR_TASK=transcribe
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY services/asr/requirements-whisper.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

COPY services/asr/app /app/app

EXPOSE 8765

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
