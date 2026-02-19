"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { InitConfig, MarkerHover, WorkerInMessage, WorkerOutMessage } from "@/lib/map-protocol";

type MainThreadEngine = {
  resize(width: number, height: number, dpr: number): void;
  pointer_down(x: number, y: number, button: number): void;
  pointer_move(x: number, y: number): void;
  pointer_up(x: number, y: number): void;
  wheel(deltaY: number, x: number, y: number, ctrlKey: boolean): void;
  set_view(lon: number, lat: number, zoom: number): void;
  zoom_to_box(startX: number, startY: number, endX: number, endY: number): void;
  place_marker(x: number, y: number): void;
  hit_test_marker(x: number, y: number): MarkerHover | null;
  frame(nowMs: number): void;
  load_trajectory_csv(bytes: Uint8Array): unknown;
  clear_trajectory(): void;
  set_tile_url_template(template: string): void;
  destroy(): void;
};

type RuntimeMode = "none" | "worker" | "main";
export type RuntimeStatus = "loading" | "ready" | "error";
type PointerMessageType = "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP";

type UseMapEngineRuntimeOptions = {
  initialTileUrlTemplate: string;
  baseMapConfig: Omit<InitConfig, "tileUrlTemplate">;
};

export function useMapEngineRuntime({
  initialTileUrlTemplate,
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
  const tileUrlTemplateRef = useRef(initialTileUrlTemplate);
  const activeTileTemplateRef = useRef(initialTileUrlTemplate);
  const markerHoverRequestIdRef = useRef(0);

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
    async (options?: { forceFreshCanvas?: boolean }) => {
      const canvas = options?.forceFreshCanvas ? await resetCanvasElement() : canvasRef.current;
      if (!canvas) {
        throw new Error("Map canvas is not mounted.");
      }

      const initConfig: InitConfig = {
        ...baseMapConfig,
        tileUrlTemplate: tileUrlTemplateRef.current
      };
      const wasmModule = await import("@/wasm/pkg/map_engine_wasm.js");
      await wasmModule.default();
      const engine = wasmModule.init_engine(canvas, initConfig) as MainThreadEngine;
      const { width, height } = viewportSize();
      engine.resize(width, height, window.devicePixelRatio || 1);
      engine.set_view(0, 20, 2);

      mainEngineRef.current?.destroy();
      mainEngineRef.current = engine;

      runtimeModeRef.current = "main";
      setStatus("ready");
    },
    [baseMapConfig, resetCanvasElement, viewportSize]
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

      const offscreenCapable =
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
              config: {
                ...baseMapConfig,
                tileUrlTemplate: tileUrlTemplateRef.current
              }
            }
          };
          worker.postMessage(message, [offscreen]);

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
    };
  }, [
    baseMapConfig,
    fallbackToMainThread,
    handleWorkerMessage,
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

  const setTileUrlTemplate = useCallback(
    (tileUrlTemplate: string) => {
      tileUrlTemplateRef.current = tileUrlTemplate;

      if (!canInteract) return;
      if (tileUrlTemplate === activeTileTemplateRef.current) {
        return;
      }

      if (runtimeModeRef.current === "worker") {
        sendToWorker({
          type: "SET_TILE_URL_TEMPLATE",
          payload: { tileUrlTemplate }
        });
        activeTileTemplateRef.current = tileUrlTemplate;
        return;
      }

      mainEngineRef.current?.set_tile_url_template(tileUrlTemplate);
      activeTileTemplateRef.current = tileUrlTemplate;
    },
    [canInteract, sendToWorker]
  );

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
    hoverMarkerAtPoint,
    clearMarkerHover,
    loadTrajectoryCsv,
    setTileUrlTemplate
  };
}
