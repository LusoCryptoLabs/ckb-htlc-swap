#!/bin/bash
# Build htlc-lock in the pinned container and check its sha256 against the
# recorded canonical value. Needs docker. Run from anywhere:
#   bash reproducible/reproduce.sh
# The canonical binary is what a mainnet deployment uses; see README.
set -euo pipefail
EXPECTED=7a47a251f26dfb88926588f714a70c590eb4a3f4e0c8e6143a465ad56b48b1e6
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp -r "$ROOT/contracts" "$ROOT/rust-toolchain.toml" "$ROOT/reproducible/Dockerfile" "$CTX/"
rm -rf "$CTX"/contracts/*/target
( cd "$CTX" && docker build -q -t htlc-reproduce . >/dev/null )
GOT="$(docker run --rm htlc-reproduce sh -c 'sha256sum /htlc-lock' | cut -d' ' -f1)"
echo "expected $EXPECTED"
echo "built    $GOT"
if [ "$GOT" = "$EXPECTED" ]; then echo "MATCH"; else echo "MISMATCH"; exit 1; fi
