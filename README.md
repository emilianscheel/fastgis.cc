# [`fastgis.cc`](https://fastgis.cc)

Monorepo-lite structure (no Turborepo/Nx):

- `/Users/tn08021/Developer/qgis-rust/next`
- `/Users/tn08021/Developer/qgis-rust/rust`

## Quick start

1. Install dependencies for the web app:
   - `cd /Users/tn08021/Developer/qgis-rust/next`
   - `bun install`
2. Install Rust WASM tooling (required by scripts):
   - `cargo install wasm-pack`
3. Build WASM package:
   - `bun run build:wasm`
4. Start dev server:
   - `bun run dev`

## Notes

- Rendering happens in Rust/WASM through `wasm-bindgen`.
- React/Next is only the UI shell and event forwarding layer.
- Worker + OffscreenCanvas is the primary path to keep UI responsive.
