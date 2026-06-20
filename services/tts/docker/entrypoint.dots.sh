#!/usr/bin/env sh
set -eu

mkdir -p "${MIOPEN_USER_DB_PATH}" "${MIOPEN_CUSTOM_CACHE_DIR}"

# During a controlled warm-up, force MIOpen to tune shapes even when the
# framework would otherwise use immediate-mode selection. The resulting
# entries are written under /models/miopen and remain available afterward.
if [ "${MIOPEN_TUNE:-0}" = "1" ]; then
    export MIOPEN_FIND_ENFORCE=SEARCH
    echo "MIOpen tuning enabled: new convolution shapes will be benchmarked."
else
    unset MIOPEN_FIND_ENFORCE || true
fi

exec "$@"
