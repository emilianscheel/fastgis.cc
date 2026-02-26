"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EngineKind,
  InitConfig,
  MarkerHover,
  PlacedMarker,
  ProjectedPoint,
  RasterInitConfig,
  VectorBackendActual,
  VectorBackendPreference,
  VectorInitConfig,
  VectorSourceConfig,
  ViewState,
  WorkerInMessage,
  WorkerOutMessage
} from "@/lib/map-protocol";
import { resolveVectorTileJson } from "@/lib/vector-tilejson";

type MainThreadEngine = {
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
  load_trajectory_csv(bytes: Uint8Array): unknown;
  load_marker_csv(bytes: Uint8Array): unknown;
  clear_trajectory(): void;
  set_tile_url_template(template: string): void;
  destroy(): void;
};

type RuntimeMode = "none" | "worker" | "main";
export type RuntimeStatus = "loading" | "ready" | "error";
type PointerMessageType = "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP";

type BaseMapConfig = {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  cacheSize: number;
};

export type RasterBasemapStyleConfig = {
  id: string;
  engineKind: "raster";
  tileUrlTemplate: string;
};

export type VectorBasemapStyleConfig = {
  id: string;
  engineKind: "vector";
  vectorSource: {
    tileJsonUrl: string;
    stylePreset: "osm-vector-minimal";
    backendPreference: VectorBackendPreference;
  };
};

export type BasemapStyleConfig = RasterBasemapStyleConfig | VectorBasemapStyleConfig;

type ReadyDiagnostics = {
  engineKind: EngineKind;
  backend: VectorBackendActual | "canvas2d";
  mode: RuntimeMode | "none";
};

type UseMapEngineRuntimeOptions = {
  basemapStyle: BasemapStyleConfig;
  baseMapConfig: BaseMapConfig;
};

