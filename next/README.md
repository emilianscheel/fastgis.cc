# next

Next.js (App Router) shell for the Rust/WASM map renderer.

## Commands

- `bun run build:wasm` builds `/Users/tn08021/Developer/qgis-rust/rust/crates/map-engine-wasm` into `src/wasm/pkg`.
- `bun run dev` builds WASM then starts Next dev server.
- `bun run build` builds WASM then creates production build.
- `bun run test` runs Rust unit tests and Playwright E2E tests.

## Architecture

- React handles UI shell only.
- Map rendering and interaction state are handled in Rust/WASM.
- Worker + OffscreenCanvas is primary runtime path.

