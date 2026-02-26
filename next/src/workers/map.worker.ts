/// <reference lib="webworker" />

import type {
  CsvLoadResult,
  EngineKind,
  MarkerHover,
  PlacedMarker,
  ProjectedPoint,
  ViewState,
  WorkerInMessage,
  WorkerOutMessage
} from "../lib/map-protocol";

type WasmMapEngine = {
  resize(width: number, height: number, dpr: number): void;
  pointer_down(x: number, y: number, button: number): void;
  pointer_move(x: number, y: number): void;
  pointer_up(x: number, y: number): void;
  wheel(deltaY: number, x: number, y: number, ctrlKey: boolean): void;
  set_view(lon: number, lat: number, zoom: number): void;
  zoom_to_box(startX: number, startY: number, endX: number, endY: number): void;
  place_marker(x: number, y: number): void;
  place_marker_with_info(x: number, y: number): PlacedMarker | null;
  add_marker_lon_lat(lon: number, lat: number): void;
  remove_marker_lon_lat(lon: number, lat: number): void;
  hit_test_marker(x: number, y: number): MarkerHover | null;
  project_lon_lat(lon: number, lat: number): ProjectedPoint | null;
  get_view(): ViewState | null;
  remove_recent_markers(count: number): void;
  frame(nowMs: number): void;
  load_trajectory_csv(bytes: Uint8Array): CsvLoadResult;
  load_marker_csv(bytes: Uint8Array): CsvLoadResult;
  clear_trajectory(): void;
  set_tile_url_template(template: string): void;
  get_engine_kind?(): EngineKind;
  get_render_backend?(): "webgl2" | "webgpu" | "webgpu-fallback-webgl2" | "canvas2d";
  destroy(): void;
};

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init_engine(canvasOrOffscreen: OffscreenCanvas, config: unknown): WasmMapEngine;
  init_vector_engine?: (canvasOrOffscreen: OffscreenCanvas, config: unknown) => WasmMapEngine;
};

const workerContext = self as unknown as DedicatedWorkerGlobalScope;
const wasmBinaryUrl = new URL("../wasm/pkg/map_engine_wasm_bg.wasm", import.meta.url);

let wasmModulePromise: Promise<WasmModule> | null = null;
let engine: WasmMapEngine | null = null;
let appOrigin: string | null = null;
let activeEngineKind: EngineKind = "raster";

function postMessageToMain(message: WorkerOutMessage): void {
  workerContext.postMessage(message);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }

  if (typeof error === "string") return error;

  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

async function loadWasmModule(): Promise<WasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = import("../wasm/pkg/map_engine_wasm.js").then(async (module) => {
      const wasmPath = typeof wasmBinaryUrl === "string" ? wasmBinaryUrl : wasmBinaryUrl.toString();

      if (/^https?:\/\//i.test(wasmPath)) {
        await module.default(wasmPath);
      } else if (wasmPath.startsWith("/")) {
        const origin = appOrigin ?? workerContext.location.origin;
        if (origin && origin !== "null") {
          await module.default(new URL(wasmPath, origin).toString());
        } else {
          await module.default(wasmPath);
        }
      } else {
        await module.default(wasmPath);
      }

      return module as unknown as WasmModule;
    });
  }
  return wasmModulePromise;
}

