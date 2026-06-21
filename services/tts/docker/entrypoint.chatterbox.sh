#!/usr/bin/env sh
set -eu

mkdir -p "${MIOPEN_USER_DB_PATH}" "${MIOPEN_CUSTOM_CACHE_DIR}"

# During a controlled warm-up, force MIOpen to tune shapes even when the
# framework would otherwise use immediate-mode selection. The resulting
# entries are written under /models/miopen and remain available afterward.
# This mirrors the dots.tts tuning flow — chatterbox's conformer / s3gen convs
# benefit from the same persisted solver DB on gfx1201.
if [ "${MIOPEN_TUNE:-0}" = "1" ]; then
    export MIOPEN_FIND_ENFORCE=SEARCH
    echo "MIOpen tuning enabled: new convolution shapes will be benchmarked."
else
    unset MIOPEN_FIND_ENFORCE || true
fi

exec "$@"
