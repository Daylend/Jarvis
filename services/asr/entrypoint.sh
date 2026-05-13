#!/bin/sh
set -e

# Idempotent — skips work if the model is already on disk and pinned.
/app/scripts/download-model.sh

# Pin model path + arch into the env so app.config can read them.
# shellcheck disable=SC1091
. /app/models/moonshine.env
export MOONSHINE_MODEL_PATH MOONSHINE_MODEL_ARCH MOONSHINE_LANGUAGE

exec uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1
