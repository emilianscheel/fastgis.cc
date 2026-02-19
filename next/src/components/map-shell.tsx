"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";

import { CsvDropOverlay } from "@/components/csv-drop-overlay";
import { MapCanvasStage } from "@/components/map/map-canvas-stage";
import { MapToolbar, type MapStyleOption } from "@/components/map/map-toolbar";
import { useBoxZoomTool } from "@/hooks/use-box-zoom-tool";
import { useMapEngineRuntime } from "@/hooks/use-map-engine-runtime";
import { useZoomShortcuts } from "@/hooks/use-zoom-shortcuts";
import type { InitConfig } from "@/lib/map-protocol";

type MapStyle = MapStyleOption & {
  tileUrlTemplate: string;
};

const LIGHT_THEME_MAP_STYLE_ID = "carto-light";
const DARK_THEME_MAP_STYLE_ID = "carto-dark";

const MAP_STYLES: MapStyle[] = [
  {
    id: "osm-fr-hot",
    label: "OpenStreetMap France HOT",
    tileUrlTemplate: "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png"
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
  cacheSize: 2048
};

const ZOOM_STEP_DELTA = 1200;
const ZOOM_STEP_ANIMATION_MS = 300;

function mapStyleForTheme(theme?: string): MapStyle["id"] {
  return theme === "dark" ? DARK_THEME_MAP_STYLE_ID : LIGHT_THEME_MAP_STYLE_ID;
}

function getMapStyleById(id: MapStyle["id"]): MapStyle {
  return MAP_STYLES.find((style) => style.id === id) ?? MAP_STYLES[0];
}

export function MapShell() {
  const { resolvedTheme } = useTheme();

  const [isMounted, setIsMounted] = useState(false);
  const [mapStyleId, setMapStyleId] = useState<MapStyle["id"]>(LIGHT_THEME_MAP_STYLE_ID);
  const selectedMapStyle = useMemo(() => getMapStyleById(mapStyleId), [mapStyleId]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted || !resolvedTheme) {
      return;
    }

    const themeDrivenMapStyleId = mapStyleForTheme(resolvedTheme);
    setMapStyleId((currentStyleId) => {
      const isThemeCartoStyle =
        currentStyleId === LIGHT_THEME_MAP_STYLE_ID || currentStyleId === DARK_THEME_MAP_STYLE_ID;
      if (!isThemeCartoStyle || currentStyleId === themeDrivenMapStyleId) {
        return currentStyleId;
      }
      return themeDrivenMapStyleId;
    });
  }, [isMounted, resolvedTheme]);

  const {
    canvasRef,
    stageRef,
    canvasInstance,
    canInteract,
    viewportSize,
    sendPointerEvent,
    applyWheel,
    zoomToBox,
    loadTrajectoryCsv,
    setTileUrlTemplate
  } = useMapEngineRuntime({
    initialTileUrlTemplate: selectedMapStyle.tileUrlTemplate,
    baseMapConfig: BASE_MAP_CONFIG
  });

  const zoomAnimationRef = useRef<number | null>(null);

  const stopZoomAnimation = useCallback(() => {
    if (zoomAnimationRef.current !== null) {
      window.cancelAnimationFrame(zoomAnimationRef.current);
      zoomAnimationRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopZoomAnimation();
    };
  }, [stopZoomAnimation]);

  const handleZoomToBox = useCallback(
    (startX: number, startY: number, endX: number, endY: number) => {
      stopZoomAnimation();
      zoomToBox(startX, startY, endX, endY);
    },
    [stopZoomAnimation, zoomToBox]
  );

  const {
    isBoxZoomActive,
    boxZoomRect,
    canvasCursorClassName,
    toggleBoxZoomTool,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleCanvasPointerCancel
  } = useBoxZoomTool({
    canInteract,
    cancelWheelZoomAnimation: stopZoomAnimation,
    onPanPointerEvent: sendPointerEvent,
    onZoomToBox: handleZoomToBox
  });

  const stepZoom = useCallback(
    (direction: "in" | "out") => {
      if (!canInteract) return;

      stopZoomAnimation();

      const { width, height } = viewportSize();
      const centerX = width / 2;
      const centerY = height / 2;
      const targetDelta = direction === "in" ? -ZOOM_STEP_DELTA : ZOOM_STEP_DELTA;
      const startTime = performance.now();
      let lastEasedProgress = 0;

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / ZOOM_STEP_ANIMATION_MS);
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        const frameDelta = (easedProgress - lastEasedProgress) * targetDelta;
        lastEasedProgress = easedProgress;

        applyWheel(frameDelta, centerX, centerY);

        if (progress < 1) {
          zoomAnimationRef.current = window.requestAnimationFrame(tick);
          return;
        }

        zoomAnimationRef.current = null;
      };

      zoomAnimationRef.current = window.requestAnimationFrame(tick);
    },
    [applyWheel, canInteract, stopZoomAnimation, viewportSize]
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
    setTileUrlTemplate(selectedMapStyle.tileUrlTemplate);
  }, [selectedMapStyle, setTileUrlTemplate]);

  const handleCsvBytes = useCallback(
    (fileName: string, bytes: Uint8Array) => {
      loadTrajectoryCsv(fileName, bytes);
    },
    [loadTrajectoryCsv]
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

  const handleMapStyleChange = useCallback((value: string) => {
    const nextStyle = MAP_STYLES.find((style) => style.id === value);
    if (!nextStyle) return;
    setMapStyleId(nextStyle.id);
  }, []);

  return (
    <main className="fixed inset-0 h-screen w-screen overflow-hidden bg-background">
      <MapCanvasStage
        stageRef={stageRef}
        canvasRef={canvasRef}
        canvasKey={canvasInstance}
        cursorClassName={canvasCursorClassName}
        boxZoomRect={boxZoomRect}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerCancel}
      />
      <CsvDropOverlay enabled={canInteract} onDropFiles={handleDroppedFiles} />
      <MapToolbar
        canInteract={canInteract}
        isMounted={isMounted}
        mapStyleId={mapStyleId}
        mapStyles={MAP_STYLES}
        isBoxZoomActive={isBoxZoomActive}
        onMapStyleChange={handleMapStyleChange}
        onToggleBoxZoom={toggleBoxZoomTool}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />
    </main>
  );
}
