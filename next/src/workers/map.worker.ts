/// <reference lib="webworker" />

import type { CsvLoadResult, WorkerInMessage, WorkerOutMessage } from "../lib/map-protocol";

type WasmMapEngine = {
  resize(width: number, height: number, dpr: number): void;
  pointer_down(x: number, y: number, button: number): void;
  pointer_move(x: number, y: number): void;
  pointer_up(x: number, y: number): void;
  wheel(deltaY: number, x: number, y: number, ctrlKey: boolean): void;
  set_view(lon: number, lat: number, zoom: number): void;
  frame(nowMs: number): void;
  load_trajectory_csv(bytes: Uint8Array): CsvLoadResult;
  clear_trajectory(): void;
  set_tile_url_template(template: string): void;
  destroy(): void;
};

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init_engine(canvasOrOffscreen: OffscreenCanvas, config: unknown): WasmMapEngine;
};

const workerContext = self as unknown as DedicatedWorkerGlobalScope;
const wasmBinaryUrl = new URL("../wasm/pkg/map_engine_wasm_bg.wasm", import.meta.url);

let wasmModulePromise: Promise<WasmModule> | null = null;
let engine: WasmMapEngine | null = null;
let appOrigin: string | null = null;

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
    postMessageToMain({ type: "STATUS", payload: { phase: "loading" } });
    const module = await loadWasmModule();
    engine = module.init_engine(message.payload.canvas, message.payload.config);
    engine.resize(message.payload.width, message.payload.height, message.payload.dpr);
    engine.set_view(0, 20, 2);
    postMessageToMain({ type: "READY", payload: { mode: "worker" } });
    return;
  }

  if (!engine) {
    if (message.type === "LOAD_TRAJECTORY_CSV") {
      postMessageToMain({
        type: "ERROR",
        payload: {
          code: "ENGINE_NOT_READY",
          message: "Renderer engine is not initialized yet."
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
    engine.set_view(message.payload.lon, message.payload.lat, message.payload.zoom);
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