export function useMapEngineRuntime({
  basemapStyle,
  baseMapConfig
}: UseMapEngineRuntimeOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const mainEngineRef = useRef<MainThreadEngine | null>(null);
  const runtimeModeRef = useRef<RuntimeMode>("none");
  const rafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const desiredStyleRef = useRef<BasemapStyleConfig>(basemapStyle);
  const activeStyleRef = useRef<BasemapStyleConfig | null>(null);
  const desiredInitConfigRef = useRef<InitConfig>({
    ...baseMapConfig,
    engineKind: "raster",
    tileUrlTemplate:
      basemapStyle.engineKind === "raster"
        ? basemapStyle.tileUrlTemplate
        : "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
  });
  const activeInitConfigRef = useRef<InitConfig | null>(null);
  const markerHoverRequestIdRef = useRef(0);
  const markerPlacementRequestIdRef = useRef(0);
  const pendingMarkerPlacementsRef = useRef<Map<number, (marker: PlacedMarker | null) => void>>(
    new Map()
  );
  const projectionRequestIdRef = useRef(0);
  const pendingProjectionRequestsRef = useRef<Map<number, (point: ProjectedPoint | null) => void>>(
    new Map()
  );
  const viewRequestIdRef = useRef(0);
  const pendingViewRequestsRef = useRef<Map<number, (view: ViewState | null) => void>>(new Map());
  const lastKnownViewRef = useRef<ViewState>({ lon: 0, lat: 20, zoom: 2 });
  const readyDiagnosticsRef = useRef<ReadyDiagnostics>({
    engineKind: desiredInitConfigRef.current.engineKind,
    backend: "canvas2d",
    mode: "none"
  });

  const [status, setStatus] = useState<RuntimeStatus>("loading");
  const [canvasInstance, setCanvasInstance] = useState(0);
  const [markerHover, setMarkerHover] = useState<MarkerHover | null>(null);
  const canInteract = status === "ready";

  const viewportSize = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return { width: 1, height: 1 };
    }

    const rect = stage.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height))
    };
  }, []);

  const sendToWorker = useCallback((message: WorkerInMessage, transfer?: Transferable[]) => {
    if (!workerRef.current) return;
    workerRef.current.postMessage(message, transfer ?? []);
  }, []);

  const buildInitConfigForStyle = useCallback(
    async (style: BasemapStyleConfig): Promise<InitConfig> => {
      if (style.engineKind === "raster") {
        const rasterConfig: RasterInitConfig = {
          ...baseMapConfig,
          engineKind: "raster",
          tileUrlTemplate: style.tileUrlTemplate
        };
        return rasterConfig;
      }

      const tileJson = await resolveVectorTileJson(style.vectorSource.tileJsonUrl);
      const vectorSource: VectorSourceConfig = {
        tileJsonUrl: style.vectorSource.tileJsonUrl,
        tileUrlTemplate: tileJson.tileUrlTemplate,
        attribution: tileJson.attribution,
        sourceMaxZoom: tileJson.maxZoom,
        backendPreference: style.vectorSource.backendPreference,
        stylePreset: style.vectorSource.stylePreset,
        layerNames: tileJson.layerNames
      };
      const vectorConfig: VectorInitConfig = {
        ...baseMapConfig,
        engineKind: "vector",
        minZoom: Math.max(baseMapConfig.minZoom, tileJson.minZoom),
        maxZoom: Math.min(baseMapConfig.maxZoom, tileJson.maxZoom),
        vectorSource
      };
      return vectorConfig;
    },
    [baseMapConfig]
  );

  const requestWorkerViewState = useCallback((): Promise<ViewState | null> => {
    if (runtimeModeRef.current !== "worker" || !workerRef.current || !workerReadyRef.current) {
      return Promise.resolve(null);
    }

    const requestId = viewRequestIdRef.current + 1;
    viewRequestIdRef.current = requestId;

    return new Promise<ViewState | null>((resolve) => {
      pendingViewRequestsRef.current.set(requestId, resolve);
      sendToWorker({
        type: "GET_VIEW",
        payload: { requestId }
      });
    });
  }, [sendToWorker]);

  const getCurrentViewState = useCallback(async (): Promise<ViewState | null> => {
    if (runtimeModeRef.current === "worker") {
      const view = await requestWorkerViewState();
      if (view) {
        lastKnownViewRef.current = view;
      }
      return view;
    }

    if (runtimeModeRef.current === "main") {
      try {
        const view = mainEngineRef.current?.get_view() ?? null;
        if (view) {
          lastKnownViewRef.current = view;
        }
        return view;
      } catch (error) {
        console.error(error);
      }
    }

    return lastKnownViewRef.current ?? null;
  }, [requestWorkerViewState]);

  const sendPointerEvent = useCallback(
    (type: PointerMessageType, x: number, y: number, button?: number) => {
      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type,
          payload: { x, y, button }
        });
        return;
      }

      const engine = mainEngineRef.current;
      if (!engine) return;

      if (type === "POINTER_DOWN") engine.pointer_down(x, y, button ?? 0);
      if (type === "POINTER_MOVE") engine.pointer_move(x, y);
      if (type === "POINTER_UP") engine.pointer_up(x, y);
    },
    [sendToWorker]
  );

  const applyWheel = useCallback(
    (deltaY: number, x: number, y: number) => {
      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "WHEEL",
          payload: { deltaY, x, y, ctrlKey: false }
        });
        return;
      }

      mainEngineRef.current?.wheel(deltaY, x, y, false);
    },
    [sendToWorker]
  );

  const zoomToBox = useCallback(
    (startX: number, startY: number, endX: number, endY: number) => {
      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "ZOOM_TO_BOX",
          payload: {
            startX,
            startY,
            endX,
            endY
          }
        });
        return;
      }

      mainEngineRef.current?.zoom_to_box(startX, startY, endX, endY);
    },
    [sendToWorker]
  );

  const placeMarker = useCallback(
    (x: number, y: number) => {
      if (!canInteract) return;

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "PLACE_MARKER",
          payload: { x, y }
        });
        return;
      }

      mainEngineRef.current?.place_marker(x, y);
    },
    [canInteract, sendToWorker]
  );

  const placeMarkerWithInfo = useCallback(
    (x: number, y: number): Promise<PlacedMarker | null> => {
      if (!canInteract) {
        return Promise.resolve(null);
      }

      if (runtimeModeRef.current === "worker") {
        const requestId = markerPlacementRequestIdRef.current + 1;
        markerPlacementRequestIdRef.current = requestId;

        return new Promise<PlacedMarker | null>((resolve) => {
          pendingMarkerPlacementsRef.current.set(requestId, resolve);
          sendToWorker({
            type: "PLACE_MARKER_WITH_INFO",
            payload: {
              x,
              y,
              requestId
            }
          });
        });
      }

      try {
        const marker = mainEngineRef.current?.place_marker_with_info(x, y) ?? null;
        return Promise.resolve(marker);
      } catch (error) {
        console.error(error);
        return Promise.resolve(null);
      }
    },
    [canInteract, sendToWorker]
  );

  const addMarkerAtLonLat = useCallback(
    (lon: number, lat: number) => {
      if (!canInteract) {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "ADD_MARKER_LON_LAT",
          payload: {
            lon,
            lat
          }
        });
        return;
      }

      mainEngineRef.current?.add_marker_lon_lat(lon, lat);
    },
    [canInteract, sendToWorker]
  );

  const removeMarkerByLonLat = useCallback(
    (lon: number, lat: number) => {
      if (!canInteract) {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "REMOVE_MARKER_LON_LAT",
          payload: {
            lon,
            lat
          }
        });
        return;
      }

      mainEngineRef.current?.remove_marker_lon_lat(lon, lat);
    },
    [canInteract, sendToWorker]
  );

  const projectLonLat = useCallback(
    (lon: number, lat: number): Promise<ProjectedPoint | null> => {
      if (!canInteract) {
        return Promise.resolve(null);
      }

      if (runtimeModeRef.current === "worker") {
        const requestId = projectionRequestIdRef.current + 1;
        projectionRequestIdRef.current = requestId;

        return new Promise<ProjectedPoint | null>((resolve) => {
          pendingProjectionRequestsRef.current.set(requestId, resolve);
          sendToWorker({
            type: "PROJECT_LON_LAT",
            payload: {
              lon,
              lat,
              requestId
            }
          });
        });
      }

      try {
        const point = mainEngineRef.current?.project_lon_lat(lon, lat) ?? null;
        return Promise.resolve(point);
      } catch (error) {
        console.error(error);
        return Promise.resolve(null);
      }
    },
    [canInteract, sendToWorker]
  );

  const removeRecentMarkers = useCallback(
    (count: number) => {
      if (!canInteract) {
        return;
      }

      const safeCount = Math.max(0, Math.floor(count));
      if (safeCount === 0) {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "REMOVE_RECENT_MARKERS",
          payload: {
            count: safeCount
          }
        });
        return;
      }

      mainEngineRef.current?.remove_recent_markers(safeCount);
    },
    [canInteract, sendToWorker]
  );

  const hoverMarkerAtPoint = useCallback(
    (x: number, y: number) => {
      if (!canInteract) {
        setMarkerHover(null);
        return;
      }

      const nextRequestId = markerHoverRequestIdRef.current + 1;
      markerHoverRequestIdRef.current = nextRequestId;

      if (runtimeModeRef.current === "worker") {
        if (!workerReadyRef.current) {
          setMarkerHover(null);
          return;
        }

        sendToWorker({
          type: "HOVER_MARKER",
          payload: {
            x,
            y,
            requestId: nextRequestId
          }
        });
        return;
      }

      try {
        const marker = mainEngineRef.current?.hit_test_marker(x, y) ?? null;
        setMarkerHover(marker);
      } catch (error) {
        setMarkerHover(null);
        console.error(error);
      }
    },
    [canInteract, sendToWorker]
  );

  const clearMarkerHover = useCallback(() => {
    markerHoverRequestIdRef.current += 1;
    setMarkerHover(null);
  }, []);

  const resizeEngine = useCallback(() => {
    const { width, height } = viewportSize();
    const dpr = window.devicePixelRatio || 1;

    if (runtimeModeRef.current === "worker") {
      sendToWorker({
        type: "RESIZE",
        payload: { width, height, dpr }
      });
      return;
    }

    mainEngineRef.current?.resize(width, height, dpr);
  }, [sendToWorker, viewportSize]);

  const startFrameLoop = useCallback(() => {
    const frame = (nowMs: number) => {
      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "FRAME_TICK",
          payload: { nowMs }
        });
      } else if (runtimeModeRef.current === "main") {
        mainEngineRef.current?.frame(nowMs);
      }

      rafRef.current = window.requestAnimationFrame(frame);
    };

    rafRef.current = window.requestAnimationFrame(frame);
  }, [sendToWorker]);

  const stopFrameLoop = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const teardownWorker = useCallback(() => {
    workerReadyRef.current = false;
    workerRef.current?.terminate();
    workerRef.current = null;
    for (const resolve of pendingMarkerPlacementsRef.current.values()) {
      resolve(null);
    }
    pendingMarkerPlacementsRef.current.clear();
    for (const resolve of pendingProjectionRequestsRef.current.values()) {
      resolve(null);
    }
    pendingProjectionRequestsRef.current.clear();
    for (const resolve of pendingViewRequestsRef.current.values()) {
      resolve(null);
    }
    pendingViewRequestsRef.current.clear();
  }, []);

  const resetCanvasElement = useCallback(async () => {
    setCanvasInstance((prev) => prev + 1);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    const canvas = canvasRef.current;
    if (!canvas) {
      throw new Error("Map canvas remount failed.");
    }
    return canvas;
  }, []);

  const initMainThreadEngine = useCallback(
    async (options?: { forceFreshCanvas?: boolean; restoreView?: ViewState | null }) => {
      const canvas = options?.forceFreshCanvas ? await resetCanvasElement() : canvasRef.current;
      if (!canvas) {
        throw new Error("Map canvas is not mounted.");
      }

      const initConfig = desiredInitConfigRef.current;
      const wasmModule = (await import("@/wasm/pkg/map_engine_wasm.js")) as unknown as {
        default: () => Promise<unknown>;
        init_engine: (canvas: HTMLCanvasElement, config: InitConfig) => MainThreadEngine;
        init_vector_engine?: (canvas: HTMLCanvasElement, config: InitConfig) => MainThreadEngine;
      };
      await wasmModule.default();
      const engine =
        initConfig.engineKind === "vector" && typeof wasmModule.init_vector_engine === "function"
          ? wasmModule.init_vector_engine(canvas, initConfig)
          : wasmModule.init_engine(canvas, initConfig);
      const { width, height } = viewportSize();
      engine.resize(width, height, window.devicePixelRatio || 1);
      const view = options?.restoreView ?? lastKnownViewRef.current;
      engine.set_view(view?.lon ?? 0, view?.lat ?? 20, view?.zoom ?? 2);

      mainEngineRef.current?.destroy();
      mainEngineRef.current = engine;
      activeInitConfigRef.current = initConfig;
      activeStyleRef.current = desiredStyleRef.current;
      readyDiagnosticsRef.current = {
        engineKind: initConfig.engineKind,
        backend: initConfig.engineKind === "vector" ? "webgl2" : "canvas2d",
        mode: "main"
      };

      runtimeModeRef.current = "main";
      setStatus("ready");
    },
    [resetCanvasElement, viewportSize]
  );

  const fallbackToMainThread = useCallback(
    async (reason: string) => {
      const requiresFreshCanvas = runtimeModeRef.current === "worker";
      teardownWorker();
      runtimeModeRef.current = "none";
      setStatus("loading");
      console.error(reason);

      try {
        await initMainThreadEngine({ forceFreshCanvas: requiresFreshCanvas });
      } catch (error) {
        setStatus("error");
        console.error(error);
      }
    },
    [initMainThreadEngine, teardownWorker]
  );

  const handleWorkerMessage = useCallback(
    (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (!message) return;

      if (message.type === "STATUS") {
        setStatus(message.payload.phase);
        return;
      }

      if (message.type === "READY") {
        workerReadyRef.current = true;
        activeInitConfigRef.current = desiredInitConfigRef.current;
        activeStyleRef.current = desiredStyleRef.current;
        readyDiagnosticsRef.current = {
          engineKind: message.payload.engineKind,
          backend: message.payload.backend,
          mode: "worker"
        };
        setStatus("ready");
        return;
      }

      if (message.type === "ERROR") {
        const duringInit = runtimeModeRef.current === "worker" && !workerReadyRef.current;
        if (duringInit) {
          void fallbackToMainThread(
            `Worker renderer failed (${message.payload.message}). Switched to main-thread fallback.`
          );
          return;
        }

        setStatus("error");
        console.error(message.payload.message);
        return;
      }

      if (message.type === "MARKER_HOVER") {
        if (message.payload.requestId !== markerHoverRequestIdRef.current) {
          return;
        }

        setMarkerHover(message.payload.marker);
        return;
      }

      if (message.type === "MARKER_PLACED") {
        const resolve = pendingMarkerPlacementsRef.current.get(message.payload.requestId);
        if (!resolve) {
          return;
        }

        pendingMarkerPlacementsRef.current.delete(message.payload.requestId);
        resolve(message.payload.marker);
        return;
      }

      if (message.type === "LON_LAT_PROJECTED") {
        const resolve = pendingProjectionRequestsRef.current.get(message.payload.requestId);
        if (!resolve) {
          return;
        }

        pendingProjectionRequestsRef.current.delete(message.payload.requestId);
        resolve(message.payload.point);
        return;
      }

      if (message.type === "VIEW_STATE") {
        const resolve = pendingViewRequestsRef.current.get(message.payload.requestId);
        if (!resolve) {
          return;
        }

        pendingViewRequestsRef.current.delete(message.payload.requestId);
        if (message.payload.view) {
          lastKnownViewRef.current = message.payload.view;
        }
        resolve(message.payload.view);
      }
    },
    [fallbackToMainThread]
  );

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      setStatus("loading");
      workerReadyRef.current = false;
      desiredStyleRef.current = basemapStyle;
      desiredInitConfigRef.current = await buildInitConfigForStyle(basemapStyle);
      readyDiagnosticsRef.current = {
        engineKind: desiredInitConfigRef.current.engineKind,
        backend: desiredInitConfigRef.current.engineKind === "vector" ? "webgl2" : "canvas2d",
        mode: "none"
      };
      // Turbopack dev can serve a stale/incompatible worker-side wasm glue module when the wasm
      // import surface changes (e.g. after adding WebGL bindings for the vector engine), which
      // causes instantiate-time import errors. Keep dev on main-thread runtime; production can
      // still use the worker path for raster.
      const preferWorkerForStyle =
        process.env.NODE_ENV === "production" && desiredInitConfigRef.current.engineKind === "raster";

      const offscreenCapable =
        preferWorkerForStyle &&
        typeof Worker !== "undefined" &&
        typeof (canvas as HTMLCanvasElement & { transferControlToOffscreen?: () => OffscreenCanvas })
          .transferControlToOffscreen === "function";

      if (offscreenCapable) {
        try {
          const worker = new Worker(new URL("../workers/map.worker.ts", import.meta.url), {
            type: "module"
          });
          workerRef.current = worker;
          worker.onmessage = handleWorkerMessage;
          worker.onerror = () => {
            if (cancelled) return;
            void fallbackToMainThread("Worker crashed during initialization. Switched to main-thread fallback.");
          };

          const offscreen = (
            canvas as HTMLCanvasElement & { transferControlToOffscreen: () => OffscreenCanvas }
          ).transferControlToOffscreen();
          const { width, height } = viewportSize();
          const message: WorkerInMessage = {
            type: "INIT",
            payload: {
              canvas: offscreen,
              width,
              height,
              dpr: window.devicePixelRatio || 1,
              origin: window.location.origin,
              config: desiredInitConfigRef.current
            }
          };
          worker.postMessage(message, [offscreen]);
          worker.postMessage({
            type: "SET_VIEW",
            payload: lastKnownViewRef.current
          } satisfies WorkerInMessage);

          runtimeModeRef.current = "worker";
        } catch {
          if (!cancelled) {
            await initMainThreadEngine({ forceFreshCanvas: true });
          }
        }
      } else {
        await initMainThreadEngine();
      }

      if (!cancelled) {
        startFrameLoop();
      }
    };

    void init().catch((error) => {
      if (cancelled) return;
      setStatus("error");
      console.error(error);
    });

    if (stageRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => resizeEngine());
      resizeObserverRef.current.observe(stageRef.current);
    }
    window.addEventListener("resize", resizeEngine);

    return () => {
      cancelled = true;
      stopFrameLoop();
      window.removeEventListener("resize", resizeEngine);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      teardownWorker();
      mainEngineRef.current?.destroy();
      mainEngineRef.current = null;
      runtimeModeRef.current = "none";
      setMarkerHover(null);
      for (const resolve of pendingMarkerPlacementsRef.current.values()) {
        resolve(null);
      }
      pendingMarkerPlacementsRef.current.clear();
      for (const resolve of pendingProjectionRequestsRef.current.values()) {
        resolve(null);
      }
      pendingProjectionRequestsRef.current.clear();
      for (const resolve of pendingViewRequestsRef.current.values()) {
        resolve(null);
      }
      pendingViewRequestsRef.current.clear();
    };
  }, [
    buildInitConfigForStyle,
    fallbackToMainThread,
    handleWorkerMessage,
    basemapStyle,
    initMainThreadEngine,
    resizeEngine,
    startFrameLoop,
    stopFrameLoop,
    teardownWorker,
    viewportSize
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      applyWheel(event.deltaY, x, y);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [applyWheel, canvasInstance]);

  const loadTrajectoryCsv = useCallback(
    (fileName: string, bytes: Uint8Array) => {
      if (!canInteract) return;
      if ((activeInitConfigRef.current ?? desiredInitConfigRef.current).engineKind === "vector") {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        if (!workerReadyRef.current) return;

        sendToWorker(
          {
            type: "LOAD_TRAJECTORY_CSV",
            payload: { name: fileName, bytes }
          },
          [bytes.buffer as ArrayBuffer]
        );
        return;
      }

      try {
        mainEngineRef.current?.load_trajectory_csv(bytes);
      } catch (error) {
        setStatus("error");
        console.error(error);
      }
    },
    [canInteract, sendToWorker]
  );

  const loadMarkerCsv = useCallback(
    (fileName: string, bytes: Uint8Array) => {
      if (!canInteract) return;
      if ((activeInitConfigRef.current ?? desiredInitConfigRef.current).engineKind === "vector") {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        if (!workerReadyRef.current) return;

        sendToWorker(
          {
            type: "LOAD_MARKER_CSV",
            payload: { name: fileName, bytes }
          },
          [bytes.buffer as ArrayBuffer]
        );
        return;
      }

      try {
        mainEngineRef.current?.load_marker_csv(bytes);
      } catch (error) {
        setStatus("error");
        console.error(error);
      }
    },
    [canInteract, sendToWorker]
  );

  const setTileUrlTemplate = useCallback(
    (tileUrlTemplate: string) => {
      const desiredConfig = desiredInitConfigRef.current;
      if (desiredConfig.engineKind !== "raster") {
        return;
      }

      desiredInitConfigRef.current = { ...desiredConfig, tileUrlTemplate };

      const activeConfig = activeInitConfigRef.current;
      if (!canInteract || !activeConfig || activeConfig.engineKind !== "raster") {
        return;
      }
      if (tileUrlTemplate === activeConfig.tileUrlTemplate) {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "SET_TILE_URL_TEMPLATE",
          payload: { tileUrlTemplate }
        });
        activeInitConfigRef.current = { ...activeConfig, tileUrlTemplate };
        return;
      }

      mainEngineRef.current?.set_tile_url_template(tileUrlTemplate);
      activeInitConfigRef.current = { ...activeConfig, tileUrlTemplate };
    },
    [canInteract, sendToWorker]
  );

  const getViewState = useCallback(() => getCurrentViewState(), [getCurrentViewState]);

  return {
    canvasRef,
    stageRef,
    canvasInstance,
    status,
    canInteract,
    markerHover,
    viewportSize,
    sendPointerEvent,
    applyWheel,
    zoomToBox,
    placeMarker,
    placeMarkerWithInfo,
    addMarkerAtLonLat,
    removeMarkerByLonLat,
    projectLonLat,
    removeRecentMarkers,
    hoverMarkerAtPoint,
    clearMarkerHover,
    loadTrajectoryCsv,
    loadMarkerCsv,
    setTileUrlTemplate,
    getViewState,
    activeEngineKind: activeInitConfigRef.current?.engineKind ?? desiredInitConfigRef.current.engineKind,
    readyDiagnostics: readyDiagnosticsRef.current
  };
}
