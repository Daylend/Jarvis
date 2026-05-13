#!/bin/sh
# Idempotently download the Moonshine model and pin its path + arch into
# /app/models/moonshine.env. Sourced by /app/entrypoint.sh.
set -e

MODEL_DIR="${MOONSHINE_MODEL_DIR:-/app/models}"
LANG="${MOONSHINE_LANGUAGE:-en}"
ENV_FILE="${MODEL_DIR}/moonshine.env"

mkdir -p "$MODEL_DIR"

# Fast path: already downloaded and pinned.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  if [ -n "$MOONSHINE_MODEL_PATH" ] && [ -f "$MOONSHINE_MODEL_PATH" ]; then
    echo "[download-model] Already pinned: arch=$MOONSHINE_MODEL_ARCH path=$MOONSHINE_MODEL_PATH"
    exit 0
  fi
fi

echo "[download-model] Fetching Moonshine model (lang=$LANG) into $MODEL_DIR ..."

# Point MOONSHINE_HOME at MODEL_DIR so the .ort artifacts live with our
# persistent volume rather than ~/.cache.
OUT="$(MOONSHINE_HOME="$MODEL_DIR" python -m moonshine_voice.download --language "$LANG" 2>&1)"
echo "$OUT"

# The downloader prints lines like:
#   Model arch: 7
#   Downloaded model path: /app/models/.../model.ort
ARCH="$(printf '%s\n' "$OUT" | awk -F': *' '/^Model arch:/ {print $2; exit}')"
MPATH="$(printf '%s\n' "$OUT" | awk -F': *' '/^Downloaded model path:/ {print $2; exit}')"

if [ -z "$ARCH" ] || [ -z "$MPATH" ]; then
  echo "[download-model] FAILED to parse downloader output (arch='$ARCH' path='$MPATH')" >&2
  exit 1
fi

cat > "$ENV_FILE" <<EOF
MOONSHINE_MODEL_PATH=$MPATH
MOONSHINE_MODEL_ARCH=$ARCH
MOONSHINE_LANGUAGE=$LANG
EOF
echo "[download-model] Pinned: arch=$ARCH path=$MPATH"
