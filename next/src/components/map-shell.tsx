"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { CsvDropOverlay } from "@/components/csv-drop-overlay";
import {
  Menubar,
  MenubarContent,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarTrigger
} from "@/components/ui/menubar";
import { Button } from "@/components/ui/button";
import { useZoomShortcuts } from "@/hooks/use-zoom-shortcuts";
import type { InitConfig, WorkerInMessage, WorkerOutMessage } from "@/lib/map-protocol";

type MainThreadEngine = {
  resize(width: number, height: number, dpr: number): void;
  pointer_down(x: number, y: number, button: number): void;
  pointer_move(x: number, y: number): void;
  pointer_up(x: number, y: number): void;
  wheel(deltaY: number, x: number, y: number, ctrlKey: boolean): void;
  set_view(lon: number, lat: number, zoom: number): void;
  frame(nowMs: number): void;
  load_trajectory_csv(bytes: Uint8Array): unknown;
  clear_trajectory(): void;
  set_tile_url_template(template: string): void;
  destroy(): void;
};

type RuntimeMode = "none" | "worker" | "main";
type Status = "loading" | "ready" | "error";

type MapStyle = {
  id: string;
  label: string;
  tileUrlTemplate: string;
};

const MAP_STYLES: MapStyle[] = [
  {
    id: "osm-standard",
    label: "OSM Standard",
    tileUrlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
  },
  {
    id: "carto-light",
    label: "Carto Light",
    tileUrlTemplate: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
  },
  {
    id: "carto-dark",
    label: "Carto Dark",
    tileUrlTemplate: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
  }
];

const BASE_MAP_CONFIG: Omit<InitConfig, "tileUrlTemplate"> = {
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  cacheSize: 256
};

export function MapShell() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const mainEngineRef = useRef<MainThreadEngine | null>(null);
  const runtimeModeRef = useRef<RuntimeMode>("none");
  const rafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [canvasInstance, setCanvasInstance] = useState(0);
  const [mapStyleId, setMapStyleId] = useState<MapStyle["id"]>("osm-standard");
  const tileUrlTemplateRef = useRef(MAP_STYLES[0].tileUrlTemplate);

  const canInteract = status === "ready";
  const selectedMapStyle = useMemo(
    () => MAP_STYLES.find((style) => style.id === mapStyleId) ?? MAP_STYLES[0],
    [mapStyleId]
  );
  useEffect(() => {
    tileUrlTemplateRef.current = selectedMapStyle.tileUrlTemplate;
  }, [selectedMapStyle]);

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
    (type: "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP", x: number, y: number, button?: number) => {
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
        ...BASE_MAP_CONFIG,
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
        typeof (canvas as HTMLCanvasElement & { transferControlToOffscreen?: () => OffscreenCanvas }).transferControlToOffscreen === "function";

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
                ...BASE_MAP_CONFIG,
                tileUrlTemplate: tileUrlTemplateRef.current
              }
            }
          };
          worker.postMessage(message, [offscreen]);

          runtimeModeRef.current = "worker";
        } catch {
          if (!cancelled) {
            // Offscreen transfer may already have happened; remount a fresh canvas for fallback init.
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
    };
  }, [
    fallbackToMainThread,
    handleWorkerMessage,
    initMainThreadEngine,
    resizeEngine,
    startFrameLoop,
    stopFrameLoop,
    teardownWorker,
    viewportSize
  ]);

  const withCanvasPoint = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    },
    []
  );

  const handleCsvBytes = useCallback(
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

  const handleFile = useCallback(
    async (file: File) => {
      if (!canInteract) return;
      if (!file.name.toLowerCase().endsWith(".csv")) return;

      const bytes = new Uint8Array(await file.arrayBuffer());
      handleCsvBytes(file.name, bytes);
    },
    [canInteract, handleCsvBytes]
  );

  const handleDroppedFiles = useCallback(
    async (files: File[]) => {
      if (!canInteract) return;
      for (const file of files) {
        await handleFile(file);
      }
    },
    [canInteract, handleFile]
  );

  const stepZoom = useCallback(
    (direction: "in" | "out") => {
      if (!canInteract) return;
      const { width, height } = viewportSize();
      const deltaY = direction === "in" ? -1200 : 1200;
      applyWheel(deltaY, width / 2, height / 2);
    },
    [applyWheel, canInteract, viewportSize]
  );

  const handleZoomIn = useCallback(() => {
    stepZoom("in");
  }, [stepZoom]);

  const handleZoomOut = useCallback(() => {
    stepZoom("out");
  }, [stepZoom]);

  useZoomShortcuts({
    enabled: canInteract,
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut
  });

  useEffect(() => {
    if (!canInteract) return;

    const tileUrlTemplate = selectedMapStyle.tileUrlTemplate;
    if (runtimeModeRef.current === "worker") {
      sendToWorker({
        type: "SET_TILE_URL_TEMPLATE",
        payload: { tileUrlTemplate }
      });
      return;
    }

    mainEngineRef.current?.set_tile_url_template(tileUrlTemplate);
  }, [canInteract, selectedMapStyle, sendToWorker]);

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

  return (
    <main className="fixed inset-0 h-screen w-screen overflow-hidden bg-black">
      <div ref={stageRef} className="absolute inset-0">
        <canvas
          key={canvasInstance}
          ref={canvasRef}
          aria-label="map-canvas"
          className="h-full w-full touch-none select-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const { x, y } = withCanvasPoint(event);
            sendPointerEvent("POINTER_DOWN", x, y, event.button);
          }}
          onPointerMove={(event) => {
            const { x, y } = withCanvasPoint(event);
            sendPointerEvent("POINTER_MOVE", x, y, event.button);
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            const { x, y } = withCanvasPoint(event);
            sendPointerEvent("POINTER_UP", x, y, event.button);
          }}
        />
      </div>
      <CsvDropOverlay enabled={canInteract} onDropFiles={handleDroppedFiles} />

      <div className="pointer-events-none fixed inset-x-0 top-0 z-20">
        <div className="pointer-events-auto flex w-full items-center justify-between border-b border-black/15 bg-white/80 px-4 py-2 backdrop-blur-md">
          <div />
          <div className="flex items-center gap-2">
            <Menubar className="h-9 rounded-none bg-white p-0">
              <MenubarMenu>
                <MenubarTrigger className="h-9 rounded-none px-3 text-black">Style</MenubarTrigger>
                <MenubarContent align="end" className="rounded-none">
                  <MenubarRadioGroup value={mapStyleId} onValueChange={(value) => setMapStyleId(value)}>
                    {MAP_STYLES.map((style) => (
                      <MenubarRadioItem key={style.id} value={style.id} className="rounded-none">
                        {style.label}
                      </MenubarRadioItem>
                    ))}
                  </MenubarRadioGroup>
                </MenubarContent>
              </MenubarMenu>
            </Menubar>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-none border-black/20 bg-white p-0 text-black hover:bg-black/[0.04]"
              onClick={handleZoomIn}
              disabled={!canInteract}
              aria-label="Zoom in"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-none border-black/20 bg-white p-0 text-black hover:bg-black/[0.04]"
              onClick={handleZoomOut}
              disabled={!canInteract}
              aria-label="Zoom out"
            >
              <Minus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