async function handleMessage(message: WorkerInMessage): Promise<void> {
  if (message.type === "INIT") {
    appOrigin = message.payload.origin;
    activeEngineKind = message.payload.config.engineKind;
    postMessageToMain({ type: "STATUS", payload: { phase: "loading" } });
    const module = await loadWasmModule();
    engine =
      message.payload.config.engineKind === "vector" && typeof module.init_vector_engine === "function"
        ? module.init_vector_engine(message.payload.canvas, message.payload.config)
        : module.init_engine(message.payload.canvas, message.payload.config);
    engine.resize(message.payload.width, message.payload.height, message.payload.dpr);
    engine.set_view(0, 20, 2);
    const reportedEngineKind = engine.get_engine_kind?.() ?? activeEngineKind;
    const backend = engine.get_render_backend?.() ?? (reportedEngineKind === "vector" ? "webgl2" : "canvas2d");
    postMessageToMain({
      type: "READY",
      payload: { mode: "worker", engineKind: reportedEngineKind, backend }
    });
    return;
  }

  if (!engine) {
    if (message.type === "PLACE_MARKER_WITH_INFO") {
      postMessageToMain({
        type: "MARKER_PLACED",
        payload: {
          marker: null,
          requestId: message.payload.requestId
        }
      });
      return;
    }

    if (message.type === "LOAD_TRAJECTORY_CSV" || message.type === "LOAD_MARKER_CSV") {
      postMessageToMain({
        type: "ERROR",
        payload: {
          code: "ENGINE_NOT_READY",
          message: "Renderer engine is not initialized yet."
        }
      });
    }

    if (message.type === "PROJECT_LON_LAT") {
      postMessageToMain({
        type: "LON_LAT_PROJECTED",
        payload: {
          point: null,
          requestId: message.payload.requestId
        }
      });
    }
    if (message.type === "GET_VIEW") {
      postMessageToMain({
        type: "VIEW_STATE",
        payload: {
          requestId: message.payload.requestId,
          view: null
        }
      });
    }
    return;
  }

  if (message.type === "RESIZE") {
    engine.resize(message.payload.width, message.payload.height, message.payload.dpr);
    return;
  }

  if (message.type === "POINTER_DOWN") {
    engine.pointer_down(message.payload.x, message.payload.y, message.payload.button ?? 0);
    return;
  }

  if (message.type === "POINTER_MOVE") {
    engine.pointer_move(message.payload.x, message.payload.y);
    return;
  }

  if (message.type === "POINTER_UP") {
    engine.pointer_up(message.payload.x, message.payload.y);
    return;
  }

  if (message.type === "WHEEL") {
    engine.wheel(message.payload.deltaY, message.payload.x, message.payload.y, message.payload.ctrlKey);
    return;
  }

  if (message.type === "SET_VIEW") {
    // Track view on the engine side; UI can request it back before engine restarts.
    engine.set_view(message.payload.lon, message.payload.lat, message.payload.zoom);
    return;
  }

  if (message.type === "GET_VIEW") {
    const view = engine.get_view?.() ?? null;
    postMessageToMain({
      type: "VIEW_STATE",
      payload: {
        requestId: message.payload.requestId,
        view
      }
    });
    return;
  }

  if (message.type === "ZOOM_TO_BOX") {
    engine.zoom_to_box(
      message.payload.startX,
      message.payload.startY,
      message.payload.endX,
      message.payload.endY
    );
    return;
  }

  if (message.type === "PLACE_MARKER") {
    engine.place_marker(message.payload.x, message.payload.y);
    return;
  }

  if (message.type === "ADD_MARKER_LON_LAT") {
    engine.add_marker_lon_lat(message.payload.lon, message.payload.lat);
    return;
  }

  if (message.type === "REMOVE_MARKER_LON_LAT") {
    engine.remove_marker_lon_lat(message.payload.lon, message.payload.lat);
    return;
  }

  if (message.type === "PLACE_MARKER_WITH_INFO") {
    const marker = engine.place_marker_with_info(message.payload.x, message.payload.y) ?? null;
    postMessageToMain({
      type: "MARKER_PLACED",
      payload: {
        marker,
        requestId: message.payload.requestId
      }
    });
    return;
  }

  if (message.type === "HOVER_MARKER") {
    const marker = engine.hit_test_marker(message.payload.x, message.payload.y) ?? null;
    postMessageToMain({
      type: "MARKER_HOVER",
      payload: {
        marker,
        requestId: message.payload.requestId
      }
    });
    return;
  }

  if (message.type === "PROJECT_LON_LAT") {
    const point = engine.project_lon_lat(message.payload.lon, message.payload.lat) ?? null;
    postMessageToMain({
      type: "LON_LAT_PROJECTED",
      payload: {
        point,
        requestId: message.payload.requestId
      }
    });
    return;
  }

  if (message.type === "REMOVE_RECENT_MARKERS") {
    engine.remove_recent_markers(message.payload.count);
    return;
  }

  if (message.type === "FRAME_TICK") {
    engine.frame(message.payload.nowMs);
    return;
  }

  if (message.type === "LOAD_TRAJECTORY_CSV") {
    const result = engine.load_trajectory_csv(message.payload.bytes);
    postMessageToMain({
      type: "CSV_LOADED",
      payload: result
    });
    return;
  }

  if (message.type === "LOAD_MARKER_CSV") {
    const result = engine.load_marker_csv(message.payload.bytes);
    postMessageToMain({
      type: "CSV_LOADED",
      payload: result
    });
    return;
  }

  if (message.type === "CLEAR_TRAJECTORY") {
    engine.clear_trajectory();
    return;
  }

  if (message.type === "SET_TILE_URL_TEMPLATE") {
    engine.set_tile_url_template(message.payload.tileUrlTemplate);
  }
}

workerContext.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  void handleMessage(event.data).catch((error) => {
    postMessageToMain({
      type: "ERROR",
      payload: {
        code: "WORKER_RUNTIME_ERROR",
        message: normalizeError(error)
      }
    });
  });
};
