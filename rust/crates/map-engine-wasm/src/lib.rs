use js_sys::Array;
use map_core::{
    clamp_lat, lon_lat_to_world, normalize_lon, parse_trajectory_csv, trajectory_bounds,
    world_to_lon_lat, Bounds, TrajectoryPoint,
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
    OffscreenCanvasRenderingContext2d,
};

static PANIC_HOOK: Once = Once::new();
const WHEEL_ZOOM_SENSITIVITY: f64 = 1.0 / 3000.0;
const TILE_PREFETCH_MARGIN: i32 = 1;
const TILE_DRAW_OVERLAP_PX: f64 = 1.0;
const MAX_IN_FLIGHT_REQUESTS: usize = 8;
const VOID_COLOR_BLEND_ALPHA: f64 = 0.25;

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
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = fetchTileBitmap)]
    async fn fetch_tile_bitmap(url: String) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = sampleTileEdgeColors)]
    fn sample_tile_edge_colors(bitmap: &ImageBitmap) -> Result<JsValue, JsValue>;
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitConfig {
    tile_url_template: Option<String>,
    min_zoom: Option<u8>,
    max_zoom: Option<u8>,
    tile_size: Option<u32>,
    cache_size: Option<usize>,
}

impl Default for InitConfig {
    fn default() -> Self {
        Self {
            tile_url_template: Some("https://tile.openstreetmap.org/{z}/{x}/{y}.png".to_string()),
            min_zoom: Some(0),
            max_zoom: Some(19),
            tile_size: Some(256),
            cache_size: Some(256),
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

#[derive(Serialize)]
struct CsvLoadResult {
    valid_rows: usize,
    invalid_rows: usize,
    bounds: Option<Bounds>,
}

enum CanvasSurface {
    Html(HtmlCanvasElement),
    Offscreen(OffscreenCanvas),
}

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
    dragging: Option<DragState>,
    cache_tick: u64,
    cache_limit: usize,
    tile_cache: HashMap<TileKey, CachedTile>,
    pending_tiles: HashSet<TileKey>,
    trajectories: Vec<Vec<TrajectoryPoint>>,
    high_priority_queue: VecDeque<TileKey>,
    medium_priority_queue: VecDeque<TileKey>,
    low_priority_queue: VecDeque<TileKey>,
    in_flight_requests: usize,
    max_in_flight_requests: usize,
    top_void_color_rgb: Option<[f64; 3]>,
    bottom_void_color_rgb: Option<[f64; 3]>,
}

impl EngineState {
    fn zoom_clamp_f64(&self, zoom: f64) -> f64 {
        zoom.clamp(f64::from(self.min_zoom), f64::from(self.max_zoom))
    }

    fn zoom_scale(zoom: f64) -> f64 {
        2_f64.powf(zoom)
    }

    fn center_world0(&self) -> (f64, f64) {
        lon_lat_to_world(self.center_lon, self.center_lat, 0, self.tile_size)
    }

    fn trajectories_bounds(&self) -> Option<Bounds> {
        let all_points: Vec<TrajectoryPoint> = self
            .trajectories
            .iter()
            .flat_map(|route| route.iter().cloned())
            .collect();
        trajectory_bounds(&all_points)
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
        if let Some(key) = self.high_priority_queue.pop_front() {
            return Some(key);
        }
        if let Some(key) = self.medium_priority_queue.pop_front() {
            return Some(key);
        }
        self.low_priority_queue.pop_front()
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
        self.center_lon = normalize_lon(lon);
        self.center_lat = clamp_lat(lat);
        self.zoom = self.zoom_clamp_f64(f64::from(zoom));
        self.render_zoom = self.zoom.round() as u8;
    }

    fn draw(&mut self) {
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

    fn fit_to_bounds(&mut self, bounds: Bounds) {
        let viewport_width = self.width.max(1.0);
        let viewport_height = self.height.max(1.0);
        let padding = 0.8;

        let center_lon = (bounds.min_lon + bounds.max_lon) / 2.0;
        let center_lat = (bounds.min_lat + bounds.max_lat) / 2.0;

        let (min_x_z0, min_y_z0) =
            lon_lat_to_world(bounds.min_lon, bounds.max_lat, 0, self.tile_size);
        let (max_x_z0, max_y_z0) =
            lon_lat_to_world(bounds.max_lon, bounds.min_lat, 0, self.tile_size);
        let width_z0 = (max_x_z0 - min_x_z0).abs().max(1e-9);
        let height_z0 = (max_y_z0 - min_y_z0).abs().max(1e-9);

        let mut best_zoom = self.min_zoom;
        for z in (self.min_zoom..=self.max_zoom).rev() {
            let scale = 2_f64.powi(i32::from(z));
            let bw = width_z0 * scale;
            let bh = height_z0 * scale;
            if bw <= viewport_width * padding && bh <= viewport_height * padding {
                best_zoom = z;
                break;
            }
        }

        self.center_lon = normalize_lon(center_lon);
        self.center_lat = clamp_lat(center_lat);
        self.zoom = f64::from(best_zoom);
        self.render_zoom = best_zoom;
    }

    fn tile_url(&self, key: TileKey) -> String {
        self.tile_url_template
            .replace("{z}", &key.z.to_string())
            .replace("{x}", &key.x.to_string())
            .replace("{y}", &key.y.to_string())
    }

    fn set_tile_url_template(&mut self, template: String) {
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
    let cache_limit = config.cache_size.unwrap_or(256).max(64);
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
        dragging: None,
        cache_tick: 0,
        cache_limit,
        tile_cache: HashMap::new(),
        pending_tiles: HashSet::new(),
        trajectories: Vec::new(),
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
            if is_current_source {
                if let Ok(bitmap) = result {
                    state_mut.insert_tile(key, bitmap, edge_sample);
                }
            } else if result.is_ok() {
                // Drop stale tile responses after style switches.
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

    pub fn frame(&mut self, _now_ms: f64) {
        {
            let mut state = self.state.borrow_mut();
            state.draw();
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
            if let Some(b) = state.trajectories_bounds() {
                state.fit_to_bounds(b);
            }
        }

        let result = CsvLoadResult {
            valid_rows: parsed.valid_rows,
            invalid_rows: parsed.invalid_rows,
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
        state.trajectories.clear();
        state.dragging = None;
    }
}
