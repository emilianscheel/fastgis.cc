#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_CRATE="$ROOT_DIR/../rust/crates/map-engine-wasm"
OUT_DIR="$ROOT_DIR/src/wasm/pkg"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack is required but not installed."
  echo "install with: cargo install wasm-pack"
  exit 1
fi

mkdir -p "$OUT_DIR"

wasm-pack build "$WASM_CRATE" \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name map_engine_wasm

