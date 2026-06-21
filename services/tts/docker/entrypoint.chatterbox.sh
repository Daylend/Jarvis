#!/usr/bin/env sh
set -eu

mkdir -p "${MIOPEN_USER_DB_PATH}" "${MIOPEN_CUSTOM_CACHE_DIR}"

# MIOpen find policy:
#   - MIOPEN_TUNE=1 (deliberate warm-up pass): force a full solver SEARCH under
#     HYBRID so every convolution shape is benchmarked and written to the
#     persisted Find DB (/models/miopen/userdb). Send short/typical/long
#     utterances, then restart with MIOPEN_TUNE=0.
#   - MIOPEN_TUNE=0 (normal runtime): leave MIOPEN_FIND_MODE untouched so MIOpen
#     uses its default DYNAMIC_HYBRID, which consults the populated Find DB first
#     and falls back to immediate mode. This avoids the zero-workspace Find path
#     (pytorch #178839) that rejects workspace-requiring GEMM conv solvers —
#     forcing HYBRID here only added overhead without ever selecting them.
#   - For experimentation, MIOPEN_FIND_MODE (e.g. FAST) can be set via compose env;
#     this entrypoint only touches it during a tuning run, so an externally-set
#     value survives into normal runtime.
if [ "${MIOPEN_TUNE:-0}" = "1" ]; then
    export MIOPEN_FIND_MODE=HYBRID
    export MIOPEN_FIND_ENFORCE=SEARCH
    echo "MIOpen tuning enabled: new convolution shapes will be benchmarked."
else
    unset MIOPEN_FIND_ENFORCE || true
fi

exec "$@"
