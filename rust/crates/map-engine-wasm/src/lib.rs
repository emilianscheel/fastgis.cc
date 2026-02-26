use js_sys::{Array, Float32Array, Uint8Array};
use map_core::{
    clamp_lat, lon_lat_to_world, marker_bounds, normalize_lon, parse_marker_csv,
    parse_trajectory_csv, trajectory_bounds, world_to_lon_lat, Bounds, MarkerPoint,
    TrajectoryPoint,
};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Once;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;
use web_sys::{
    CanvasRenderingContext2d, HtmlCanvasElement, ImageBitmap, OffscreenCanvas,
    OffscreenCanvasRenderingContext2d, WebGl2RenderingContext, WebGlBuffer, WebGlProgram,
    WebGlShader, WebGlUniformLocation,
};

static PANIC_HOOK: Once = Once::new();
const WHEEL_ZOOM_SENSITIVITY: f64 = 1.0 / 1000.0;
const TILE_PREFETCH_MARGIN: i32 = 1;
const VECTOR_PREFETCH_OUTER_MARGIN: i32 = 2;
const TILE_DRAW_OVERLAP_PX: f64 = 1.0;
const MAX_IN_FLIGHT_REQUESTS: usize = 8;
const VOID_COLOR_BLEND_ALPHA: f64 = 0.25;
const BOX_ZOOM_FIT_PADDING: f64 = 0.9;
const TRAJECTORY_FIT_PADDING: f64 = 0.8;
const VIEW_ANIMATION_DURATION_MS: f64 = 300.0;
const LOCATION_MARKER_HEAD_RADIUS_PX: f64 = 8.0;
const LOCATION_MARKER_HEAD_CENTER_OFFSET_Y_PX: f64 = 12.0;
const LOCATION_MARKER_TAIL_HALF_WIDTH_PX: f64 = 5.0;
const LOCATION_MARKER_INNER_DOT_RADIUS_PX: f64 = 3.0;
const LOCATION_MARKER_TOOLTIP_OFFSET_Y_PX: f64 = 6.0;
const LOCATION_MARKER_FILL_COLOR: &str = "#f97316";
const LOCATION_MARKER_INNER_DOT_COLOR: &str = "#fff7ed";
const MAX_MARKERS_RENDERED_PER_FRAME: usize = 50_000;
const MAX_MARKERS_HIT_TEST_PER_EVENT: usize = 20_000;
const MARKER_RENDER_MARGIN_PX: f64 = 32.0;

