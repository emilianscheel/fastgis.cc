# rust

Cargo workspace for geospatial math and the wasm-bindgen map renderer.

## Crates

- `crates/map-core`: mercator/tile math and CSV trajectory parsing.
- `crates/map-engine-wasm`: Rust map renderer exported to web with `wasm-bindgen`.

## Commands

- `cargo test -p map-core`
- `cargo check -p map-core`

