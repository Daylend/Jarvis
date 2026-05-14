#!/bin/sh
set -e

# Idempotent — skips work if the model is already on disk and pinned.
/app/scripts/download-model.sh

# Pin model path + arch into the env so app.config can read them.
# shellcheck disable=SC1091
. /app/models/moonshine.env
export MOONSHINE_MODEL_PATH MOONSHINE_MODEL_ARCH MOONSHINE_LANGUAGE

# ── Thread-pool clamping ──────────────────────────────────────────────
# Each Moonshine Transcriber spawns an ONNX Runtime session with its own
# thread pool. With N concurrent streams the default (use-all-cores)
# behaviour causes massive oversubscription and cache thrashing.
# OMP_NUM_THREADS is the primary knob — it controls the OpenMP pool that
# ONNX Runtime's CPU EP uses for intra-op parallelism.
# Override OMP_NUM_THREADS via the environment; the others are hard-set.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-2}"
export MKL_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1
export NUMEXPR_NUM_THREADS=1

echo "[entrypoint] Thread limits: OMP=$OMP_NUM_THREADS MKL=$MKL_NUM_THREADS BLAS=$OPENBLAS_NUM_THREADS"

exec uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1
