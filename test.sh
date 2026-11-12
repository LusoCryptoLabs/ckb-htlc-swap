#!/bin/bash
# Builds the lock binaries, then runs the CKB-VM tests.
set -e
[ -d /root/.cargo/bin ] && export PATH=/root/.cargo/bin:$PATH
ROOT="$(cd "$(dirname "$0")" && pwd)"
BASE="${HTLC_TARGET_BASE:-$ROOT/target}"
bash "$ROOT/build.sh" >/dev/null
cd "$ROOT/tests" && CARGO_TARGET_DIR="$BASE/tests" cargo test --release -- --nocapture "$@"
