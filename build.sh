#!/bin/bash
# Builds both lock binaries for CKB-VM into build/. Needs the riscv64imac target
# (rust-toolchain.toml). HTLC_TARGET_BASE moves the cargo targets (default ./target).
set -e
[ -d /root/.cargo/bin ] && export PATH=/root/.cargo/bin:$PATH
ROOT="$(cd "$(dirname "$0")" && pwd)"
BASE="${HTLC_TARGET_BASE:-$ROOT/target}"
mkdir -p "$ROOT/build"
for c in htlc-lock spike-htlc-lock; do
  (cd "$ROOT/contracts/$c" && CARGO_TARGET_DIR="$BASE/$c" cargo build --release)
  cp "$BASE/$c/riscv64imac-unknown-none-elf/release/$c" "$ROOT/build/$c"
done
ls -l "$ROOT/build"
