#!/bin/sh
# Download the whisper-large-v3-turbo Q5_0 GGUF model if not already present.
# The model is ~630 MB.
set -e

MODEL_DIR="${MODEL_DIR:-/app/models}"
MODEL_FILE="ggml-large-v3-turbo-q5_0.bin"
MODEL_PATH="${MODEL_DIR}/${MODEL_FILE}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_PATH" ]; then
  echo "[download-model] Model already present at ${MODEL_PATH}, skipping download."
  exit 0
fi

echo "[download-model] Downloading ${MODEL_FILE} from HuggingFace (~630 MB)..."
curl -L --progress-bar -o "${MODEL_PATH}.tmp" "$MODEL_URL"
mv "${MODEL_PATH}.tmp" "$MODEL_PATH"
echo "[download-model] Model saved to ${MODEL_PATH}."