#[wasm_bindgen(inline_js = r#"
export async function fetchTileBitmap(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Tile request failed with status ${response.status}`);
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

export function sampleTileEdgeColors(bitmap) {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  } else {
    throw new Error("No canvas API available for tile color sampling");
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Could not create 2D context for tile color sampling");
  }

  ctx.drawImage(bitmap, 0, 0);

  const sampleRow = (y) => {
    const row = ctx.getImageData(0, y, bitmap.width, 1).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < row.length; i += 4) {
      const a = row[i + 3];
      if (a === 0) continue;
      r += row[i];
      g += row[i + 1];
      b += row[i + 2];
      n += 1;
    }
    if (n === 0) return [0, 0, 0];
    return [r / n, g / n, b / n];
  };

  const top = sampleRow(0);
  const bottom = sampleRow(Math.max(0, bitmap.height - 1));
  return [top[0], top[1], top[2], bottom[0], bottom[1], bottom[2]];
}

export async function fetchTileBytes(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Tile request failed with status ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function webgpuSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = fetchTileBitmap)]
    async fn fetch_tile_bitmap(url: String) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = sampleTileEdgeColors)]
    fn sample_tile_edge_colors(bitmap: &ImageBitmap) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = fetchTileBytes)]
    async fn fetch_tile_bytes(url: String) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_name = webgpuSupported)]
    fn webgpu_supported() -> bool;
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorSourceConfig {
    tile_json_url: Option<String>,
    tile_url_template: Option<String>,
    attribution: Option<String>,
    source_max_zoom: Option<u8>,
    backend_preference: Option<String>,
    style_preset: Option<String>,
    layer_names: Option<Vec<String>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitConfig {
    engine_kind: Option<String>,
    tile_url_template: Option<String>,
    min_zoom: Option<u8>,
    max_zoom: Option<u8>,
    tile_size: Option<u32>,
    cache_size: Option<usize>,
    vector_source: Option<VectorSourceConfig>,
}

impl Default for InitConfig {
    fn default() -> Self {
        Self {
            engine_kind: Some("raster".to_string()),
            tile_url_template: Some("https://tile.openstreetmap.org/{z}/{x}/{y}.png".to_string()),
            min_zoom: Some(0),
            max_zoom: Some(19),
            tile_size: Some(256),
            cache_size: Some(1024),
            vector_source: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct TileKey {
    z: u8,
    x: u32,
    y: u32,
}

#[derive(Clone)]
struct CachedTile {
    bitmap: ImageBitmap,
    last_used: u64,
}

#[derive(Debug, Clone, Copy)]
enum RequestPriority {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy)]
struct TileEdgeSample {
    top_rgb: [f64; 3],
    bottom_rgb: [f64; 3],
}

#[derive(Debug, Clone, Copy)]
struct DragState {
    start_x: f64,
    start_y: f64,
    start_world0_x: f64,
    start_world0_y: f64,
}

#[derive(Debug, Clone, Copy)]
struct ViewAnimation {
    start_lon: f64,
    start_lat: f64,
    start_zoom: f64,
    target_lon: f64,
    target_lat: f64,
    target_zoom: f64,
    start_ms: f64,
    duration_ms: f64,
}

#[derive(Serialize)]
struct CsvLoadResult {
    valid_rows: usize,
    invalid_rows: usize,
    bounds: Option<Bounds>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkerHover {
    lon: f64,
    lat: f64,
    screen_x: f64,
    screen_y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacedMarker {
    lon: f64,
    lat: f64,
    tip_screen_x: f64,
    tip_screen_y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedPoint {
    screen_x: f64,
    screen_y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewState {
    lon: f64,
    lat: f64,
    zoom: f64,
}

enum CanvasSurface {
    Html(HtmlCanvasElement),
    Offscreen(OffscreenCanvas),
}

#[derive(Clone)]
enum RenderContext {
    Html(CanvasRenderingContext2d),
    Offscreen(OffscreenCanvasRenderingContext2d),
}

impl CanvasSurface {
    fn set_pixel_size(&self, width: u32, height: u32) {
        match self {
            CanvasSurface::Html(canvas) => {
                canvas.set_width(width);
                canvas.set_height(height);
            }
            CanvasSurface::Offscreen(canvas) => {
                canvas.set_width(width);
                canvas.set_height(height);
            }
        }
    }
}

impl RenderContext {
    fn set_fill_style_str(&self, value: &str) {
        match self {
            RenderContext::Html(ctx) => ctx.set_fill_style_str(value),
            RenderContext::Offscreen(ctx) => ctx.set_fill_style_str(value),
        }
    }

    fn set_stroke_style_str(&self, value: &str) {
        match self {
            RenderContext::Html(ctx) => ctx.set_stroke_style_str(value),
            RenderContext::Offscreen(ctx) => ctx.set_stroke_style_str(value),
        }
    }

    fn fill_rect(&self, x: f64, y: f64, w: f64, h: f64) {
        match self {
            RenderContext::Html(ctx) => ctx.fill_rect(x, y, w, h),
            RenderContext::Offscreen(ctx) => ctx.fill_rect(x, y, w, h),
        }
    }

    fn set_transform(&self, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Result<(), JsValue> {
        match self {
            RenderContext::Html(ctx) => ctx.set_transform(a, b, c, d, e, f),
            RenderContext::Offscreen(ctx) => ctx.set_transform(a, b, c, d, e, f),
        }
    }

    fn set_image_smoothing_enabled(&self, enabled: bool) {
        match self {
            RenderContext::Html(ctx) => ctx.set_image_smoothing_enabled(enabled),
            RenderContext::Offscreen(ctx) => ctx.set_image_smoothing_enabled(enabled),
        }
    }

    fn draw_image_with_image_bitmap_and_dw_and_dh(
        &self,
        image: &ImageBitmap,
        dx: f64,
        dy: f64,
        dw: f64,
        dh: f64,
    ) -> Result<(), JsValue> {
        match self {
            RenderContext::Html(ctx) => {
                ctx.draw_image_with_image_bitmap_and_dw_and_dh(image, dx, dy, dw, dh)
            }
            RenderContext::Offscreen(ctx) => {
                ctx.draw_image_with_image_bitmap_and_dw_and_dh(image, dx, dy, dw, dh)
            }
        }
    }

    fn draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
        &self,
        image: &ImageBitmap,
        sx: f64,
        sy: f64,
        sw: f64,
        sh: f64,
        dx: f64,
        dy: f64,
        dw: f64,
        dh: f64,
    ) -> Result<(), JsValue> {
        match self {
            RenderContext::Html(ctx) => ctx
                .draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    image, sx, sy, sw, sh, dx, dy, dw, dh,
                ),
            RenderContext::Offscreen(ctx) => ctx
                .draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    image, sx, sy, sw, sh, dx, dy, dw, dh,
                ),
        }
    }

    fn set_line_width(&self, width: f64) {
        match self {
            RenderContext::Html(ctx) => ctx.set_line_width(width),
            RenderContext::Offscreen(ctx) => ctx.set_line_width(width),
        }
    }

    fn begin_path(&self) {
        match self {
            RenderContext::Html(ctx) => ctx.begin_path(),
            RenderContext::Offscreen(ctx) => ctx.begin_path(),
        }
    }

    fn move_to(&self, x: f64, y: f64) {
        match self {
            RenderContext::Html(ctx) => ctx.move_to(x, y),
            RenderContext::Offscreen(ctx) => ctx.move_to(x, y),
        }
    }

    fn line_to(&self, x: f64, y: f64) {
        match self {
            RenderContext::Html(ctx) => ctx.line_to(x, y),
            RenderContext::Offscreen(ctx) => ctx.line_to(x, y),
        }
    }

    fn stroke(&self) {
        match self {
            RenderContext::Html(ctx) => ctx.stroke(),
            RenderContext::Offscreen(ctx) => ctx.stroke(),
        }
    }

    fn arc(&self, x: f64, y: f64, r: f64, start: f64, end: f64) -> Result<(), JsValue> {
        match self {
            RenderContext::Html(ctx) => ctx.arc(x, y, r, start, end),
            RenderContext::Offscreen(ctx) => ctx.arc(x, y, r, start, end),
        }
    }

    fn fill(&self) {
        match self {
            RenderContext::Html(ctx) => ctx.fill(),
            RenderContext::Offscreen(ctx) => ctx.fill(),
        }
    }
}

struct EngineState {
    surface: CanvasSurface,
    ctx: RenderContext,
    width: f64,
    height: f64,
    dpr: f64,
    tile_url_template: String,
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u32,
    zoom: f64,
    render_zoom: u8,
    center_lon: f64,
    center_lat: f64,
    view_animation: Option<ViewAnimation>,
    last_frame_now_ms: f64,
    dragging: Option<DragState>,
    cache_tick: u64,
    cache_limit: usize,
    tile_cache: HashMap<TileKey, CachedTile>,
    pending_tiles: HashSet<TileKey>,
    trajectories: Vec<Vec<TrajectoryPoint>>,
    location_markers: Vec<MarkerPoint>,
    high_priority_queue: VecDeque<TileKey>,
    medium_priority_queue: VecDeque<TileKey>,
    low_priority_queue: VecDeque<TileKey>,
    in_flight_requests: usize,
    max_in_flight_requests: usize,
    top_void_color_rgb: Option<[f64; 3]>,
    bottom_void_color_rgb: Option<[f64; 3]>,
}

impl EngineState {
    fn relevant_zoom_bounds(&self) -> (u8, u8) {
        let min_relevant = self.render_zoom.saturating_sub(1);
        let max_relevant = self.render_zoom.saturating_add(1).min(self.max_zoom);
        (min_relevant, max_relevant)
    }

    fn is_zoom_relevant_for_view(&self, z: u8) -> bool {
        let (min_relevant, max_relevant) = self.relevant_zoom_bounds();
        z >= min_relevant && z <= max_relevant
    }

    fn pop_latest_relevant_request(
        queue: &mut VecDeque<TileKey>,
        pending_tiles: &mut HashSet<TileKey>,
        min_relevant_zoom: u8,
        max_relevant_zoom: u8,
    ) -> Option<TileKey> {
        while let Some(key) = queue.pop_back() {
            if key.z >= min_relevant_zoom && key.z <= max_relevant_zoom {
                return Some(key);
            }
            pending_tiles.remove(&key);
        }

        None
    }

    fn zoom_clamp_f64(&self, zoom: f64) -> f64 {
        zoom.clamp(f64::from(self.min_zoom), f64::from(self.max_zoom))
    }

    fn zoom_scale(zoom: f64) -> f64 {
        2_f64.powf(zoom)
    }

    fn center_world0(&self) -> (f64, f64) {
        lon_lat_to_world(self.center_lon, self.center_lat, 0, self.tile_size)
    }

    fn cancel_view_animation(&mut self) {
        self.view_animation = None;
    }

    fn interpolate_lon_shortest(start_lon: f64, target_lon: f64, t: f64) -> f64 {
        let wrapped_delta = (target_lon - start_lon + 540.0).rem_euclid(360.0) - 180.0;
        normalize_lon(start_lon + wrapped_delta * t)
    }

    fn start_view_animation(&mut self, target_lon: f64, target_lat: f64, target_zoom: f64) {
        let target_lon = normalize_lon(target_lon);
        let target_lat = clamp_lat(target_lat);
        let target_zoom = self.zoom_clamp_f64(target_zoom);

        let lon_delta = (target_lon - self.center_lon + 540.0).rem_euclid(360.0) - 180.0;
        if lon_delta.abs() < 1e-9
            && (target_lat - self.center_lat).abs() < 1e-9
            && (target_zoom - self.zoom).abs() < 1e-9
        {
            self.cancel_view_animation();
            self.center_lon = target_lon;
            self.center_lat = target_lat;
            self.zoom = target_zoom;
            self.render_zoom = self.zoom.round() as u8;
            return;
        }

        self.view_animation = Some(ViewAnimation {
            start_lon: self.center_lon,
            start_lat: self.center_lat,
            start_zoom: self.zoom,
            target_lon,
            target_lat,
            target_zoom,
            start_ms: self.last_frame_now_ms,
            duration_ms: VIEW_ANIMATION_DURATION_MS,
        });
    }

    fn update_view_animation(&mut self, now_ms: f64) {
        let Some(animation) = self.view_animation else {
            return;
        };

        let duration_ms = animation.duration_ms.max(1.0);
        let progress = ((now_ms - animation.start_ms) / duration_ms).clamp(0.0, 1.0);
        let eased_progress = 1.0 - (1.0 - progress).powi(3);

        self.center_lon = Self::interpolate_lon_shortest(
            animation.start_lon,
            animation.target_lon,
            eased_progress,
        );
        self.center_lat = clamp_lat(
            animation.start_lat + (animation.target_lat - animation.start_lat) * eased_progress,
        );
        self.zoom = self.zoom_clamp_f64(
            animation.start_zoom + (animation.target_zoom - animation.start_zoom) * eased_progress,
        );
        self.render_zoom = self.zoom.round() as u8;

        if progress >= 1.0 {
            self.view_animation = None;
            self.center_lon = normalize_lon(animation.target_lon);
            self.center_lat = clamp_lat(animation.target_lat);
            self.zoom = self.zoom_clamp_f64(animation.target_zoom);
            self.render_zoom = self.zoom.round() as u8;
        }
    }

    fn trajectories_bounds(&self) -> Option<Bounds> {
        let mut bounds: Option<Bounds> = None;

        for route in &self.trajectories {
            if let Some(route_bounds) = trajectory_bounds(route) {
                match &mut bounds {
                    Some(current) => {
                        current.min_lat = current.min_lat.min(route_bounds.min_lat);
                        current.max_lat = current.max_lat.max(route_bounds.max_lat);
                        current.min_lon = current.min_lon.min(route_bounds.min_lon);
                        current.max_lon = current.max_lon.max(route_bounds.max_lon);
                    }
                    None => bounds = Some(route_bounds),
                }
            }
        }

        bounds
    }

    fn location_markers_bounds(&self) -> Option<Bounds> {
        marker_bounds(&self.location_markers)
    }

    fn sample_step(total: usize, budget: usize) -> usize {
        if budget == 0 {
            return 1;
        }
        if total <= budget {
            return 1;
        }
        total
            .saturating_add(budget - 1)
            .saturating_div(budget)
            .max(1)
    }

    fn color_css(rgb: [f64; 3]) -> String {
        format!(
            "rgb({},{},{})",
            rgb[0].round().clamp(0.0, 255.0) as i32,
            rgb[1].round().clamp(0.0, 255.0) as i32,
            rgb[2].round().clamp(0.0, 255.0) as i32
        )
    }

    fn blend_color(current: [f64; 3], sample: [f64; 3], alpha: f64) -> [f64; 3] {
        [
            current[0] + (sample[0] - current[0]) * alpha,
            current[1] + (sample[1] - current[1]) * alpha,
            current[2] + (sample[2] - current[2]) * alpha,
        ]
    }

    fn update_void_colors(&mut self, key: TileKey, sample: TileEdgeSample) {
        let max_y = (1u32 << key.z) - 1;

        if key.y == 0 {
            self.top_void_color_rgb = Some(match self.top_void_color_rgb {
                Some(current) => Self::blend_color(current, sample.top_rgb, VOID_COLOR_BLEND_ALPHA),
                None => sample.top_rgb,
            });
        }

        if key.y == max_y {
            self.bottom_void_color_rgb = Some(match self.bottom_void_color_rgb {
                Some(current) => {
                    Self::blend_color(current, sample.bottom_rgb, VOID_COLOR_BLEND_ALPHA)
                }
                None => sample.bottom_rgb,
            });
        }
    }

    fn sample_edge_colors(bitmap: &ImageBitmap) -> Option<TileEdgeSample> {
        let sample_value = sample_tile_edge_colors(bitmap).ok()?;
        let array = Array::from(&sample_value);
        if array.length() < 6 {
            return None;
        }

        let top_r = array.get(0).as_f64()?;
        let top_g = array.get(1).as_f64()?;
        let top_b = array.get(2).as_f64()?;
        let bottom_r = array.get(3).as_f64()?;
        let bottom_g = array.get(4).as_f64()?;
        let bottom_b = array.get(5).as_f64()?;

        Some(TileEdgeSample {
            top_rgb: [top_r, top_g, top_b],
            bottom_rgb: [bottom_r, bottom_g, bottom_b],
        })
    }

    fn draw_latitude_void_fill(&self) {
        let (_, center_world0_y) = self.center_world0();
        let display_scale = Self::zoom_scale(self.zoom);
        let world_height0 = self.tile_size as f64;

        let top_edge = (0.0 - center_world0_y) * display_scale + self.height / 2.0;
        let bottom_edge = (world_height0 - center_world0_y) * display_scale + self.height / 2.0;

        if top_edge > 0.0 {
            if let Some(rgb) = self.top_void_color_rgb {
                let color = Self::color_css(rgb);
                self.ctx.set_fill_style_str(&color);
                self.ctx
                    .fill_rect(0.0, 0.0, self.width, top_edge.ceil().min(self.height));
            }
        }

        if bottom_edge < self.height {
            if let Some(rgb) = self.bottom_void_color_rgb {
                let color = Self::color_css(rgb);
                self.ctx.set_fill_style_str(&color);
                self.ctx.fill_rect(
                    0.0,
                    bottom_edge.floor().max(0.0),
                    self.width,
                    (self.height - bottom_edge.floor()).max(0.0),
                );
            }
        }
    }

    fn update_render_zoom(&mut self) {
        while self.render_zoom < self.max_zoom && self.zoom >= f64::from(self.render_zoom) + 0.75 {
            self.render_zoom += 1;
        }

        while self.render_zoom > self.min_zoom && self.zoom <= f64::from(self.render_zoom) - 0.75 {
            self.render_zoom -= 1;
        }
    }

    fn visible_tile_range(&self, z: u8) -> (i32, i32, i32, i32, f64, f64, f64) {
        let tile_size = self.tile_size as f64;
        let level_factor = 2_f64.powi(i32::from(z));
        let display_scale = Self::zoom_scale(self.zoom);
        let level_scale = (display_scale / level_factor).max(1e-9);

        let (center_world0_x, center_world0_y) = self.center_world0();
        let center_world_x = center_world0_x * level_factor;
        let center_world_y = center_world0_y * level_factor;

        let half_w_world = self.width / (2.0 * level_scale);
        let half_h_world = self.height / (2.0 * level_scale);

        let min_x = ((center_world_x - half_w_world) / tile_size).floor() as i32;
        let max_x = ((center_world_x + half_w_world) / tile_size).floor() as i32;
        let min_y = ((center_world_y - half_h_world) / tile_size).floor() as i32;
        let max_y = ((center_world_y + half_h_world) / tile_size).floor() as i32;

        (
            min_x,
            max_x,
            min_y,
            max_y,
            center_world_x,
            center_world_y,
            level_scale,
        )
    }

    fn enqueue_tile_request(&mut self, key: TileKey, priority: RequestPriority) {
        if self.tile_cache.contains_key(&key) {
            return;
        }

        if self.pending_tiles.insert(key) {
            match priority {
                RequestPriority::High => self.high_priority_queue.push_back(key),
                RequestPriority::Medium => self.medium_priority_queue.push_back(key),
                RequestPriority::Low => self.low_priority_queue.push_back(key),
            }
        }
    }

    fn prefetch_tiles_level(&mut self, z: u8, margin: i32, priority: RequestPriority) {
        let (min_x, max_x, min_y, max_y, _, _, _) = self.visible_tile_range(z);
        let world_tiles = 1i32 << z;

        for raw_y in (min_y - margin)..=(max_y + margin) {
            if raw_y < 0 || raw_y >= world_tiles {
                continue;
            }

            for raw_x in (min_x - margin)..=(max_x + margin) {
                let wrapped_x = raw_x.rem_euclid(world_tiles) as u32;
                let key = TileKey {
                    z,
                    x: wrapped_x,
                    y: raw_y as u32,
                };
                self.enqueue_tile_request(key, priority);
            }
        }
    }

    fn draw_parent_fallback(
        &mut self,
        key: TileKey,
        draw_x: f64,
        draw_y: f64,
        draw_w: f64,
        draw_h: f64,
    ) -> bool {
        if key.z <= self.min_zoom {
            return false;
        }

        for ancestor_z in (self.min_zoom..key.z).rev() {
            let dz = u32::from(key.z - ancestor_z);
            let ancestor_key = TileKey {
                z: ancestor_z,
                x: key.x >> dz,
                y: key.y >> dz,
            };

            let tick = self.cache_tick.saturating_add(1);
            self.cache_tick = tick;

            if let Some(entry) = self.tile_cache.get_mut(&ancestor_key) {
                entry.last_used = tick;

                let split = 1u32 << dz;
                let local_x = key.x % split;
                let local_y = key.y % split;
                let src_w = self.tile_size as f64 / f64::from(split);
                let src_h = src_w;
                let src_x = f64::from(local_x) * src_w;
                let src_y = f64::from(local_y) * src_h;

                let _ = self
                    .ctx
                    .draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                        &entry.bitmap,
                        src_x,
                        src_y,
                        src_w,
                        src_h,
                        draw_x,
                        draw_y,
                        draw_w,
                        draw_h,
                    );
                return true;
            }
        }

        false
    }

    fn dequeue_next_request(&mut self) -> Option<TileKey> {
        let (min_relevant_zoom, max_relevant_zoom) = self.relevant_zoom_bounds();

        if let Some(key) = Self::pop_latest_relevant_request(
            &mut self.high_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        ) {
            return Some(key);
        }
        if let Some(key) = Self::pop_latest_relevant_request(
            &mut self.medium_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        ) {
            return Some(key);
        }
        Self::pop_latest_relevant_request(
            &mut self.low_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        )
    }

    fn draw_tiles_level(&mut self, z: u8) {
        let tile_size = self.tile_size as f64;
        let world_tiles = 1i32 << z;
        let (min_x, max_x, min_y, max_y, center_world_x, center_world_y, level_scale) =
            self.visible_tile_range(z);

        for raw_y in min_y..=max_y {
            if raw_y < 0 || raw_y >= world_tiles {
                continue;
            }

            for raw_x in min_x..=max_x {
                let wrapped_x = raw_x.rem_euclid(world_tiles) as u32;
                let key = TileKey {
                    z,
                    x: wrapped_x,
                    y: raw_y as u32,
                };

                let screen_x =
                    (raw_x as f64 * tile_size - center_world_x) * level_scale + self.width / 2.0;
                let screen_y =
                    (raw_y as f64 * tile_size - center_world_y) * level_scale + self.height / 2.0;

                let draw_x = screen_x.floor();
                let draw_y = screen_y.floor();
                let draw_size = tile_size * level_scale + TILE_DRAW_OVERLAP_PX;

                if let Some(entry) = self.tile_cache.get_mut(&key) {
                    self.cache_tick = self.cache_tick.saturating_add(1);
                    entry.last_used = self.cache_tick;
                    let _ = self.ctx.draw_image_with_image_bitmap_and_dw_and_dh(
                        &entry.bitmap,
                        draw_x,
                        draw_y,
                        draw_size,
                        draw_size,
                    );
                } else {
                    let drew_fallback =
                        self.draw_parent_fallback(key, draw_x, draw_y, draw_size, draw_size);
                    if !drew_fallback {
                        self.ctx.set_fill_style_str("#16202b");
                        self.ctx.fill_rect(draw_x, draw_y, draw_size, draw_size);
                    }
                    self.enqueue_tile_request(key, RequestPriority::High);
                }
            }
        }

        for raw_y in (min_y - TILE_PREFETCH_MARGIN)..=(max_y + TILE_PREFETCH_MARGIN) {
            if raw_y < 0 || raw_y >= world_tiles {
                continue;
            }

            for raw_x in (min_x - TILE_PREFETCH_MARGIN)..=(max_x + TILE_PREFETCH_MARGIN) {
                let is_visible =
                    raw_x >= min_x && raw_x <= max_x && raw_y >= min_y && raw_y <= max_y;
                if is_visible {
                    continue;
                }

                let wrapped_x = raw_x.rem_euclid(world_tiles) as u32;
                let key = TileKey {
                    z,
                    x: wrapped_x,
                    y: raw_y as u32,
                };
                self.enqueue_tile_request(key, RequestPriority::Medium);
            }
        }
    }

    fn resize(&mut self, width: u32, height: u32, dpr: f32) {
        self.width = width as f64;
        self.height = height as f64;
        self.dpr = (dpr as f64).max(1.0);

        let pixel_width = ((self.width * self.dpr).round() as u32).max(1);
        let pixel_height = ((self.height * self.dpr).round() as u32).max(1);
        self.surface.set_pixel_size(pixel_width, pixel_height);
        let _ = self
            .ctx
            .set_transform(self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0);
        self.ctx.set_image_smoothing_enabled(false);
    }

    fn set_view(&mut self, lon: f64, lat: f64, zoom: f32) {
        self.cancel_view_animation();
        self.center_lon = normalize_lon(lon);
        self.center_lat = clamp_lat(lat);
        self.zoom = self.zoom_clamp_f64(f64::from(zoom));
        self.render_zoom = self.zoom.round() as u8;
    }

    fn zoom_to_box(&mut self, start_x: f64, start_y: f64, end_x: f64, end_y: f64) {
        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        let left = start_x.min(end_x).clamp(0.0, self.width);
        let right = start_x.max(end_x).clamp(0.0, self.width);
        let top = start_y.min(end_y).clamp(0.0, self.height);
        let bottom = start_y.max(end_y).clamp(0.0, self.height);

        let selection_width = right - left;
        let selection_height = bottom - top;
        if selection_width < 1.0 || selection_height < 1.0 {
            return;
        }

        let current_display_scale = Self::zoom_scale(self.zoom).max(1e-9);
        let (center_world0_x, center_world0_y) = self.center_world0();
        let left_world0 = center_world0_x + (left - self.width * 0.5) / current_display_scale;
        let right_world0 = center_world0_x + (right - self.width * 0.5) / current_display_scale;
        let top_world0 = center_world0_y + (top - self.height * 0.5) / current_display_scale;
        let bottom_world0 = center_world0_y + (bottom - self.height * 0.5) / current_display_scale;

        self.start_fit_to_world_bounds_animation(
            left_world0,
            top_world0,
            right_world0,
            bottom_world0,
            BOX_ZOOM_FIT_PADDING,
        );
    }

    fn place_marker_at_screen(&mut self, x: f64, y: f64) -> Option<PlacedMarker> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }

        let clamped_x = x.clamp(0.0, self.width);
        let clamped_y = y.clamp(0.0, self.height);
        let display_scale = Self::zoom_scale(self.zoom).max(1e-9);
        let (center_world0_x, center_world0_y) = self.center_world0();

        let marker_world0_x = center_world0_x + (clamped_x - self.width * 0.5) / display_scale;
        let marker_world0_y = center_world0_y + (clamped_y - self.height * 0.5) / display_scale;
        let (marker_lon, marker_lat) =
            world_to_lon_lat(marker_world0_x, marker_world0_y, 0, self.tile_size);

        let placed_marker = self.push_marker_lon_lat(marker_lon, marker_lat);

        Some(PlacedMarker {
            lon: placed_marker.lon,
            lat: placed_marker.lat,
            tip_screen_x: clamped_x,
            tip_screen_y: clamped_y,
        })
    }

    fn remove_recent_markers(&mut self, count: usize) {
        if count == 0 {
            return;
        }

        let keep_len = self.location_markers.len().saturating_sub(count);
        self.location_markers.truncate(keep_len);
    }

    fn push_marker_lon_lat(&mut self, lon: f64, lat: f64) -> MarkerPoint {
        let marker = MarkerPoint {
            lon: normalize_lon(lon),
            lat: clamp_lat(lat),
        };
        self.location_markers.push(marker);
        marker
    }

    fn append_marker_points(&mut self, mut markers: Vec<MarkerPoint>) {
        for marker in &mut markers {
            marker.lon = normalize_lon(marker.lon);
            marker.lat = clamp_lat(marker.lat);
        }
        self.location_markers.extend(markers);
    }

    fn remove_marker_lon_lat(&mut self, lon: f64, lat: f64) {
        let normalized_lon = normalize_lon(lon);
        let clamped_lat = clamp_lat(lat);
        const COORD_MATCH_EPSILON: f64 = 1e-6;

        if let Some(index) = self.location_markers.iter().rposition(|marker| {
            (marker.lon - normalized_lon).abs() <= COORD_MATCH_EPSILON
                && (marker.lat - clamped_lat).abs() <= COORD_MATCH_EPSILON
        }) {
            self.location_markers.remove(index);
        }
    }

    fn draw(&mut self, now_ms: f64) {
        self.last_frame_now_ms = now_ms;
        self.update_view_animation(now_ms);

        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        self.ctx.set_fill_style_str("#0b1118");
        self.ctx.fill_rect(0.0, 0.0, self.width, self.height);
        self.draw_latitude_void_fill();

        self.update_render_zoom();
        self.draw_tiles_level(self.render_zoom);

        if self.render_zoom < self.max_zoom {
            self.prefetch_tiles_level(
                self.render_zoom + 1,
                TILE_PREFETCH_MARGIN + 1,
                RequestPriority::Low,
            );
        }
        if self.render_zoom > self.min_zoom {
            self.prefetch_tiles_level(
                self.render_zoom - 1,
                TILE_PREFETCH_MARGIN,
                RequestPriority::Low,
            );
        }

        self.draw_trajectory();
        self.draw_location_markers();
    }

    fn draw_trajectory(&self) {
        if self.trajectories.is_empty() {
            return;
        }

        let display_scale = Self::zoom_scale(self.zoom);
        let (center_world0_x, center_world0_y) = self.center_world0();

        for route in &self.trajectories {
            if route.is_empty() {
                continue;
            }

            self.ctx.set_stroke_style_str("#ff7a18");
            self.ctx.set_line_width(2.0);
            self.ctx.begin_path();

            for (idx, point) in route.iter().enumerate() {
                let (world0_x, world0_y) =
                    lon_lat_to_world(point.lon, point.lat, 0, self.tile_size);
                let sx = (world0_x - center_world0_x) * display_scale + self.width / 2.0;
                let sy = (world0_y - center_world0_y) * display_scale + self.height / 2.0;

                if idx == 0 {
                    self.ctx.move_to(sx, sy);
                } else {
                    self.ctx.line_to(sx, sy);
                }
            }
            self.ctx.stroke();

            if let Some(first) = route.first() {
                self.draw_marker(
                    first,
                    "#2ecc71",
                    center_world0_x,
                    center_world0_y,
                    display_scale,
                );
            }
            if let Some(last) = route.last() {
                self.draw_marker(
                    last,
                    "#e74c3c",
                    center_world0_x,
                    center_world0_y,
                    display_scale,
                );
            }
        }
    }

    fn draw_marker(
        &self,
        point: &TrajectoryPoint,
        color: &str,
        center_world0_x: f64,
        center_world0_y: f64,
        display_scale: f64,
    ) {
        let (world0_x, world0_y) = lon_lat_to_world(point.lon, point.lat, 0, self.tile_size);
        let sx = (world0_x - center_world0_x) * display_scale + self.width / 2.0;
        let sy = (world0_y - center_world0_y) * display_scale + self.height / 2.0;

        self.ctx.set_fill_style_str(color);
        self.ctx.begin_path();
        let _ = self.ctx.arc(sx, sy, 5.0, 0.0, std::f64::consts::PI * 2.0);
        self.ctx.fill();
    }

    fn marker_tip_screen_position(&self, marker: MarkerPoint) -> (f64, f64) {
        let display_scale = Self::zoom_scale(self.zoom);
        let (center_world0_x, center_world0_y) = self.center_world0();
        let (marker_world0_x, marker_world0_y) =
            lon_lat_to_world(marker.lon, marker.lat, 0, self.tile_size);
        let tip_x = (marker_world0_x - center_world0_x) * display_scale + self.width / 2.0;
        let tip_y = (marker_world0_y - center_world0_y) * display_scale + self.height / 2.0;
        (tip_x, tip_y)
    }

    fn project_lon_lat_to_screen(&self, lon: f64, lat: f64) -> Option<ProjectedPoint> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }

        let normalized_lon = normalize_lon(lon);
        let clamped_lat = clamp_lat(lat);
        let display_scale = Self::zoom_scale(self.zoom);
        let (center_world0_x, center_world0_y) = self.center_world0();
        let (world0_x, world0_y) = lon_lat_to_world(normalized_lon, clamped_lat, 0, self.tile_size);
        let screen_x = (world0_x - center_world0_x) * display_scale + self.width / 2.0;
        let screen_y = (world0_y - center_world0_y) * display_scale + self.height / 2.0;

        Some(ProjectedPoint { screen_x, screen_y })
    }

    fn marker_head_center_from_tip(tip_x: f64, tip_y: f64) -> (f64, f64) {
        (tip_x, tip_y - LOCATION_MARKER_HEAD_CENTER_OFFSET_Y_PX)
    }

    fn marker_tail_top_y(head_center_y: f64) -> f64 {
        head_center_y + LOCATION_MARKER_HEAD_RADIUS_PX - 1.0
    }

    fn triangle_sign(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        (px - bx) * (ay - by) - (ax - bx) * (py - by)
    }

    fn point_in_triangle(
        px: f64,
        py: f64,
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        cx: f64,
        cy: f64,
    ) -> bool {
        let d1 = Self::triangle_sign(px, py, ax, ay, bx, by);
        let d2 = Self::triangle_sign(px, py, bx, by, cx, cy);
        let d3 = Self::triangle_sign(px, py, cx, cy, ax, ay);
        let has_negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
        let has_positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
        !(has_negative && has_positive)
    }

    fn marker_contains_pointer(tip_x: f64, tip_y: f64, pointer_x: f64, pointer_y: f64) -> bool {
        let (head_center_x, head_center_y) = Self::marker_head_center_from_tip(tip_x, tip_y);
        let dx = pointer_x - head_center_x;
        let dy = pointer_y - head_center_y;
        let in_head =
            dx * dx + dy * dy <= LOCATION_MARKER_HEAD_RADIUS_PX * LOCATION_MARKER_HEAD_RADIUS_PX;
        if in_head {
            return true;
        }

        let tail_top_y = Self::marker_tail_top_y(head_center_y);
        Self::point_in_triangle(
            pointer_x,
            pointer_y,
            tip_x,
            tip_y,
            tip_x - LOCATION_MARKER_TAIL_HALF_WIDTH_PX,
            tail_top_y,
            tip_x + LOCATION_MARKER_TAIL_HALF_WIDTH_PX,
            tail_top_y,
        )
    }

    fn hit_test_marker_at_screen(&self, x: f64, y: f64) -> Option<MarkerHover> {
        if x < 0.0 || y < 0.0 || x > self.width || y > self.height {
            return None;
        }

        let step = Self::sample_step(self.location_markers.len(), MAX_MARKERS_HIT_TEST_PER_EVENT);

        for marker in self.location_markers.iter().rev().step_by(step) {
            let (tip_x, tip_y) = self.marker_tip_screen_position(*marker);
            if !Self::marker_contains_pointer(tip_x, tip_y, x, y) {
                continue;
            }

            let (head_center_x, head_center_y) = Self::marker_head_center_from_tip(tip_x, tip_y);
            return Some(MarkerHover {
                lon: marker.lon,
                lat: marker.lat,
                screen_x: head_center_x,
                screen_y: head_center_y
                    - LOCATION_MARKER_HEAD_RADIUS_PX
                    - LOCATION_MARKER_TOOLTIP_OFFSET_Y_PX,
            });
        }

        None
    }

    fn draw_location_markers(&self) {
        if self.location_markers.is_empty() {
            return;
        }

        let step = Self::sample_step(self.location_markers.len(), MAX_MARKERS_RENDERED_PER_FRAME);

        for marker in self.location_markers.iter().step_by(step) {
            let (tip_x, tip_y) = self.marker_tip_screen_position(*marker);
            if tip_x < -MARKER_RENDER_MARGIN_PX
                || tip_x > self.width + MARKER_RENDER_MARGIN_PX
                || tip_y < -MARKER_RENDER_MARGIN_PX
                || tip_y > self.height + MARKER_RENDER_MARGIN_PX
            {
                continue;
            }
            self.draw_location_marker_at_tip(tip_x, tip_y);
        }
    }

    fn draw_location_marker_at_tip(&self, tip_x: f64, tip_y: f64) {
        let (head_center_x, head_center_y) = Self::marker_head_center_from_tip(tip_x, tip_y);
        let tail_top_y = Self::marker_tail_top_y(head_center_y);

        self.ctx.set_fill_style_str(LOCATION_MARKER_FILL_COLOR);
        self.ctx.begin_path();
        let _ = self.ctx.arc(
            head_center_x,
            head_center_y,
            LOCATION_MARKER_HEAD_RADIUS_PX,
            0.0,
            std::f64::consts::PI * 2.0,
        );
        self.ctx.fill();

        self.ctx.begin_path();
        self.ctx.move_to(tip_x, tip_y);
        self.ctx
            .line_to(tip_x - LOCATION_MARKER_TAIL_HALF_WIDTH_PX, tail_top_y);
        self.ctx
            .line_to(tip_x + LOCATION_MARKER_TAIL_HALF_WIDTH_PX, tail_top_y);
        self.ctx.fill();

        self.ctx.set_fill_style_str(LOCATION_MARKER_INNER_DOT_COLOR);
        self.ctx.begin_path();
        let _ = self.ctx.arc(
            head_center_x,
            head_center_y,
            LOCATION_MARKER_INNER_DOT_RADIUS_PX,
            0.0,
            std::f64::consts::PI * 2.0,
        );
        self.ctx.fill();
    }

    fn start_fit_to_world_bounds_animation(
        &mut self,
        world0_x_a: f64,
        world0_y_a: f64,
        world0_x_b: f64,
        world0_y_b: f64,
        fit_padding: f64,
    ) {
        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        let min_world0_x = world0_x_a.min(world0_x_b);
        let max_world0_x = world0_x_a.max(world0_x_b);
        let min_world0_y = world0_y_a.min(world0_y_b);
        let max_world0_y = world0_y_a.max(world0_y_b);
        let world_width = (max_world0_x - min_world0_x).max(1e-12);
        let world_height = (max_world0_y - min_world0_y).max(1e-12);
        let safe_fit_padding = fit_padding.clamp(0.05, 1.0);

        let target_display_scale = ((self.width / world_width).min(self.height / world_height)
            * safe_fit_padding)
            .max(1e-9);
        let target_zoom = self.zoom_clamp_f64(target_display_scale.log2());

        let focus_world0_x = (min_world0_x + max_world0_x) * 0.5;
        let focus_world0_y = (min_world0_y + max_world0_y) * 0.5;
        let (target_lon, target_lat) =
            world_to_lon_lat(focus_world0_x, focus_world0_y, 0, self.tile_size);

        self.start_view_animation(target_lon, target_lat, target_zoom);
    }

    fn fit_to_bounds(&mut self, bounds: Bounds) {
        let (world0_x_a, world0_y_a) =
            lon_lat_to_world(bounds.min_lon, bounds.max_lat, 0, self.tile_size);
        let (world0_x_b, world0_y_b) =
            lon_lat_to_world(bounds.max_lon, bounds.min_lat, 0, self.tile_size);
        self.start_fit_to_world_bounds_animation(
            world0_x_a,
            world0_y_a,
            world0_x_b,
            world0_y_b,
            TRAJECTORY_FIT_PADDING,
        );
    }

    fn tile_url(&self, key: TileKey) -> String {
        self.tile_url_template
            .replace("{z}", &key.z.to_string())
            .replace("{x}", &key.x.to_string())
            .replace("{y}", &key.y.to_string())
    }

    fn set_tile_url_template(&mut self, template: String) {
        if self.tile_url_template == template {
            return;
        }

        self.cancel_view_animation();
        self.tile_url_template = template;
        self.pending_tiles.clear();
        self.high_priority_queue.clear();
        self.medium_priority_queue.clear();
        self.low_priority_queue.clear();
        self.in_flight_requests = 0;
        self.tile_cache.clear();
        self.top_void_color_rgb = None;
        self.bottom_void_color_rgb = None;
    }

    fn insert_tile(
        &mut self,
        key: TileKey,
        bitmap: ImageBitmap,
        edge_sample: Option<TileEdgeSample>,
    ) {
        self.cache_tick = self.cache_tick.saturating_add(1);
        self.tile_cache.insert(
            key,
            CachedTile {
                bitmap,
                last_used: self.cache_tick,
            },
        );

        if let Some(sample) = edge_sample {
            self.update_void_colors(key, sample);
        }

        if self.tile_cache.len() > self.cache_limit {
            if let Some((evict_key, _)) = self
                .tile_cache
                .iter()
                .min_by_key(|(_, value)| value.last_used)
                .map(|(key, value)| (*key, value.last_used))
            {
                self.tile_cache.remove(&evict_key);
            }
        }
    }
}

#[wasm_bindgen]
pub struct MapEngine {
    state: Rc<RefCell<EngineState>>,
}

#[wasm_bindgen]
pub fn init_engine(canvas_or_offscreen: JsValue, config: JsValue) -> Result<MapEngine, JsValue> {
    PANIC_HOOK.call_once(console_error_panic_hook::set_once);

    let config: InitConfig = if config.is_undefined() || config.is_null() {
        InitConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)?
    };

    let tile_url_template = config
        .tile_url_template
        .unwrap_or_else(|| "https://tile.openstreetmap.org/{z}/{x}/{y}.png".to_string());
    let min_zoom = config.min_zoom.unwrap_or(0);
    let max_zoom = config.max_zoom.unwrap_or(19).max(min_zoom);
    let tile_size = config.tile_size.unwrap_or(256).max(64);
    let cache_limit = config.cache_size.unwrap_or(1024).max(64);
    let initial_zoom = 2.0_f64.clamp(f64::from(min_zoom), f64::from(max_zoom));
    let initial_render_zoom = initial_zoom.round() as u8;

    let (surface, ctx) = make_canvas_surface(canvas_or_offscreen)?;

    let state = EngineState {
        surface,
        ctx,
        width: 1024.0,
        height: 768.0,
        dpr: 1.0,
        tile_url_template,
        min_zoom,
        max_zoom,
        tile_size,
        zoom: initial_zoom,
        render_zoom: initial_render_zoom,
        center_lon: 0.0,
        center_lat: 20.0,
        view_animation: None,
        last_frame_now_ms: 0.0,
        dragging: None,
        cache_tick: 0,
        cache_limit,
        tile_cache: HashMap::new(),
        pending_tiles: HashSet::new(),
        trajectories: Vec::new(),
        location_markers: Vec::new(),
        high_priority_queue: VecDeque::new(),
        medium_priority_queue: VecDeque::new(),
        low_priority_queue: VecDeque::new(),
        in_flight_requests: 0,
        max_in_flight_requests: MAX_IN_FLIGHT_REQUESTS,
        top_void_color_rgb: None,
        bottom_void_color_rgb: None,
    };

    Ok(MapEngine {
        state: Rc::new(RefCell::new(state)),
    })
}

fn make_canvas_surface(
    canvas_or_offscreen: JsValue,
) -> Result<(CanvasSurface, RenderContext), JsValue> {
    if let Ok(canvas) = canvas_or_offscreen.clone().dyn_into::<HtmlCanvasElement>() {
        let ctx = canvas
            .get_context("2d")?
            .ok_or_else(|| JsValue::from_str("2D canvas context is not available"))?
            .dyn_into::<CanvasRenderingContext2d>()?;
        return Ok((CanvasSurface::Html(canvas), RenderContext::Html(ctx)));
    }

    if let Ok(canvas) = canvas_or_offscreen.dyn_into::<OffscreenCanvas>() {
        let ctx = canvas
            .get_context("2d")?
            .ok_or_else(|| JsValue::from_str("2D offscreen context is not available"))?
            .dyn_into::<OffscreenCanvasRenderingContext2d>()?;
        return Ok((
            CanvasSurface::Offscreen(canvas),
            RenderContext::Offscreen(ctx),
        ));
    }

    Err(JsValue::from_str(
        "init_engine expected HTMLCanvasElement or OffscreenCanvas",
    ))
}

fn request_tile(state: Rc<RefCell<EngineState>>, key: TileKey, url: String) {
    spawn_local(async move {
        let request_url = url.clone();
        let result = fetch_tile_bitmap(url)
            .await
            .and_then(|value| value.dyn_into::<ImageBitmap>().map_err(Into::into));

        let edge_sample = result.as_ref().ok().and_then(|bitmap| {
            let max_y = (1u32 << key.z) - 1;
            if key.y == 0 || key.y == max_y {
                EngineState::sample_edge_colors(bitmap)
            } else {
                None
            }
        });

        {
            let mut state_mut = state.borrow_mut();
            state_mut.pending_tiles.remove(&key);
            state_mut.in_flight_requests = state_mut.in_flight_requests.saturating_sub(1);

            let is_current_source = state_mut.tile_url(key) == request_url;
            let is_relevant_zoom = state_mut.is_zoom_relevant_for_view(key.z);
            if is_current_source && is_relevant_zoom {
                if let Ok(bitmap) = result {
                    state_mut.insert_tile(key, bitmap, edge_sample);
                }
            } else if result.is_ok() {
                // Drop stale tile responses after style switches or fast zoom jumps.
            }
        }

        pump_requests(state.clone());
    });
}

fn pump_requests(state: Rc<RefCell<EngineState>>) {
    loop {
        let next = {
            let mut state_mut = state.borrow_mut();

            if state_mut.in_flight_requests >= state_mut.max_in_flight_requests {
                None
            } else if let Some(key) = state_mut.dequeue_next_request() {
                state_mut.in_flight_requests += 1;
                let url = state_mut.tile_url(key);
                Some((key, url))
            } else {
                None
            }
        };

        let Some((key, url)) = next else {
            break;
        };

        request_tile(state.clone(), key, url);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VectorBackendKind {
    WebGl2,
    WebGpuFallbackWebGl2,
    Canvas2d,
}

impl VectorBackendKind {
    fn as_str(self) -> &'static str {
        match self {
            VectorBackendKind::WebGl2 => "webgl2",
            VectorBackendKind::WebGpuFallbackWebGl2 => "webgpu-fallback-webgl2",
            VectorBackendKind::Canvas2d => "canvas2d",
        }
    }
}

#[derive(Clone, Default)]
struct VectorTileScene {
    water_polygons: Vec<Vec<[f32; 2]>>,
    transportation_lines: Vec<Vec<[f32; 2]>>,
}

#[derive(Clone, Default)]
struct PreparedVectorTileGeometry {
    // Tile-local normalized coordinates (0..1), flattened as x,y pairs.
    water_triangles: Vec<f32>,
    transportation_segments: Vec<f32>,
}

#[derive(Clone)]
struct SimpleGlPainter {
    program: WebGlProgram,
    position_attrib: u32,
    color_uniform: WebGlUniformLocation,
    tile_origin_uniform: WebGlUniformLocation,
    tile_size_uniform: WebGlUniformLocation,
    viewport_uniform: WebGlUniformLocation,
    dpr_uniform: WebGlUniformLocation,
}

#[derive(Clone)]
struct TileGlBuffers {
    water_buffer: Option<WebGlBuffer>,
    water_vertex_count: i32,
    transportation_buffer: Option<WebGlBuffer>,
    transportation_vertex_count: i32,
}

fn build_prepared_vector_tile_geometry(scene: &VectorTileScene) -> PreparedVectorTileGeometry {
    let mut prepared = PreparedVectorTileGeometry::default();

    for ring in &scene.water_polygons {
        if ring.len() < 3 {
            continue;
        }

        // Naive triangle fan triangulation. Cached once per tile to avoid repeating this
        // work every frame during pan/zoom.
        let first = ring[0];
        for index in 1..(ring.len().saturating_sub(1)) {
            let b = ring[index];
            let c = ring[index + 1];
            prepared
                .water_triangles
                .extend_from_slice(&[first[0], first[1], b[0], b[1], c[0], c[1]]);
        }
    }

    for path in &scene.transportation_lines {
        if path.len() < 2 {
            continue;
        }

        for segment in path.windows(2) {
            let start = segment[0];
            let end = segment[1];
            prepared.transportation_segments.extend_from_slice(&[
                start[0],
                start[1],
                end[0],
                end[1],
            ]);
        }
    }

    prepared
}

impl SimpleGlPainter {
    fn draw_tile_buffer(
        &self,
        gl: &WebGl2RenderingContext,
        mode: u32,
        buffer: &WebGlBuffer,
        vertex_count: i32,
        color: [f32; 4],
        tile_screen_x: f64,
        tile_screen_y: f64,
        tile_display_size: f64,
        viewport_pixel_width: f64,
        viewport_pixel_height: f64,
        dpr: f64,
    ) {
        if vertex_count <= 0 {
            return;
        }

        gl.use_program(Some(&self.program));
        gl.bind_buffer(WebGl2RenderingContext::ARRAY_BUFFER, Some(buffer));
        gl.enable_vertex_attrib_array(self.position_attrib);
        gl.vertex_attrib_pointer_with_i32(
            self.position_attrib,
            2,
            WebGl2RenderingContext::FLOAT,
            false,
            0,
            0,
        );
        gl.uniform4f(
            Some(&self.color_uniform),
            color[0],
            color[1],
            color[2],
            color[3],
        );
        gl.uniform2f(
            Some(&self.tile_origin_uniform),
            tile_screen_x as f32,
            tile_screen_y as f32,
        );
        gl.uniform1f(Some(&self.tile_size_uniform), tile_display_size as f32);
        gl.uniform2f(
            Some(&self.viewport_uniform),
            viewport_pixel_width as f32,
            viewport_pixel_height as f32,
        );
        gl.uniform1f(Some(&self.dpr_uniform), dpr as f32);
        gl.draw_arrays(mode, 0, vertex_count);
    }
}

fn upload_static_gl_buffer(gl: &WebGl2RenderingContext, data: &[f32]) -> Option<WebGlBuffer> {
    if data.is_empty() {
        return None;
    }

    let buffer = gl.create_buffer()?;
    gl.bind_buffer(WebGl2RenderingContext::ARRAY_BUFFER, Some(&buffer));
    let js_array = Float32Array::from(data);
    gl.buffer_data_with_array_buffer_view(
        WebGl2RenderingContext::ARRAY_BUFFER,
        &js_array,
        WebGl2RenderingContext::STATIC_DRAW,
    );
    Some(buffer)
}

fn build_tile_gl_buffers(gl: &WebGl2RenderingContext, prepared: &PreparedVectorTileGeometry) -> TileGlBuffers {
    TileGlBuffers {
        water_vertex_count: (prepared.water_triangles.len() / 2) as i32,
        water_buffer: upload_static_gl_buffer(gl, &prepared.water_triangles),
        transportation_vertex_count: (prepared.transportation_segments.len() / 2) as i32,
        transportation_buffer: upload_static_gl_buffer(gl, &prepared.transportation_segments),
    }
}

fn compile_gl_shader(
    gl: &WebGl2RenderingContext,
    shader_type: u32,
    source: &str,
) -> Result<WebGlShader, JsValue> {
    let shader = gl
        .create_shader(shader_type)
        .ok_or_else(|| JsValue::from_str("Failed to create WebGL shader"))?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    let status = gl
        .get_shader_parameter(&shader, WebGl2RenderingContext::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false);
    if status {
        return Ok(shader);
    }

    let log = gl
        .get_shader_info_log(&shader)
        .unwrap_or_else(|| "Unknown shader compile error".to_string());
    Err(JsValue::from_str(&format!("WebGL shader compile failed: {log}")))
}

fn create_simple_gl_painter(gl: &WebGl2RenderingContext) -> Result<SimpleGlPainter, JsValue> {
    let vertex_shader = compile_gl_shader(
        gl,
        WebGl2RenderingContext::VERTEX_SHADER,
        r#"#version 300 es
in vec2 a_pos;
uniform vec2 u_tile_origin;
uniform float u_tile_size;
uniform vec2 u_viewport_px;
uniform float u_dpr;
void main() {
  vec2 screen_css = u_tile_origin + a_pos * u_tile_size;
  vec2 px = screen_css * u_dpr;
  vec2 ndc = vec2(
    (px.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (px.y / u_viewport_px.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
}"#,
    )?;
    let fragment_shader = compile_gl_shader(
        gl,
        WebGl2RenderingContext::FRAGMENT_SHADER,
        r#"#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}"#,
    )?;

    let program = gl
        .create_program()
        .ok_or_else(|| JsValue::from_str("Failed to create WebGL program"))?;
    gl.attach_shader(&program, &vertex_shader);
    gl.attach_shader(&program, &fragment_shader);
    gl.bind_attrib_location(&program, 0, "a_pos");
    gl.link_program(&program);

    let link_ok = gl
        .get_program_parameter(&program, WebGl2RenderingContext::LINK_STATUS)
        .as_bool()
        .unwrap_or(false);
    if !link_ok {
        let log = gl
            .get_program_info_log(&program)
            .unwrap_or_else(|| "Unknown program link error".to_string());
        return Err(JsValue::from_str(&format!("WebGL program link failed: {log}")));
    }

    let position_attrib = gl.get_attrib_location(&program, "a_pos");
    if position_attrib < 0 {
        return Err(JsValue::from_str("WebGL attribute a_pos not found"));
    }

    let color_uniform = gl
        .get_uniform_location(&program, "u_color")
        .ok_or_else(|| JsValue::from_str("WebGL uniform u_color not found"))?;
    let tile_origin_uniform = gl
        .get_uniform_location(&program, "u_tile_origin")
        .ok_or_else(|| JsValue::from_str("WebGL uniform u_tile_origin not found"))?;
    let tile_size_uniform = gl
        .get_uniform_location(&program, "u_tile_size")
        .ok_or_else(|| JsValue::from_str("WebGL uniform u_tile_size not found"))?;
    let viewport_uniform = gl
        .get_uniform_location(&program, "u_viewport_px")
        .ok_or_else(|| JsValue::from_str("WebGL uniform u_viewport_px not found"))?;
    let dpr_uniform = gl
        .get_uniform_location(&program, "u_dpr")
        .ok_or_else(|| JsValue::from_str("WebGL uniform u_dpr not found"))?;

    Ok(SimpleGlPainter {
        program,
        position_attrib: position_attrib as u32,
        color_uniform,
        tile_origin_uniform,
        tile_size_uniform,
        viewport_uniform,
        dpr_uniform,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MvtGeomType {
    Unknown = 0,
    Point = 1,
    LineString = 2,
    Polygon = 3,
}

impl MvtGeomType {
    fn from_u64(value: u64) -> Self {
        match value {
            1 => Self::Point,
            2 => Self::LineString,
            3 => Self::Polygon,
            _ => Self::Unknown,
        }
    }
}

struct ProtoReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> ProtoReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn eof(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    fn read_varint(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u32;

        loop {
            if self.pos >= self.bytes.len() {
                return Err("Unexpected EOF while reading varint".to_string());
            }
            let byte = self.bytes[self.pos];
            self.pos += 1;
            result |= u64::from(byte & 0x7f) << shift;
            if (byte & 0x80) == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                return Err("Varint overflow".to_string());
            }
        }
    }

    fn read_key(&mut self) -> Result<(u32, u8), String> {
        let key = self.read_varint()?;
        let field = (key >> 3) as u32;
        let wire = (key & 0x07) as u8;
        Ok((field, wire))
    }

    fn read_len_delimited(&mut self) -> Result<&'a [u8], String> {
        let len = self.read_varint()? as usize;
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| "Length-delimited overflow".to_string())?;
        if end > self.bytes.len() {
            return Err("Unexpected EOF while reading length-delimited field".to_string());
        }
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn skip_field(&mut self, wire: u8) -> Result<(), String> {
        match wire {
            0 => {
                let _ = self.read_varint()?;
                Ok(())
            }
            1 => {
                let end = self
                    .pos
                    .checked_add(8)
                    .ok_or_else(|| "Fixed64 overflow".to_string())?;
                if end > self.bytes.len() {
                    return Err("Unexpected EOF while skipping fixed64".to_string());
                }
                self.pos = end;
                Ok(())
            }
            2 => {
                let _ = self.read_len_delimited()?;
                Ok(())
            }
            5 => {
                let end = self
                    .pos
                    .checked_add(4)
                    .ok_or_else(|| "Fixed32 overflow".to_string())?;
                if end > self.bytes.len() {
                    return Err("Unexpected EOF while skipping fixed32".to_string());
                }
                self.pos = end;
                Ok(())
            }
            _ => Err(format!("Unsupported protobuf wire type: {wire}")),
        }
    }
}

fn zigzag_decode_u32(value: u32) -> i32 {
    ((value >> 1) as i32) ^ (-((value & 1) as i32))
}

fn decode_mvt_paths(geometry: &[u8]) -> Result<Vec<Vec<(i32, i32)>>, String> {
    let mut reader = ProtoReader::new(geometry);
    let mut x = 0i32;
    let mut y = 0i32;
    let mut command = 0u32;
    let mut count = 0u32;
    let mut paths: Vec<Vec<(i32, i32)>> = Vec::new();
    let mut current: Vec<(i32, i32)> = Vec::new();

    while !reader.eof() {
        if count == 0 {
            let cmd = reader.read_varint()? as u32;
            command = cmd & 0x07;
            count = cmd >> 3;
            if count == 0 {
                continue;
            }
        }

        match command {
            1 => {
                for _ in 0..count {
                    if !current.is_empty() {
                        paths.push(current);
                        current = Vec::new();
                    }
                    let dx = zigzag_decode_u32(reader.read_varint()? as u32);
                    let dy = zigzag_decode_u32(reader.read_varint()? as u32);
                    x = x.saturating_add(dx);
                    y = y.saturating_add(dy);
                    current.push((x, y));
                }
                count = 0;
            }
            2 => {
                for _ in 0..count {
                    let dx = zigzag_decode_u32(reader.read_varint()? as u32);
                    let dy = zigzag_decode_u32(reader.read_varint()? as u32);
                    x = x.saturating_add(dx);
                    y = y.saturating_add(dy);
                    current.push((x, y));
                }
                count = 0;
            }
            7 => {
                // ClosePath has no parameters; keep rings open in the decoded representation.
                if !current.is_empty() {
                    paths.push(current);
                    current = Vec::new();
                }
                count = 0;
            }
            other => return Err(format!("Unsupported MVT geometry command id: {other}")),
        }
    }

    if !current.is_empty() {
        paths.push(current);
    }

    Ok(paths)
}

fn normalize_mvt_path(path: &[(i32, i32)], extent: u32) -> Vec<[f32; 2]> {
    let extent = extent.max(1) as f32;
    path.iter()
        .map(|(x, y)| [(*x as f32) / extent, (*y as f32) / extent])
        .collect()
}

fn decode_mvt_tile_scene(bytes: &[u8]) -> Result<VectorTileScene, String> {
    let mut scene = VectorTileScene::default();
    let mut tile = ProtoReader::new(bytes);

    while !tile.eof() {
        let (field, wire) = tile.read_key()?;
        if field == 3 && wire == 2 {
            let layer_bytes = tile.read_len_delimited()?;
            let mut layer_reader = ProtoReader::new(layer_bytes);
            let mut layer_name = String::new();
            let mut extent: u32 = 4096;
            let mut feature_slices: Vec<&[u8]> = Vec::new();

            while !layer_reader.eof() {
                let (lf, lw) = layer_reader.read_key()?;
                match (lf, lw) {
                    (1, 2) => {
                        let name_bytes = layer_reader.read_len_delimited()?;
                        layer_name = String::from_utf8_lossy(name_bytes).into_owned();
                    }
                    (2, 2) => {
                        feature_slices.push(layer_reader.read_len_delimited()?);
                    }
                    (5, 0) => {
                        extent = (layer_reader.read_varint()? as u32).max(1);
                    }
                    _ => layer_reader.skip_field(lw)?,
                }
            }

            let is_water_fill_layer = layer_name == "ocean" || layer_name == "water_polygons";
            let is_line_layer =
                layer_name == "streets" || layer_name == "boundaries" || layer_name == "water_lines";

            if !is_water_fill_layer && !is_line_layer {
                continue;
            }

            for feature_bytes in feature_slices {
                let mut feature_reader = ProtoReader::new(feature_bytes);
                let mut geom_type = MvtGeomType::Unknown;
                let mut geometry_bytes: Option<&[u8]> = None;

                while !feature_reader.eof() {
                    let (ff, fw) = feature_reader.read_key()?;
                    match (ff, fw) {
                        (3, 0) => geom_type = MvtGeomType::from_u64(feature_reader.read_varint()?),
                        (4, 2) => geometry_bytes = Some(feature_reader.read_len_delimited()?),
                        _ => feature_reader.skip_field(fw)?,
                    }
                }

                let Some(geometry_bytes) = geometry_bytes else {
                    continue;
                };
                let paths = match decode_mvt_paths(geometry_bytes) {
                    Ok(paths) => paths,
                    Err(_) => continue,
                };

                if is_water_fill_layer && geom_type == MvtGeomType::Polygon {
                    for path in paths {
                        if path.len() >= 3 {
                            scene.water_polygons.push(normalize_mvt_path(&path, extent));
                        }
                    }
                    continue;
                }

                if is_line_layer && geom_type == MvtGeomType::LineString {
                    for path in paths {
                        if path.len() >= 2 {
                            scene.transportation_lines.push(normalize_mvt_path(&path, extent));
                        }
                    }
                    continue;
                }

                match (layer_name.as_str(), geom_type) {
                    // Additional polygon roads are treated as line-only later; ignored for now.
                    ("street_polygons", MvtGeomType::Polygon) => {
                        // TODO: polygon road fill styling for higher zoom levels.
                    }
                    _ => {}
                }
            }
        } else {
            tile.skip_field(wire)?;
        }
    }

    Ok(scene)
}

#[derive(Clone)]
struct CachedVectorTile {
    scene: VectorTileScene,
    prepared_geometry: PreparedVectorTileGeometry,
    gl_buffers: Option<TileGlBuffers>,
    last_used: u64,
}

#[derive(Debug, Clone, Copy)]
struct VectorRequestCandidate {
    key: TileKey,
    score: f64,
}

#[derive(Debug, Clone, Copy)]
struct VectorLevelDrawParams {
    z: u8,
    tile_size_f: f64,
    tiles_per_axis: u32,
    display_scale: f64,
    wrapped_top_left_x: f64,
    top_left_world_y: f64,
    tile_display_size: f64,
    min_tx: i64,
    max_tx: i64,
    min_ty: i64,
    max_ty: i64,
}

#[derive(Debug, Clone, Copy)]
struct VectorGlTileDrawCommand {
    key: TileKey,
    screen_x: f64,
    screen_y: f64,
    tile_display_size: f64,
}

struct VectorEngineState {
    surface: CanvasSurface,
    gl: Option<WebGl2RenderingContext>,
    painter: Option<SimpleGlPainter>,
    ctx2d: Option<RenderContext>,
    width: f64,
    height: f64,
    dpr: f64,
    tile_url_template: String,
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u32,
    zoom: f64,
    center_lon: f64,
    center_lat: f64,
    view_animation: Option<ViewAnimation>,
    last_frame_now_ms: f64,
    dragging: Option<DragState>,
    cache_tick: u64,
    cache_limit: usize,
    tile_cache: HashMap<TileKey, CachedVectorTile>,
    pending_tiles: HashSet<TileKey>,
    high_priority_queue: VecDeque<TileKey>,
    medium_priority_queue: VecDeque<TileKey>,
    low_priority_queue: VecDeque<TileKey>,
    in_flight_requests: usize,
    max_in_flight_requests: usize,
    source_max_zoom: u8,
    backend_kind: VectorBackendKind,
    last_zoom_direction: i8,
}

impl VectorEngineState {
    fn zoom_scale(zoom: f64) -> f64 {
        2_f64.powf(zoom)
    }

    fn zoom_scale_for_delta(render_zoom: u8, zoom: f64) -> f64 {
        2.0_f64.powf(zoom - f64::from(render_zoom))
    }

    fn zoom_clamp_f64(&self, zoom: f64) -> f64 {
        zoom.clamp(f64::from(self.min_zoom), f64::from(self.max_zoom))
    }

    fn current_render_zoom(&self) -> u8 {
        self.zoom
            .round()
            .clamp(f64::from(self.min_zoom), f64::from(self.max_zoom)) as u8
    }

    fn current_fetch_zoom(&self) -> u8 {
        self.current_render_zoom().min(self.source_max_zoom)
    }

    fn relevant_fetch_zoom_bounds(&self) -> (u8, u8) {
        let fetch_zoom = self.current_fetch_zoom();
        (
            fetch_zoom.saturating_sub(1),
            fetch_zoom.saturating_add(1).min(self.source_max_zoom),
        )
    }

    fn pop_latest_relevant_request(
        queue: &mut VecDeque<TileKey>,
        pending_tiles: &mut HashSet<TileKey>,
        min_relevant_zoom: u8,
        max_relevant_zoom: u8,
    ) -> Option<TileKey> {
        while let Some(key) = queue.pop_back() {
            if key.z >= min_relevant_zoom && key.z <= max_relevant_zoom {
                return Some(key);
            }
            pending_tiles.remove(&key);
        }

        None
    }

    fn cancel_view_animation(&mut self) {
        self.view_animation = None;
    }

    fn interpolate_lon_shortest(start_lon: f64, target_lon: f64, t: f64) -> f64 {
        let wrapped_delta = (target_lon - start_lon + 540.0).rem_euclid(360.0) - 180.0;
        normalize_lon(start_lon + wrapped_delta * t)
    }

    fn start_view_animation(&mut self, target_lon: f64, target_lat: f64, target_zoom: f64) {
        let target_lon = normalize_lon(target_lon);
        let target_lat = clamp_lat(target_lat);
        let target_zoom = self.zoom_clamp_f64(target_zoom);

        let lon_delta = (target_lon - self.center_lon + 540.0).rem_euclid(360.0) - 180.0;
        if lon_delta.abs() < 1e-9
            && (target_lat - self.center_lat).abs() < 1e-9
            && (target_zoom - self.zoom).abs() < 1e-9
        {
            self.cancel_view_animation();
            self.center_lon = target_lon;
            self.center_lat = target_lat;
            self.zoom = target_zoom;
            return;
        }

        self.view_animation = Some(ViewAnimation {
            start_lon: self.center_lon,
            start_lat: self.center_lat,
            start_zoom: self.zoom,
            target_lon,
            target_lat,
            target_zoom,
            start_ms: self.last_frame_now_ms,
            duration_ms: VIEW_ANIMATION_DURATION_MS,
        });
    }

    fn update_view_animation(&mut self, now_ms: f64) {
        let Some(animation) = self.view_animation else {
            return;
        };

        let duration_ms = animation.duration_ms.max(1.0);
        let progress = ((now_ms - animation.start_ms) / duration_ms).clamp(0.0, 1.0);
        let eased_progress = 1.0 - (1.0 - progress).powi(3);

        self.center_lon = Self::interpolate_lon_shortest(
            animation.start_lon,
            animation.target_lon,
            eased_progress,
        );
        self.center_lat = clamp_lat(
            animation.start_lat + (animation.target_lat - animation.start_lat) * eased_progress,
        );
        self.zoom = self.zoom_clamp_f64(
            animation.start_zoom + (animation.target_zoom - animation.start_zoom) * eased_progress,
        );

        if progress >= 1.0 {
            self.view_animation = None;
            self.center_lon = normalize_lon(animation.target_lon);
            self.center_lat = clamp_lat(animation.target_lat);
            self.zoom = self.zoom_clamp_f64(animation.target_zoom);
        }
    }

    fn resize(&mut self, width: u32, height: u32, dpr: f32) {
        self.width = f64::from(width);
        self.height = f64::from(height);
        self.dpr = f64::from(dpr.max(0.1));

        let pixel_width = (self.width * self.dpr).round().max(1.0) as u32;
        let pixel_height = (self.height * self.dpr).round().max(1.0) as u32;
        self.surface.set_pixel_size(pixel_width, pixel_height);
        if let Some(gl) = &self.gl {
            gl.viewport(0, 0, pixel_width as i32, pixel_height as i32);
        }
    }

    fn set_view(&mut self, lon: f64, lat: f32, zoom: f32) {
        self.cancel_view_animation();
        self.center_lon = normalize_lon(lon);
        self.center_lat = clamp_lat(f64::from(lat));
        self.zoom = self.zoom_clamp_f64(f64::from(zoom));
    }

    fn tile_url(&self, key: TileKey) -> String {
        self.tile_url_template
            .replace("{z}", &key.z.to_string())
            .replace("{x}", &key.x.to_string())
            .replace("{y}", &key.y.to_string())
    }

    fn set_tile_url_template(&mut self, template: String) {
        if self.tile_url_template == template {
            return;
        }

        self.cancel_view_animation();
        self.tile_url_template = template;
        self.pending_tiles.clear();
        self.high_priority_queue.clear();
        self.medium_priority_queue.clear();
        self.low_priority_queue.clear();
        self.in_flight_requests = 0;
        self.tile_cache.clear();
    }

    fn is_zoom_relevant_for_view(&self, tile_zoom: u8) -> bool {
        let target_zoom = self.zoom.round() as i32;
        let tile_zoom = i32::from(tile_zoom);
        (tile_zoom - target_zoom).abs() <= 2
    }

    fn enqueue_tile_request(&mut self, key: TileKey, priority: RequestPriority) {
        if self.tile_cache.contains_key(&key) || self.pending_tiles.contains(&key) {
            return;
        }

        self.pending_tiles.insert(key);
        match priority {
            RequestPriority::High => self.high_priority_queue.push_back(key),
            RequestPriority::Medium => self.medium_priority_queue.push_back(key),
            RequestPriority::Low => self.low_priority_queue.push_back(key),
        }
    }

    fn enqueue_candidates_sorted(
        &mut self,
        mut candidates: Vec<VectorRequestCandidate>,
        priority: RequestPriority,
    ) {
        candidates.sort_by(|a, b| a.score.total_cmp(&b.score));
        for candidate in candidates.into_iter().rev() {
            self.enqueue_tile_request(candidate.key, priority);
        }
    }

    fn queue_zoom_warmup_tiles(&mut self, base_fetch_zoom: u8) {
        if self.last_zoom_direction == 0 || self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        // Only warm adjacent zoom levels while the user is actively between rounded levels.
        if (self.zoom - self.zoom.round()).abs() < 0.08 {
            return;
        }

        let target_zoom = if self.last_zoom_direction > 0 {
            if base_fetch_zoom >= self.source_max_zoom {
                return;
            }
            base_fetch_zoom + 1
        } else {
            if base_fetch_zoom <= self.min_zoom {
                return;
            }
            base_fetch_zoom - 1
        };

        let tile_size_f = f64::from(self.tile_size);
        let display_scale = Self::zoom_scale_for_delta(target_zoom, self.zoom);
        if display_scale <= 0.0 {
            return;
        }

        let (center_world_x, center_world_y) =
            lon_lat_to_world(self.center_lon, self.center_lat, target_zoom, self.tile_size);
        let top_left_world_x = center_world_x - (self.width * 0.5) / display_scale;
        let top_left_world_y = center_world_y - (self.height * 0.5) / display_scale;
        let viewport_world_w = self.width / display_scale;
        let viewport_world_h = self.height / display_scale;
        let tiles_per_axis = 1u32 << target_zoom;

        let min_tx = (top_left_world_x / tile_size_f).floor() as i64;
        let max_tx = ((top_left_world_x + viewport_world_w) / tile_size_f).ceil() as i64;
        let min_ty = (top_left_world_y / tile_size_f).floor() as i64;
        let max_ty = ((top_left_world_y + viewport_world_h) / tile_size_f).ceil() as i64;

        let mut candidates = Vec::new();
        for ty in min_ty..=max_ty {
            if ty < 0 || ty >= i64::from(tiles_per_axis) {
                continue;
            }

            for tx in min_tx..=max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(tiles_per_axis)) as u32;
                let tile_center_x = (tx as f64 + 0.5) * tile_size_f;
                let tile_center_y = (ty as f64 + 0.5) * tile_size_f;
                let dx = tile_center_x - center_world_x;
                let dy = tile_center_y - center_world_y;
                candidates.push(VectorRequestCandidate {
                    key: TileKey {
                        z: target_zoom,
                        x: wrapped_tx,
                        y: ty as u32,
                    },
                    score: dx * dx + dy * dy,
                });
            }
        }

        self.enqueue_candidates_sorted(candidates, RequestPriority::Low);
    }

    fn dequeue_next_request(&mut self) -> Option<TileKey> {
        let (min_relevant_zoom, max_relevant_zoom) = self.relevant_fetch_zoom_bounds();

        if let Some(key) = Self::pop_latest_relevant_request(
            &mut self.high_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        ) {
            return Some(key);
        }

        if let Some(key) = Self::pop_latest_relevant_request(
            &mut self.medium_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        ) {
            return Some(key);
        }

        Self::pop_latest_relevant_request(
            &mut self.low_priority_queue,
            &mut self.pending_tiles,
            min_relevant_zoom,
            max_relevant_zoom,
        )
    }

    fn insert_tile_scene(&mut self, key: TileKey, scene: VectorTileScene) {
        self.cache_tick = self.cache_tick.saturating_add(1);
        let prepared_geometry = build_prepared_vector_tile_geometry(&scene);
        self.tile_cache.insert(
            key,
            CachedVectorTile {
                scene,
                prepared_geometry,
                gl_buffers: None,
                last_used: self.cache_tick,
            },
        );

        if self.tile_cache.len() > self.cache_limit {
            if let Some((evict_key, _)) = self
                .tile_cache
                .iter()
                .min_by_key(|(_, value)| value.last_used)
                .map(|(key, value)| (*key, value.last_used))
            {
                self.tile_cache.remove(&evict_key);
            }
        }
    }

    fn touch_cached_tile(&mut self, key: TileKey) -> bool {
        if let Some(tile) = self.tile_cache.get_mut(&key) {
            self.cache_tick = self.cache_tick.saturating_add(1);
            tile.last_used = self.cache_tick;
            return true;
        }

        false
    }

    fn touch_and_get_tile_gl_buffers(
        &mut self,
        gl: &WebGl2RenderingContext,
        key: TileKey,
    ) -> Option<TileGlBuffers> {
        let next_tick = self.cache_tick.saturating_add(1);
        self.cache_tick = next_tick;

        let tile = self.tile_cache.get_mut(&key)?;
        tile.last_used = next_tick;
        if tile.gl_buffers.is_none() {
            tile.gl_buffers = Some(build_tile_gl_buffers(gl, &tile.prepared_geometry));
        }
        tile.gl_buffers.clone()
    }

    fn collect_cached_level_gl_draw_commands(
        &self,
        z: u8,
        margin_tiles: i64,
        out: &mut Vec<VectorGlTileDrawCommand>,
    ) {
        let Some(params) = self.level_draw_params(z, margin_tiles) else {
            return;
        };
        if params.tile_display_size <= 0.0 {
            return;
        }

        for ty in params.min_ty..=params.max_ty {
            if ty < 0 || ty >= i64::from(params.tiles_per_axis) {
                continue;
            }

            for tx in params.min_tx..=params.max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(params.tiles_per_axis)) as u32;
                let key = TileKey {
                    z: params.z,
                    x: wrapped_tx,
                    y: ty as u32,
                };
                if !self.tile_cache.contains_key(&key) {
                    continue;
                }

                let tile_world_x = (tx as f64) * params.tile_size_f;
                let screen_x = (tile_world_x - params.wrapped_top_left_x) * params.display_scale;
                let screen_y =
                    ((ty as f64) * params.tile_size_f - params.top_left_world_y) * params.display_scale;

                if screen_x > self.width + params.tile_display_size
                    || screen_y > self.height + params.tile_display_size
                    || screen_x + params.tile_display_size < -params.tile_display_size
                    || screen_y + params.tile_display_size < -params.tile_display_size
                {
                    continue;
                }

                out.push(VectorGlTileDrawCommand {
                    key,
                    screen_x,
                    screen_y,
                    tile_display_size: params.tile_display_size,
                });
            }
        }
    }

    fn draw_cached_tile_webgl_layers(
        &mut self,
        gl: &WebGl2RenderingContext,
        painter: &SimpleGlPainter,
        cmd: VectorGlTileDrawCommand,
        viewport_pixel_width: f64,
        viewport_pixel_height: f64,
        draw_water: bool,
        draw_lines: bool,
    ) {
        let Some(buffers) = self.touch_and_get_tile_gl_buffers(gl, cmd.key) else {
            return;
        };

        if draw_water {
            if let (Some(buffer), count) = (buffers.water_buffer.as_ref(), buffers.water_vertex_count) {
            painter.draw_tile_buffer(
                gl,
                WebGl2RenderingContext::TRIANGLES,
                buffer,
                count,
                [0.70, 0.86, 0.95, 1.0],
                cmd.screen_x,
                cmd.screen_y,
                cmd.tile_display_size,
                viewport_pixel_width,
                viewport_pixel_height,
                self.dpr,
            );
        }
        }

        if draw_lines {
            if let (Some(buffer), count) =
                (buffers.transportation_buffer.as_ref(), buffers.transportation_vertex_count)
            {
            painter.draw_tile_buffer(
                gl,
                WebGl2RenderingContext::LINES,
                buffer,
                count,
                [0.867, 0.839, 0.788, 1.0],
                cmd.screen_x,
                cmd.screen_y,
                cmd.tile_display_size,
                viewport_pixel_width,
                viewport_pixel_height,
                self.dpr,
            );
        }
        }
    }

    #[allow(dead_code)]
    fn screen_px_to_ndc(&self, screen_x: f64, screen_y: f64, pixel_width: f64, pixel_height: f64) -> [f32; 2] {
        let px = screen_x * self.dpr;
        let py = screen_y * self.dpr;
        [
            ((px / pixel_width) * 2.0 - 1.0) as f32,
            (1.0 - (py / pixel_height) * 2.0) as f32,
        ]
    }

    #[allow(dead_code)]
    fn append_prepared_tile_geometry(
        &self,
        prepared: &PreparedVectorTileGeometry,
        tile_screen_x: f64,
        tile_screen_y: f64,
        tile_display_size: f64,
        pixel_width: f64,
        pixel_height: f64,
        water_triangles_ndc: &mut Vec<f32>,
        transportation_segments_ndc: &mut Vec<f32>,
    ) {
        if tile_display_size <= 0.0 {
            return;
        }

        water_triangles_ndc.reserve(prepared.water_triangles.len());
        for point in prepared.water_triangles.chunks_exact(2) {
            let ndc = self.screen_px_to_ndc(
                tile_screen_x + f64::from(point[0]) * tile_display_size,
                tile_screen_y + f64::from(point[1]) * tile_display_size,
                pixel_width,
                pixel_height,
            );
            water_triangles_ndc.extend_from_slice(&[ndc[0], ndc[1]]);
        }

        transportation_segments_ndc.reserve(prepared.transportation_segments.len());
        for point in prepared.transportation_segments.chunks_exact(2) {
            let ndc = self.screen_px_to_ndc(
                tile_screen_x + f64::from(point[0]) * tile_display_size,
                tile_screen_y + f64::from(point[1]) * tile_display_size,
                pixel_width,
                pixel_height,
            );
            transportation_segments_ndc.extend_from_slice(&[ndc[0], ndc[1]]);
        }
    }

    fn draw_scene_canvas2d(
        ctx: &RenderContext,
        scene: &VectorTileScene,
        tile_screen_x: f64,
        tile_screen_y: f64,
        tile_display_size: f64,
        display_scale: f64,
    ) {
        for ring in &scene.water_polygons {
            if ring.len() < 3 {
                continue;
            }
            ctx.set_fill_style_str("#b3dbf2");
            ctx.begin_path();
            let first = ring[0];
            ctx.move_to(
                tile_screen_x + f64::from(first[0]) * tile_display_size,
                tile_screen_y + f64::from(first[1]) * tile_display_size,
            );
            for point in ring.iter().skip(1) {
                ctx.line_to(
                    tile_screen_x + f64::from(point[0]) * tile_display_size,
                    tile_screen_y + f64::from(point[1]) * tile_display_size,
                );
            }
            ctx.fill();
        }

        if !scene.transportation_lines.is_empty() {
            ctx.set_stroke_style_str("#ddd6c9");
            ctx.set_line_width((1.0 + display_scale * 0.15).clamp(1.0, 2.5));
            for path in &scene.transportation_lines {
                if path.len() < 2 {
                    continue;
                }
                ctx.begin_path();
                let first = path[0];
                ctx.move_to(
                    tile_screen_x + f64::from(first[0]) * tile_display_size,
                    tile_screen_y + f64::from(first[1]) * tile_display_size,
                );
                for point in path.iter().skip(1) {
                    ctx.line_to(
                        tile_screen_x + f64::from(point[0]) * tile_display_size,
                        tile_screen_y + f64::from(point[1]) * tile_display_size,
                    );
                }
                ctx.stroke();
            }
        }
    }

    fn project_lon_lat_to_screen(&self, lon: f64, lat: f64) -> Option<ProjectedPoint> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }

        let render_zoom = self.zoom.round().clamp(f64::from(self.min_zoom), f64::from(self.max_zoom)) as u8;
        let (center_world_x, center_world_y) =
            lon_lat_to_world(self.center_lon, self.center_lat, render_zoom, self.tile_size);
        let (point_world_x, point_world_y) =
            lon_lat_to_world(lon, lat, render_zoom, self.tile_size);
        let display_scale = Self::zoom_scale_for_delta(render_zoom, self.zoom);

        Some(ProjectedPoint {
            screen_x: self.width * 0.5 + (point_world_x - center_world_x) * display_scale,
            screen_y: self.height * 0.5 + (point_world_y - center_world_y) * display_scale,
        })
    }

    fn zoom_to_box_screen_rect(&mut self, start_x: f64, start_y: f64, end_x: f64, end_y: f64) {
        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        let left = start_x.min(end_x).clamp(0.0, self.width);
        let right = start_x.max(end_x).clamp(0.0, self.width);
        let top = start_y.min(end_y).clamp(0.0, self.height);
        let bottom = start_y.max(end_y).clamp(0.0, self.height);

        let selection_width = right - left;
        let selection_height = bottom - top;
        if selection_width < 1.0 || selection_height < 1.0 {
            return;
        }

        let current_display_scale = Self::zoom_scale(self.zoom).max(1e-9);
        let (center_world0_x, center_world0_y) =
            lon_lat_to_world(self.center_lon, self.center_lat, 0, self.tile_size);
        let left_world0 = center_world0_x + (left - self.width * 0.5) / current_display_scale;
        let right_world0 = center_world0_x + (right - self.width * 0.5) / current_display_scale;
        let top_world0 = center_world0_y + (top - self.height * 0.5) / current_display_scale;
        let bottom_world0 = center_world0_y + (bottom - self.height * 0.5) / current_display_scale;

        let min_world0_x = left_world0.min(right_world0);
        let max_world0_x = left_world0.max(right_world0);
        let min_world0_y = top_world0.min(bottom_world0);
        let max_world0_y = top_world0.max(bottom_world0);
        let world_width = (max_world0_x - min_world0_x).max(1e-12);
        let world_height = (max_world0_y - min_world0_y).max(1e-12);
        let safe_fit_padding = BOX_ZOOM_FIT_PADDING.clamp(0.05, 1.0);

        let target_display_scale =
            ((self.width / world_width).min(self.height / world_height) * safe_fit_padding)
                .max(1e-9);
        let target_zoom = self.zoom_clamp_f64(target_display_scale.log2());
        let focus_world0_x = (min_world0_x + max_world0_x) * 0.5;
        let focus_world0_y = (min_world0_y + max_world0_y) * 0.5;
        let (target_lon, target_lat) =
            world_to_lon_lat(focus_world0_x, focus_world0_y, 0, self.tile_size);

        self.start_view_animation(target_lon, target_lat, target_zoom);
    }

    fn level_draw_params(&self, z: u8, margin_tiles: i64) -> Option<VectorLevelDrawParams> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }

        let tile_size_f = f64::from(self.tile_size);
        let display_scale = Self::zoom_scale_for_delta(z, self.zoom);
        if display_scale <= 0.0 {
            return None;
        }

        let (center_world_x, center_world_y) =
            lon_lat_to_world(self.center_lon, self.center_lat, z, self.tile_size);
        let top_left_world_x = center_world_x - (self.width * 0.5) / display_scale;
        let top_left_world_y = center_world_y - (self.height * 0.5) / display_scale;
        let tiles_per_axis = 1u32 << z;
        let world_span = tile_size_f * f64::from(tiles_per_axis);
        let viewport_world_w = self.width / display_scale;
        let viewport_world_h = self.height / display_scale;

        Some(VectorLevelDrawParams {
            z,
            tile_size_f,
            tiles_per_axis,
            display_scale,
            wrapped_top_left_x: top_left_world_x.rem_euclid(world_span),
            top_left_world_y,
            tile_display_size: tile_size_f * display_scale,
            min_tx: (top_left_world_x / tile_size_f).floor() as i64 - margin_tiles,
            max_tx: ((top_left_world_x + viewport_world_w) / tile_size_f).ceil() as i64
                + margin_tiles,
            min_ty: (top_left_world_y / tile_size_f).floor() as i64 - margin_tiles,
            max_ty: ((top_left_world_y + viewport_world_h) / tile_size_f).ceil() as i64
                + margin_tiles,
        })
    }

    fn has_pending_tiles_for_zoom(&self, z: u8) -> bool {
        self.pending_tiles.iter().any(|key| key.z == z)
    }

    fn fallback_zoom_for_frame(&self, target_fetch_zoom: u8) -> Option<u8> {
        if self.last_zoom_direction == 0 {
            return None;
        }
        if (self.zoom - self.zoom.round()).abs() < 0.05 && !self.has_pending_tiles_for_zoom(target_fetch_zoom) {
            return None;
        }

        if self.last_zoom_direction > 0 {
            (target_fetch_zoom > self.min_zoom).then_some(target_fetch_zoom - 1)
        } else {
            (target_fetch_zoom < self.source_max_zoom).then_some(target_fetch_zoom + 1)
        }
    }

    fn draw_cached_level_canvas2d(&mut self, ctx: &RenderContext, z: u8) {
        let Some(params) = self.level_draw_params(z, 1) else {
            return;
        };
        if params.tile_display_size <= 0.0 {
            return;
        }

        for ty in params.min_ty..=params.max_ty {
            if ty < 0 || ty >= i64::from(params.tiles_per_axis) {
                continue;
            }

            for tx in params.min_tx..=params.max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(params.tiles_per_axis)) as u32;
                let key = TileKey { z: params.z, x: wrapped_tx, y: ty as u32 };

                let tile_world_x = (tx as f64) * params.tile_size_f;
                let screen_x = (tile_world_x - params.wrapped_top_left_x) * params.display_scale;
                let screen_y =
                    ((ty as f64) * params.tile_size_f - params.top_left_world_y) * params.display_scale;

                if screen_x > self.width + params.tile_display_size
                    || screen_y > self.height + params.tile_display_size
                    || screen_x + params.tile_display_size < -params.tile_display_size
                    || screen_y + params.tile_display_size < -params.tile_display_size
                {
                    continue;
                }

                if self.touch_cached_tile(key) {
                    if let Some(tile) = self.tile_cache.get(&key) {
                    Self::draw_scene_canvas2d(
                        ctx,
                        &tile.scene,
                        screen_x,
                        screen_y,
                        params.tile_display_size,
                        params.display_scale,
                    );
                    }
                }
            }
        }
    }

    #[allow(dead_code)]
    fn append_cached_level_geometry_webgl(
        &mut self,
        z: u8,
        pixel_width: f64,
        pixel_height: f64,
        water_triangles_ndc: &mut Vec<f32>,
        transportation_segments_ndc: &mut Vec<f32>,
    ) {
        let Some(params) = self.level_draw_params(z, 1) else {
            return;
        };
        if params.tile_display_size <= 0.0 {
            return;
        }

        for ty in params.min_ty..=params.max_ty {
            if ty < 0 || ty >= i64::from(params.tiles_per_axis) {
                continue;
            }

            for tx in params.min_tx..=params.max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(params.tiles_per_axis)) as u32;
                let key = TileKey { z: params.z, x: wrapped_tx, y: ty as u32 };

                let tile_world_x = (tx as f64) * params.tile_size_f;
                let screen_x = (tile_world_x - params.wrapped_top_left_x) * params.display_scale;
                let screen_y =
                    ((ty as f64) * params.tile_size_f - params.top_left_world_y) * params.display_scale;

                if screen_x > self.width + params.tile_display_size
                    || screen_y > self.height + params.tile_display_size
                    || screen_x + params.tile_display_size < -params.tile_display_size
                    || screen_y + params.tile_display_size < -params.tile_display_size
                {
                    continue;
                }

                if self.touch_cached_tile(key) {
                    if let Some(tile) = self.tile_cache.get(&key) {
                        self.append_prepared_tile_geometry(
                        &tile.prepared_geometry,
                        screen_x,
                        screen_y,
                        params.tile_display_size,
                        pixel_width,
                        pixel_height,
                        water_triangles_ndc,
                        transportation_segments_ndc,
                    );
                    }
                }
            }
        }
    }

    fn queue_visible_tiles(&mut self) -> (u8, f64, f64, f64) {
        let render_zoom = self.current_render_zoom();
        let fetch_zoom = render_zoom.min(self.source_max_zoom);
        let tile_size_f = f64::from(self.tile_size);
        let display_scale = Self::zoom_scale_for_delta(fetch_zoom, self.zoom);
        let (center_world_x, center_world_y) =
            lon_lat_to_world(self.center_lon, self.center_lat, fetch_zoom, self.tile_size);
        let top_left_world_x = center_world_x - (self.width * 0.5) / display_scale;
        let top_left_world_y = center_world_y - (self.height * 0.5) / display_scale;
        let tiles_per_axis = 1u32 << fetch_zoom;
        let world_span = tile_size_f * f64::from(tiles_per_axis);
        let viewport_world_w = self.width / display_scale;
        let viewport_world_h = self.height / display_scale;

        let visible_min_tx = (top_left_world_x / tile_size_f).floor() as i64;
        let visible_max_tx = ((top_left_world_x + viewport_world_w) / tile_size_f).ceil() as i64;
        let visible_min_ty = (top_left_world_y / tile_size_f).floor() as i64;
        let visible_max_ty = ((top_left_world_y + viewport_world_h) / tile_size_f).ceil() as i64;

        let outer_min_tx = visible_min_tx - i64::from(VECTOR_PREFETCH_OUTER_MARGIN);
        let outer_max_tx = visible_max_tx + i64::from(VECTOR_PREFETCH_OUTER_MARGIN);
        let outer_min_ty = visible_min_ty - i64::from(VECTOR_PREFETCH_OUTER_MARGIN);
        let outer_max_ty = visible_max_ty + i64::from(VECTOR_PREFETCH_OUTER_MARGIN);

        let immediate_min_tx = visible_min_tx - i64::from(TILE_PREFETCH_MARGIN);
        let immediate_max_tx = visible_max_tx + i64::from(TILE_PREFETCH_MARGIN);
        let immediate_min_ty = visible_min_ty - i64::from(TILE_PREFETCH_MARGIN);
        let immediate_max_ty = visible_max_ty + i64::from(TILE_PREFETCH_MARGIN);

        let mut high_candidates = Vec::new();
        let mut medium_candidates = Vec::new();
        let mut low_candidates = Vec::new();

        for ty in outer_min_ty..=outer_max_ty {
            if ty < 0 || ty >= i64::from(tiles_per_axis) {
                continue;
            }

            for tx in outer_min_tx..=outer_max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(tiles_per_axis)) as u32;
                let tile_center_x = (tx as f64 + 0.5) * tile_size_f;
                let tile_center_y = (ty as f64 + 0.5) * tile_size_f;
                let dx = tile_center_x - center_world_x;
                let dy = tile_center_y - center_world_y;
                let candidate = VectorRequestCandidate {
                    key: TileKey {
                        z: fetch_zoom,
                        x: wrapped_tx,
                        y: ty as u32,
                    },
                    score: dx * dx + dy * dy,
                };

                let is_visible = tx >= visible_min_tx
                    && tx <= visible_max_tx
                    && ty >= visible_min_ty
                    && ty <= visible_max_ty;
                let is_immediate_ring = tx >= immediate_min_tx
                    && tx <= immediate_max_tx
                    && ty >= immediate_min_ty
                    && ty <= immediate_max_ty;

                if is_visible {
                    high_candidates.push(candidate);
                } else if is_immediate_ring {
                    medium_candidates.push(candidate);
                } else {
                    low_candidates.push(candidate);
                }
            }
        }

        self.enqueue_candidates_sorted(low_candidates, RequestPriority::Low);
        self.enqueue_candidates_sorted(medium_candidates, RequestPriority::Medium);
        self.enqueue_candidates_sorted(high_candidates, RequestPriority::High);
        self.queue_zoom_warmup_tiles(fetch_zoom);

        // Wrap top-left x into world span to keep screen placement stable for rendering.
        let wrapped_top_left_x = top_left_world_x.rem_euclid(world_span);
        (fetch_zoom, display_scale, wrapped_top_left_x, top_left_world_y)
    }

    fn draw(&mut self, now_ms: f64) {
        self.last_frame_now_ms = now_ms;
        self.update_view_animation(now_ms);
        if self.gl.is_some() {
            self.draw_webgl();
        } else {
            self.draw_canvas2d();
        }
    }

    fn draw_canvas2d(&mut self) {
        let Some(ctx) = self.ctx2d.clone() else {
            return;
        };

        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        let _ = ctx.set_transform(self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0);
        ctx.set_fill_style_str("#f4f4f2");
        ctx.fill_rect(0.0, 0.0, self.width, self.height);

        let (fetch_zoom, display_scale, wrapped_top_left_x, top_left_world_y) = self.queue_visible_tiles();
        if let Some(fallback_zoom) = self.fallback_zoom_for_frame(fetch_zoom) {
            self.draw_cached_level_canvas2d(&ctx, fallback_zoom);
        }
        let tile_size_f = f64::from(self.tile_size);
        let tile_display_size = tile_size_f * display_scale;
        if tile_display_size <= 0.0 {
            return;
        }

        let tiles_per_axis = 1u32 << fetch_zoom;
        let viewport_world_w = self.width / display_scale;
        let viewport_world_h = self.height / display_scale;

        let min_tx = (wrapped_top_left_x / tile_size_f).floor() as i64 - 1;
        let max_tx = ((wrapped_top_left_x + viewport_world_w) / tile_size_f).ceil() as i64 + 1;
        let min_ty = (top_left_world_y / tile_size_f).floor() as i64 - 1;
        let max_ty = ((top_left_world_y + viewport_world_h) / tile_size_f).ceil() as i64 + 1;

        for ty in min_ty..=max_ty {
            if ty < 0 || ty >= i64::from(tiles_per_axis) {
                continue;
            }

            for tx in min_tx..=max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(tiles_per_axis)) as u32;
                let key = TileKey {
                    z: fetch_zoom,
                    x: wrapped_tx,
                    y: ty as u32,
                };

                let tile_world_x = (tx as f64) * tile_size_f;
                let screen_x = (tile_world_x - wrapped_top_left_x) * display_scale;
                let screen_y = ((ty as f64) * tile_size_f - top_left_world_y) * display_scale;

                if screen_x > self.width + tile_display_size
                    || screen_y > self.height + tile_display_size
                    || screen_x + tile_display_size < -tile_display_size
                    || screen_y + tile_display_size < -tile_display_size
                {
                    continue;
                }

                if self.touch_cached_tile(key) {
                    if let Some(tile) = self.tile_cache.get(&key) {
                        Self::draw_scene_canvas2d(
                            &ctx,
                            &tile.scene,
                            screen_x,
                            screen_y,
                            tile_display_size,
                            display_scale,
                        );
                    }
                } else if self.pending_tiles.contains(&key) {
                    ctx.set_fill_style_str("#f3f2ee");
                    ctx.fill_rect(screen_x, screen_y, tile_display_size, tile_display_size);
                }
            }
        }
    }

    fn draw_webgl(&mut self) {
        let Some(gl) = self.gl.clone() else {
            return;
        };

        let pixel_width = (self.width * self.dpr).round().max(1.0) as i32;
        let pixel_height = (self.height * self.dpr).round().max(1.0) as i32;
        gl.viewport(0, 0, pixel_width, pixel_height);
        gl.disable(WebGl2RenderingContext::SCISSOR_TEST);
        gl.disable(WebGl2RenderingContext::BLEND);
        gl.clear_color(0.956, 0.956, 0.952, 1.0);
        gl.clear(WebGl2RenderingContext::COLOR_BUFFER_BIT);

        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }

        let (fetch_zoom, display_scale, wrapped_top_left_x, top_left_world_y) = self.queue_visible_tiles();
        let tile_size_f = f64::from(self.tile_size);
        let tile_display_size = tile_size_f * display_scale;
        if tile_display_size <= 0.0 {
            return;
        }

        let tiles_per_axis = 1u32 << fetch_zoom;
        let viewport_world_w = self.width / display_scale;
        let viewport_world_h = self.height / display_scale;

        let min_tx = (wrapped_top_left_x / tile_size_f).floor() as i64 - 1;
        let max_tx = ((wrapped_top_left_x + viewport_world_w) / tile_size_f).ceil() as i64 + 1;
        let min_ty = (top_left_world_y / tile_size_f).floor() as i64 - 1;
        let max_ty = ((top_left_world_y + viewport_world_h) / tile_size_f).ceil() as i64 + 1;

        let pixel_width_f = f64::from(pixel_width.max(1));
        let pixel_height_f = f64::from(pixel_height.max(1));
        let mut fallback_draw_commands: Vec<VectorGlTileDrawCommand> = Vec::new();
        let mut target_draw_commands: Vec<VectorGlTileDrawCommand> = Vec::new();
        if let Some(fallback_zoom) = self.fallback_zoom_for_frame(fetch_zoom) {
            self.collect_cached_level_gl_draw_commands(fallback_zoom, 1, &mut fallback_draw_commands);
        }

        gl.enable(WebGl2RenderingContext::SCISSOR_TEST);

        for ty in min_ty..=max_ty {
            if ty < 0 || ty >= i64::from(tiles_per_axis) {
                continue;
            }

            for tx in min_tx..=max_tx {
                let wrapped_tx = tx.rem_euclid(i64::from(tiles_per_axis)) as u32;
                let key = TileKey {
                    z: fetch_zoom,
                    x: wrapped_tx,
                    y: ty as u32,
                };

                let tile_world_x = (tx as f64) * tile_size_f;
                let screen_x = (tile_world_x - wrapped_top_left_x) * display_scale;
                let screen_y = ((ty as f64) * tile_size_f - top_left_world_y) * display_scale;

                if screen_x > self.width + tile_display_size
                    || screen_y > self.height + tile_display_size
                    || screen_x + tile_display_size < -tile_display_size
                    || screen_y + tile_display_size < -tile_display_size
                {
                    continue;
                }

                let mut placeholder_fill_color: Option<(f32, f32, f32)> = None;
                let x_px = (screen_x * self.dpr).round() as i32;
                let y_px = ((self.height - (screen_y + tile_display_size)) * self.dpr).round() as i32;
                let w_px = ((tile_display_size * self.dpr).round() as i32).max(1);
                let h_px = ((tile_display_size * self.dpr).round() as i32).max(1);

                if self.tile_cache.contains_key(&key) {
                    target_draw_commands.push(VectorGlTileDrawCommand {
                        key,
                        screen_x,
                        screen_y,
                        tile_display_size,
                    });
                } else if self.pending_tiles.contains(&key) {
                    placeholder_fill_color = Some((0.952, 0.950, 0.942));
                }

                if let Some((r, g, b)) = placeholder_fill_color {
                    gl.scissor(x_px, y_px, w_px, h_px);
                    gl.clear_color(r, g, b, 1.0);
                    gl.clear(WebGl2RenderingContext::COLOR_BUFFER_BIT);
                }
            }
        }

        gl.disable(WebGl2RenderingContext::SCISSOR_TEST);
        if let Some(painter) = self.painter.clone() {
            for cmd in &fallback_draw_commands {
                self.draw_cached_tile_webgl_layers(
                    &gl,
                    &painter,
                    *cmd,
                    pixel_width_f,
                    pixel_height_f,
                    true,
                    false,
                );
            }
            for cmd in &target_draw_commands {
                self.draw_cached_tile_webgl_layers(
                    &gl,
                    &painter,
                    *cmd,
                    pixel_width_f,
                    pixel_height_f,
                    true,
                    false,
                );
            }
            gl.line_width(1.0);
            for cmd in &fallback_draw_commands {
                self.draw_cached_tile_webgl_layers(
                    &gl,
                    &painter,
                    *cmd,
                    pixel_width_f,
                    pixel_height_f,
                    false,
                    true,
                );
            }
            for cmd in &target_draw_commands {
                self.draw_cached_tile_webgl_layers(
                    &gl,
                    &painter,
                    *cmd,
                    pixel_width_f,
                    pixel_height_f,
                    false,
                    true,
                );
            }
        }
    }

    fn get_view_state(&self) -> ViewState {
        ViewState {
            lon: self.center_lon,
            lat: self.center_lat,
            zoom: self.zoom,
        }
    }
}

fn request_vector_tile(state: Rc<RefCell<VectorEngineState>>, key: TileKey, url: String) {
    spawn_local(async move {
        let request_url = url.clone();
        let result = fetch_tile_bytes(url).await.and_then(|value| {
            let bytes = Uint8Array::new(&value).to_vec();
            Ok(bytes)
        });

        {
            let mut state_mut = state.borrow_mut();
            state_mut.pending_tiles.remove(&key);
            state_mut.in_flight_requests = state_mut.in_flight_requests.saturating_sub(1);

            let is_current_source = state_mut.tile_url(key) == request_url;
            let is_relevant_zoom = state_mut.is_zoom_relevant_for_view(key.z);

            if is_current_source && is_relevant_zoom {
                if let Ok(bytes) = result {
                    if let Ok(scene) = decode_mvt_tile_scene(&bytes) {
                        state_mut.insert_tile_scene(key, scene);
                    }
                }
            }
        }

        pump_vector_requests(state.clone());
    });
}

fn pump_vector_requests(state: Rc<RefCell<VectorEngineState>>) {
    loop {
        let next = {
            let mut state_mut = state.borrow_mut();

            if state_mut.in_flight_requests >= state_mut.max_in_flight_requests {
                None
            } else if let Some(key) = state_mut.dequeue_next_request() {
                state_mut.in_flight_requests += 1;
                let url = state_mut.tile_url(key);
                Some((key, url))
            } else {
                None
            }
        };

        let Some((key, url)) = next else {
            break;
        };

        request_vector_tile(state.clone(), key, url);
    }
}

fn make_gl_canvas_surface(
    canvas_or_offscreen: JsValue,
) -> Result<(CanvasSurface, WebGl2RenderingContext), JsValue> {
    if let Ok(canvas) = canvas_or_offscreen.clone().dyn_into::<HtmlCanvasElement>() {
        let ctx = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("WebGL2 context is not available"))?
            .dyn_into::<WebGl2RenderingContext>()?;
        return Ok((CanvasSurface::Html(canvas), ctx));
    }

    if let Ok(canvas) = canvas_or_offscreen.dyn_into::<OffscreenCanvas>() {
        let ctx = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("Offscreen WebGL2 context is not available"))?
            .dyn_into::<WebGl2RenderingContext>()?;
        return Ok((CanvasSurface::Offscreen(canvas), ctx));
    }

    Err(JsValue::from_str(
        "init_engine expected HTMLCanvasElement or OffscreenCanvas",
    ))
}

#[wasm_bindgen]
pub struct VectorMapEngine {
    state: Rc<RefCell<VectorEngineState>>,
}

#[wasm_bindgen]
pub fn init_vector_engine(
    canvas_or_offscreen: JsValue,
    config: JsValue,
) -> Result<VectorMapEngine, JsValue> {
    PANIC_HOOK.call_once(console_error_panic_hook::set_once);

    let config: InitConfig = if config.is_undefined() || config.is_null() {
        InitConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)?
    };

    let vector_source = config.vector_source;
    let tile_url_template = vector_source
        .as_ref()
        .and_then(|source| source.tile_url_template.clone())
        .or(config.tile_url_template)
        .unwrap_or_else(|| "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt".to_string());
    let min_zoom = config.min_zoom.unwrap_or(0);
    let max_zoom = config.max_zoom.unwrap_or(14).max(min_zoom);
    let tile_size = config.tile_size.unwrap_or(512).max(64);
    let cache_limit = config.cache_size.unwrap_or(1024).max(64);
    let source_max_zoom = vector_source
        .as_ref()
        .and_then(|source| source.source_max_zoom)
        .unwrap_or(max_zoom)
        .max(min_zoom);
    let backend_preference = vector_source
        .as_ref()
        .and_then(|source| source.backend_preference.as_deref())
        .unwrap_or("webgl2");
    let preferred_webgl_backend_kind =
        if backend_preference.eq_ignore_ascii_case("webgpu") && webgpu_supported() {
        VectorBackendKind::WebGpuFallbackWebGl2
    } else {
        VectorBackendKind::WebGl2
    };

    let (surface, gl, painter, ctx2d, backend_kind) = match make_gl_canvas_surface(canvas_or_offscreen.clone()) {
        Ok((surface, gl)) => {
            gl.disable(WebGl2RenderingContext::DEPTH_TEST);
            gl.disable(WebGl2RenderingContext::BLEND);
            let painter = create_simple_gl_painter(&gl).ok();
            (surface, Some(gl), painter, None, preferred_webgl_backend_kind)
        }
        Err(_) => {
            let (surface, ctx2d) = make_canvas_surface(canvas_or_offscreen)?;
            (surface, None, None, Some(ctx2d), VectorBackendKind::Canvas2d)
        }
    };

    let state = VectorEngineState {
        surface,
        gl,
        painter,
        ctx2d,
        width: 1024.0,
        height: 768.0,
        dpr: 1.0,
        tile_url_template,
        min_zoom,
        max_zoom,
        tile_size,
        zoom: 2.0_f64.clamp(f64::from(min_zoom), f64::from(max_zoom)),
        center_lon: 0.0,
        center_lat: 20.0,
        view_animation: None,
        last_frame_now_ms: 0.0,
        dragging: None,
        cache_tick: 0,
        cache_limit,
        tile_cache: HashMap::new(),
        pending_tiles: HashSet::new(),
        high_priority_queue: VecDeque::new(),
        medium_priority_queue: VecDeque::new(),
        low_priority_queue: VecDeque::new(),
        in_flight_requests: 0,
        max_in_flight_requests: MAX_IN_FLIGHT_REQUESTS,
        source_max_zoom,
        backend_kind,
        last_zoom_direction: 0,
    };

    Ok(VectorMapEngine {
        state: Rc::new(RefCell::new(state)),
    })
}

#[wasm_bindgen]
impl VectorMapEngine {
    pub fn resize(&mut self, width: u32, height: u32, dpr: f32) {
        self.state.borrow_mut().resize(width, height, dpr);
    }

    pub fn pointer_down(&mut self, x: f32, y: f32, button: u8) {
        if button != 0 {
            return;
        }

        let mut state = self.state.borrow_mut();
        state.cancel_view_animation();
        state.last_zoom_direction = 0;
        let render_zoom = state.zoom.round().clamp(f64::from(state.min_zoom), f64::from(state.max_zoom)) as u8;
        let (world_x, world_y) =
            lon_lat_to_world(state.center_lon, state.center_lat, render_zoom, state.tile_size);
        state.dragging = Some(DragState {
            start_x: f64::from(x),
            start_y: f64::from(y),
            start_world0_x: world_x,
            start_world0_y: world_y,
        });
    }

    pub fn pointer_move(&mut self, x: f32, y: f32) {
        let mut state = self.state.borrow_mut();
        let dragging = match state.dragging {
            Some(dragging) => dragging,
            None => return,
        };

        let render_zoom = state.zoom.round().clamp(f64::from(state.min_zoom), f64::from(state.max_zoom)) as u8;
        let dx = f64::from(x) - dragging.start_x;
        let dy = f64::from(y) - dragging.start_y;
        let display_scale = VectorEngineState::zoom_scale_for_delta(render_zoom, state.zoom);
        let new_world_x = dragging.start_world0_x - (dx / display_scale);
        let new_world_y = dragging.start_world0_y - (dy / display_scale);
        let (lon, lat) = world_to_lon_lat(new_world_x, new_world_y, render_zoom, state.tile_size);
        state.center_lon = normalize_lon(lon);
        state.center_lat = clamp_lat(lat);
    }

    pub fn pointer_up(&mut self, _x: f32, _y: f32) {
        self.state.borrow_mut().dragging = None;
    }

    pub fn wheel(&mut self, delta_y: f32, x: f32, y: f32, _ctrl_key: bool) {
        if delta_y.abs() < f32::EPSILON {
            return;
        }

        let mut state = self.state.borrow_mut();
        state.cancel_view_animation();
        let old_zoom = state.zoom;
        let zoom_delta = -f64::from(delta_y) * WHEEL_ZOOM_SENSITIVITY;
        let new_zoom = state.zoom_clamp_f64(old_zoom + zoom_delta);
        if (new_zoom - old_zoom).abs() < f64::EPSILON {
            return;
        }

        let old_render_zoom = old_zoom.round().clamp(f64::from(state.min_zoom), f64::from(state.max_zoom)) as u8;
        let new_render_zoom = new_zoom.round().clamp(f64::from(state.min_zoom), f64::from(state.max_zoom)) as u8;
        let cursor_x = f64::from(x);
        let cursor_y = f64::from(y);
        let (old_center_world_x, old_center_world_y) =
            lon_lat_to_world(state.center_lon, state.center_lat, old_render_zoom, state.tile_size);
        let old_display_scale = VectorEngineState::zoom_scale_for_delta(old_render_zoom, old_zoom);
        let focus_world_x = old_center_world_x + (cursor_x - state.width / 2.0) / old_display_scale;
        let focus_world_y = old_center_world_y + (cursor_y - state.height / 2.0) / old_display_scale;

        // Reproject focus point through lon/lat when rounded render zoom changes.
        let (focus_lon, focus_lat) =
            world_to_lon_lat(focus_world_x, focus_world_y, old_render_zoom, state.tile_size);
        let (focus_world_x_new, focus_world_y_new) =
            lon_lat_to_world(focus_lon, focus_lat, new_render_zoom, state.tile_size);
        let new_display_scale = VectorEngineState::zoom_scale_for_delta(new_render_zoom, new_zoom);
        let new_center_world_x = focus_world_x_new - (cursor_x - state.width / 2.0) / new_display_scale;
        let new_center_world_y = focus_world_y_new - (cursor_y - state.height / 2.0) / new_display_scale;
        let (center_lon, center_lat) =
            world_to_lon_lat(new_center_world_x, new_center_world_y, new_render_zoom, state.tile_size);

        state.zoom = new_zoom;
        state.center_lon = normalize_lon(center_lon);
        state.center_lat = clamp_lat(center_lat);
        state.last_zoom_direction = if new_zoom > old_zoom { 1 } else { -1 };
    }

    pub fn set_view(&mut self, lon: f64, lat: f64, zoom: f32) {
        let mut state = self.state.borrow_mut();
        state.last_zoom_direction = 0;
        state.set_view(lon, lat as f32, zoom);
    }

    pub fn zoom_to_box(&mut self, start_x: f32, start_y: f32, end_x: f32, end_y: f32) {
        let mut state = self.state.borrow_mut();
        state.last_zoom_direction = 0;
        state.zoom_to_box_screen_rect(
            f64::from(start_x),
            f64::from(start_y),
            f64::from(end_x),
            f64::from(end_y),
        );
    }

    pub fn place_marker(&mut self, _x: f32, _y: f32) {}

    pub fn add_marker_lon_lat(&mut self, _lon: f64, _lat: f64) {}

    pub fn remove_marker_lon_lat(&mut self, _lon: f64, _lat: f64) {}

    pub fn place_marker_with_info(&mut self, _x: f32, _y: f32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&Option::<PlacedMarker>::None).map_err(Into::into)
    }

    pub fn hit_test_marker(&self, _x: f32, _y: f32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&Option::<MarkerHover>::None).map_err(Into::into)
    }

    pub fn project_lon_lat(&self, lon: f64, lat: f64) -> Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let projected = state.project_lon_lat_to_screen(lon, lat);
        serde_wasm_bindgen::to_value(&projected).map_err(Into::into)
    }

    pub fn get_view(&self) -> Result<JsValue, JsValue> {
        let view = self.state.borrow().get_view_state();
        serde_wasm_bindgen::to_value(&view).map_err(Into::into)
    }

    pub fn get_engine_kind(&self) -> String {
        "vector".to_string()
    }

    pub fn get_render_backend(&self) -> String {
        self.state.borrow().backend_kind.as_str().to_string()
    }

    pub fn remove_recent_markers(&mut self, _count: u32) {}

    pub fn frame(&mut self, now_ms: f64) {
        self.state.borrow_mut().draw(now_ms);
        pump_vector_requests(self.state.clone());
    }

    pub fn load_trajectory_csv(&mut self, _bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        let result = CsvLoadResult {
            valid_rows: 0,
            invalid_rows: 0,
            bounds: None,
        };
        serde_wasm_bindgen::to_value(&result).map_err(Into::into)
    }

    pub fn load_marker_csv(&mut self, _bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        let result = CsvLoadResult {
            valid_rows: 0,
            invalid_rows: 0,
            bounds: None,
        };
        serde_wasm_bindgen::to_value(&result).map_err(Into::into)
    }

    pub fn clear_trajectory(&mut self) {}

    pub fn set_tile_url_template(&mut self, template: String) {
        self.state.borrow_mut().set_tile_url_template(template);
    }

    pub fn destroy(&mut self) {
        let mut state = self.state.borrow_mut();
        state.pending_tiles.clear();
        state.high_priority_queue.clear();
        state.medium_priority_queue.clear();
        state.low_priority_queue.clear();
        state.in_flight_requests = 0;
        state.tile_cache.clear();
        state.dragging = None;
    }
}

#[wasm_bindgen]
impl MapEngine {
    pub fn resize(&mut self, width: u32, height: u32, dpr: f32) {
        self.state.borrow_mut().resize(width, height, dpr);
    }

    pub fn pointer_down(&mut self, x: f32, y: f32, button: u8) {
        if button != 0 {
            return;
        }

        let mut state = self.state.borrow_mut();
        state.cancel_view_animation();
        let (world0_x, world0_y) =
            lon_lat_to_world(state.center_lon, state.center_lat, 0, state.tile_size);
        state.dragging = Some(DragState {
            start_x: f64::from(x),
            start_y: f64::from(y),
            start_world0_x: world0_x,
            start_world0_y: world0_y,
        });
    }

    pub fn pointer_move(&mut self, x: f32, y: f32) {
        let mut state = self.state.borrow_mut();
        let dragging = match state.dragging {
            Some(dragging) => dragging,
            None => return,
        };

        let dx = f64::from(x) - dragging.start_x;
        let dy = f64::from(y) - dragging.start_y;

        let display_scale = EngineState::zoom_scale(state.zoom);
        let new_world0_x = dragging.start_world0_x - (dx / display_scale);
        let new_world0_y = dragging.start_world0_y - (dy / display_scale);
        let (new_lon, new_lat) = world_to_lon_lat(new_world0_x, new_world0_y, 0, state.tile_size);

        state.center_lon = normalize_lon(new_lon);
        state.center_lat = clamp_lat(new_lat);
    }

    pub fn pointer_up(&mut self, _x: f32, _y: f32) {
        self.state.borrow_mut().dragging = None;
    }

    pub fn wheel(&mut self, delta_y: f32, x: f32, y: f32, _ctrl_key: bool) {
        if delta_y.abs() < f32::EPSILON {
            return;
        }

        let mut state = self.state.borrow_mut();
        state.cancel_view_animation();
        let old_zoom = state.zoom;
        let zoom_delta = -f64::from(delta_y) * WHEEL_ZOOM_SENSITIVITY;
        if zoom_delta.abs() < f64::EPSILON {
            return;
        }

        let new_zoom = state.zoom_clamp_f64(old_zoom + zoom_delta);
        if (new_zoom - old_zoom).abs() < f64::EPSILON {
            return;
        }

        let cursor_x = f64::from(x);
        let cursor_y = f64::from(y);
        let old_display_scale = EngineState::zoom_scale(old_zoom);
        let new_display_scale = EngineState::zoom_scale(new_zoom);

        let (center_world0_x, center_world0_y) =
            lon_lat_to_world(state.center_lon, state.center_lat, 0, state.tile_size);
        let focus_world0_x = center_world0_x + (cursor_x - state.width / 2.0) / old_display_scale;
        let focus_world0_y = center_world0_y + (cursor_y - state.height / 2.0) / old_display_scale;

        let new_center_world0_x =
            focus_world0_x - (cursor_x - state.width / 2.0) / new_display_scale;
        let new_center_world0_y =
            focus_world0_y - (cursor_y - state.height / 2.0) / new_display_scale;
        let (new_center_lon, new_center_lat) =
            world_to_lon_lat(new_center_world0_x, new_center_world0_y, 0, state.tile_size);

        state.zoom = new_zoom;
        state.center_lon = normalize_lon(new_center_lon);
        state.center_lat = clamp_lat(new_center_lat);
    }

    pub fn set_view(&mut self, lon: f64, lat: f64, zoom: f32) {
        self.state.borrow_mut().set_view(lon, lat, zoom);
    }

    pub fn zoom_to_box(&mut self, start_x: f32, start_y: f32, end_x: f32, end_y: f32) {
        self.state.borrow_mut().zoom_to_box(
            f64::from(start_x),
            f64::from(start_y),
            f64::from(end_x),
            f64::from(end_y),
        );
    }

    pub fn place_marker(&mut self, x: f32, y: f32) {
        let _ = self
            .state
            .borrow_mut()
            .place_marker_at_screen(f64::from(x), f64::from(y));
    }

    pub fn add_marker_lon_lat(&mut self, lon: f64, lat: f64) {
        self.state.borrow_mut().push_marker_lon_lat(lon, lat);
    }

    pub fn remove_marker_lon_lat(&mut self, lon: f64, lat: f64) {
        self.state.borrow_mut().remove_marker_lon_lat(lon, lat);
    }

    pub fn place_marker_with_info(&mut self, x: f32, y: f32) -> Result<JsValue, JsValue> {
        let placed_marker = self
            .state
            .borrow_mut()
            .place_marker_at_screen(f64::from(x), f64::from(y));
        serde_wasm_bindgen::to_value(&placed_marker).map_err(Into::into)
    }

    pub fn hit_test_marker(&self, x: f32, y: f32) -> Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let hover = state.hit_test_marker_at_screen(f64::from(x), f64::from(y));
        serde_wasm_bindgen::to_value(&hover).map_err(Into::into)
    }

    pub fn project_lon_lat(&self, lon: f64, lat: f64) -> Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let projected = state.project_lon_lat_to_screen(lon, lat);
        serde_wasm_bindgen::to_value(&projected).map_err(Into::into)
    }

    pub fn get_view(&self) -> Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let view = ViewState {
            lon: state.center_lon,
            lat: state.center_lat,
            zoom: state.zoom,
        };
        serde_wasm_bindgen::to_value(&view).map_err(Into::into)
    }

    pub fn get_engine_kind(&self) -> String {
        "raster".to_string()
    }

    pub fn get_render_backend(&self) -> String {
        "canvas2d".to_string()
    }

    pub fn remove_recent_markers(&mut self, count: u32) {
        self.state
            .borrow_mut()
            .remove_recent_markers(count as usize);
    }

    pub fn frame(&mut self, now_ms: f64) {
        {
            let mut state = self.state.borrow_mut();
            state.draw(now_ms);
        }

        pump_requests(self.state.clone());
    }

    pub fn load_trajectory_csv(&mut self, bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        let content =
            String::from_utf8(bytes).map_err(|_| JsValue::from_str("CSV must be valid UTF-8"))?;
        let parsed = parse_trajectory_csv(&content);

        let loaded_bounds = trajectory_bounds(&parsed.points);
        {
            let mut state = self.state.borrow_mut();
            if !parsed.points.is_empty() {
                state.trajectories.push(parsed.points);
            }
            if let Some(bounds) = state.trajectories_bounds() {
                state.fit_to_bounds(bounds);
            }
        }

        let result = CsvLoadResult {
            valid_rows: parsed.valid_rows,
            invalid_rows: parsed.invalid_rows,
            bounds: loaded_bounds,
        };

        serde_wasm_bindgen::to_value(&result).map_err(Into::into)
    }

    pub fn load_marker_csv(&mut self, bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        let content =
            String::from_utf8(bytes).map_err(|_| JsValue::from_str("CSV must be valid UTF-8"))?;
        let parsed = parse_marker_csv(&content);
        let valid_rows = parsed.valid_rows;
        let invalid_rows = parsed.invalid_rows;
        let loaded_bounds = parsed.bounds;
        let points = parsed.points;

        {
            let mut state = self.state.borrow_mut();
            if !points.is_empty() {
                state.append_marker_points(points);
            }
            if let Some(bounds) = state.location_markers_bounds() {
                state.fit_to_bounds(bounds);
            }
        }

        let result = CsvLoadResult {
            valid_rows,
            invalid_rows,
            bounds: loaded_bounds,
        };

        serde_wasm_bindgen::to_value(&result).map_err(Into::into)
    }

    pub fn clear_trajectory(&mut self) {
        self.state.borrow_mut().trajectories.clear();
    }

    pub fn set_tile_url_template(&mut self, template: String) {
        self.state.borrow_mut().set_tile_url_template(template);
    }

    pub fn destroy(&mut self) {
        let mut state = self.state.borrow_mut();
        state.pending_tiles.clear();
        state.high_priority_queue.clear();
        state.medium_priority_queue.clear();
        state.low_priority_queue.clear();
        state.in_flight_requests = 0;
        state.tile_cache.clear();
        state.top_void_color_rgb = None;
        state.bottom_void_color_rgb = None;
        state.view_animation = None;
        state.trajectories.clear();
        state.location_markers.clear();
        state.dragging = None;
    }
}
