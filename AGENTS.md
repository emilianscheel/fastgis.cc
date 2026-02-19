# fastgis.cc - Agent Handoff

This document is the canonical handoff for future agents working on `fastgis.cc`.

## Project Intent

- Build a high-performance web GIS app with a Figma-like architecture:
  - React/Next.js for UI shell.
  - Rust/WASM for all map rendering and map interaction state.
- Current MVP scope:
  - OSM raster basemap.
  - Pan + zoom.
  - CSV trajectory upload (`TIME;LAT;LON`) and render overlay (polyline + start/end markers).

## Non-Negotiable Constraints

- Keep monorepo-lite layout with exactly two app roots:
  - `/Users/tn08021/Developer/fastgis.cc/next`
  - `/Users/tn08021/Developer/fastgis.cc/rust`
- No monorepo manager (`turbo`, `nx`, etc.).
- Do not render map geometry in React DOM/SVG/Canvas 2D.
- Map rendering must stay inside Rust/WASM (`wasm-bindgen`).
- Do not use `react-wasm` package.
- Keep UI responsive during WASM load:
  - Primary path: Worker + OffscreenCanvas.
  - Fallback path: main-thread WASM with fresh canvas remount.
- Use `shadcn/ui` components for UI primitives where UI components are needed.

## Current State (Implemented)

- Full-screen map canvas.
- Minimal top rectangular menu bar:
  - Left: `Select CSV file`.
  - Right: `+` and `-` zoom buttons.
- Attribution bottom-right.
- Continuous zoom implemented in WASM using fractional zoom (`f64`) and cursor-centered wheel math.
- Zoom sensitivity reduced for Mac touchpad usage.
- Tile request prioritization implemented:
  - High/Medium/Low queues + in-flight cap (`MAX_IN_FLIGHT_REQUESTS`).
- Prefetch ring around viewport + parent-tile fallback while child tile is loading.
- Opacity blending between adjacent zoom levels removed (to avoid text ghosting).
- Tile seam mitigation:
  - Slight tile overlap (`TILE_DRAW_OVERLAP_PX`).
  - Image smoothing disabled.
- Latitude void fill above/below world is now dynamic:
  - Real-time color extraction from top/bottom OSM edge tiles.
  - No hardcoded pole colors.

## Architecture Map

### Frontend (`/next`)

- `src/components/map-shell.tsx`
  - Owns canvas, user input forwarding, runtime mode (worker/main), frame loop.
  - Worker initialization with transferred `OffscreenCanvas`.
  - Main-thread fallback if worker init fails.
  - CSV file input and bytes forwarding.
- `src/workers/map.worker.ts`
  - Loads wasm module.
  - Owns engine in worker runtime.
  - Receives typed messages, calls wasm exports, posts status/errors/results.
- `src/lib/map-protocol.ts`
  - Message contract between React and worker.
- `scripts/build-wasm.sh`
  - Builds Rust crate into `next/src/wasm/pkg` via `wasm-pack`.

### Rust (`/rust`)

- `crates/map-core/src/lib.rs`
  - Mercator math, lon/lat normalization, CSV parse logic, trajectory bounds.
- `crates/map-engine-wasm/src/lib.rs`
  - `wasm-bindgen` exported map engine.
  - Tile fetch/decode.
  - Camera + interaction state.
  - Render loop and tile draw.
  - Request prioritization/prefetch.
  - CSV load and overlay rendering.
  - Dynamic void color sampling from edge tiles.

## Public Interfaces

### WASM exports (MapEngine)

- `init_engine(canvas_or_offscreen, config)`
- `resize(width, height, dpr)`
- `pointer_down(x, y, button)`
- `pointer_move(x, y)`
- `pointer_up(x, y)`
- `wheel(delta_y, x, y, ctrl_key)`
- `set_view(lon, lat, zoom)`
- `frame(now_ms)`
- `load_trajectory_csv(bytes)`
- `clear_trajectory()`
- `destroy()`

### Worker protocol

- Inbound:
  - `INIT`, `RESIZE`, `POINTER_DOWN`, `POINTER_MOVE`, `POINTER_UP`, `WHEEL`, `SET_VIEW`, `FRAME_TICK`, `LOAD_TRAJECTORY_CSV`, `CLEAR_TRAJECTORY`.
- Outbound:
  - `STATUS`, `READY`, `CSV_LOADED`, `ERROR`.

## CSV Contract

- Delimiter: `;`
- Columns: `TIME;LAT;LON` (header optional; header names case-insensitive when present).
- `TIME` stored as string.
- Invalid rows skipped and counted.
- Draw order preserves file order.
- Bounds auto-fit after successful load.

## Commands

From `/Users/tn08021/Developer/fastgis.cc/next`:

- Install deps: `bun install`
- Dev: `bun run dev`
- Build wasm only: `bun run build:wasm`
- Build web app: `bun run build`
- Test: `bun run test`
- TS typecheck: `bun x tsc --noEmit`

From `/Users/tn08021/Developer/fastgis.cc/rust` (or root with `--manifest-path`):

- `cargo test -p map-core`
- `cargo check -p map-engine-wasm --target wasm32-unknown-unknown`

## Known Gotchas / Troubleshooting

- After Rust changes, rebuild WASM before validating in browser:
  - `bun run build:wasm` (or just `bun run dev`, which calls build-wasm first).
- OffscreenCanvas transfer is one-way:
  - If worker init fails after transfer, remount a fresh `<canvas>` before fallback init.
  - This is handled in `map-shell.tsx` (`resetCanvasElement`).
- If CSV load says engine not initialized:
  - Check worker `READY` status and runtime mode before sending CSV bytes.
- If sandbox blocks `wasm-pack` tool install in restricted environments:
  - Run build command with elevated permissions.

## Testing Notes

- Rust unit tests are present and passing for `map-core`.
- E2E file currently looks stale versus current minimal UI:
  - `/Users/tn08021/Developer/fastgis.cc/next/tests/e2e/map.spec.ts`
  - It still references older controls (`Choose CSV`, `Clear Trajectory`, `Valid rows` UI) that are no longer in the simplified shell.
  - Update E2E selectors/assertions before relying on `RUN_E2E=1`.

## Performance Notes

- OSM raster tiles are inherently limited by source resolution.
- To improve perceived sharpness in future:
  - consider retina tile sources (`@2x`) if provider supports them,
  - or migrate to vector tiles (major renderer rewrite).
- Current renderer smoothness optimizations:
  - prioritized queues,
  - capped parallel requests,
  - prefetch rings,
  - parent fallback draw,
  - reduced wheel sensitivity,
  - single-level render (no crossfade blur artifacts).

## If You Start a New Task

1. Confirm whether change belongs in React shell (`/next`) or renderer (`/rust`).
2. Keep rendering logic in WASM unless it is strictly shell UI.
3. Rebuild wasm and run at least:
   - `cargo check ... map-engine-wasm`
   - `bun x tsc --noEmit`
4. If UI structure changed, update Playwright tests.
