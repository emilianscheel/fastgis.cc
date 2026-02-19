#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cargo test --manifest-path ../rust/Cargo.toml -p map-core

if [ "${RUN_E2E:-0}" = "1" ] && [ -f "./playwright.config.ts" ]; then
  bun x playwright test
else
  echo "Skipping Playwright tests (set RUN_E2E=1 to enable)."
fi
