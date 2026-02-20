"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { CsvDropOverlay } from "@/components/csv-drop-overlay";
import {
  MapCanvasStage,
  type MeasurementMarkerOverlay,
  type MeasurementSegmentOverlay
} from "@/components/map/map-canvas-stage";
import { MapToolbar, type MapStyleOption } from "@/components/map/map-toolbar";
import { Kbd } from "@/components/ui/kbd";
import { SonnerGroupedPills } from "@/components/ui/sonner";
import { useBoxZoomTool } from "@/hooks/use-box-zoom-tool";
import { useMapEngineRuntime } from "@/hooks/use-map-engine-runtime";
import { useZoomShortcuts } from "@/hooks/use-zoom-shortcuts";
import { appToast } from "@/lib/app-toast";
import type { InitConfig, PlacedMarker, ProjectedPoint } from "@/lib/map-protocol";

type MapStyle = MapStyleOption & {
  tileUrlTemplate: string;
};

type MeasurementRenderPoint = {
  lon: number;
  lat: number;
  screenX: number;
  screenY: number;
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
const EARTH_RADIUS_METERS = 6_371_000;
const MARKER_COORDINATE_MATCH_EPSILON = 1e-6;
const MEASUREMENT_GUIDANCE_TOAST_ID = "measure-distance-guidance";
const COPIED_DISTANCE_TOAST_ID = "measure-distance-copy";

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(a: PlacedMarker, b: PlacedMarker): number {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = degreesToRadians(b.lon - a.lon);
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const h = sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  const arc = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  return EARTH_RADIUS_METERS * arc;
}

function formatDistanceMeters(distanceMeters: number): string {
  return `${distanceMeters.toFixed(2)} m`;
}

function ordinalPointLabel(value: number): string {
  if (value === 2) return "second";
  if (value === 3) return "third";
  if (value === 4) return "fourth";

  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${value}th`;
  }

  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
}

function measurementPromptText(pointCount: number): string {
  if (pointCount <= 0) {
    return "please click on the map to start measuring";
  }

  return `please select the ${ordinalPointLabel(pointCount + 1)} point`;
}

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

  const stepZoom = useCallback(
    (direction: "in" | "out", focusPoint?: { x: number; y: number }) => {
      if (!canInteract) return;

      stopZoomAnimation();

      const { width, height } = viewportSize();
      const centerX = focusPoint?.x ?? width / 2;
      const centerY = focusPoint?.y ?? height / 2;
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

  const [measurementPoints, setMeasurementPoints] = useState<PlacedMarker[]>([]);
  const [measurementRenderPoints, setMeasurementRenderPoints] = useState<MeasurementRenderPoint[]>([]);
  const measurementSessionIdRef = useRef(0);
  const isMeasurementActiveRef = useRef(false);
  const wasMeasurementActiveRef = useRef(false);
  const measurementPointsRef = useRef<PlacedMarker[]>([]);

  const handlePlaceMeasurement = useCallback(
    (x: number, y: number) => {
      const requestSessionId = measurementSessionIdRef.current;
      void (async () => {
        const marker = await placeMarkerWithInfo(x, y);
        if (!marker) {
          return;
        }

        if (
          !isMeasurementActiveRef.current ||
          requestSessionId !== measurementSessionIdRef.current
        ) {
          return;
        }

        setMeasurementPoints((current) => {
          const next = [...current, marker];
          measurementPointsRef.current = next;
          return next;
        });
      })();
    },
    [placeMarkerWithInfo]
  );

  const finishMeasurement = useCallback(() => {
    const currentPoints = measurementPointsRef.current;
    measurementSessionIdRef.current += 1;

    if (currentPoints.length > 0) {
      removeRecentMarkers(currentPoints.length);
    }

    measurementPointsRef.current = [];
    setMeasurementPoints([]);
    setMeasurementRenderPoints([]);
  }, [removeRecentMarkers]);

  const {
    isBoxZoomActive,
    isZoomInToolActive,
    isZoomOutToolActive,
    isMarkerActive,
    isMeasurementActive,
    boxZoomRect,
    canvasCursorClassName,
    toggleBoxZoomTool,
    toggleZoomInTool,
    toggleZoomOutTool,
    toggleMarkerTool,
    toggleMeasurementTool,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleCanvasPointerCancel,
    handleCanvasPointerLeave
  } = useBoxZoomTool({
    canInteract,
    cancelWheelZoomAnimation: stopZoomAnimation,
    onHoverPoint: hoverMarkerAtPoint,
    onHoverClear: clearMarkerHover,
    onPanPointerEvent: sendPointerEvent,
    onZoomToBox: handleZoomToBox,
    onClickZoom: (direction, x, y) => {
      stepZoom(direction, { x, y });
    },
    onPlaceMarker: placeMarker,
    onPlaceMeasurement: handlePlaceMeasurement
  });

  useEffect(() => {
    const wasMeasurementActive = wasMeasurementActiveRef.current;
    isMeasurementActiveRef.current = isMeasurementActive;

    if (!isMeasurementActive) {
      if (wasMeasurementActive) {
        finishMeasurement();
      }
      toast.dismiss(MEASUREMENT_GUIDANCE_TOAST_ID);
    }

    wasMeasurementActiveRef.current = isMeasurementActive;
  }, [finishMeasurement, isMeasurementActive]);

  useEffect(() => {
    measurementPointsRef.current = measurementPoints;
  }, [measurementPoints]);

  useEffect(() => {
    return () => {
      toast.dismiss(MEASUREMENT_GUIDANCE_TOAST_ID);
    };
  }, []);

  useEffect(() => {
    if (!isMeasurementActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      finishMeasurement();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [finishMeasurement, isMeasurementActive]);

  const handleMarkerHoverCopy = useCallback(async (marker: { lat: number; lon: number }) => {
    const coordinates = `${marker.lat}, ${marker.lon}`;
    try {
      await navigator.clipboard.writeText(coordinates);
      appToast.copiedCoordinates(marker.lat, marker.lon);
    } catch (error) {
      appToast.error("Failed to copy coordinates to clipboard.");
      console.error("Failed to copy marker coordinates.", error);
    }
  }, []);

  const handleMarkerHoverRemove = useCallback(
    (marker: { lat: number; lon: number }) => {
      removeMarkerByLonLat(marker.lon, marker.lat);
      clearMarkerHover();
    },
    [clearMarkerHover, removeMarkerByLonLat]
  );

  const handleRemoveMeasurementMarker = useCallback(
    (markerIndex: number) => {
      const currentPoints = measurementPointsRef.current;
      if (markerIndex < 0 || markerIndex >= currentPoints.length) {
        return;
      }

      const nextPoints = currentPoints.filter((_, index) => index !== markerIndex);
      measurementSessionIdRef.current += 1;

      removeRecentMarkers(currentPoints.length);
      for (const marker of nextPoints) {
        addMarkerAtLonLat(marker.lon, marker.lat);
      }

      measurementPointsRef.current = nextPoints;
      setMeasurementPoints(nextPoints);
      setMeasurementRenderPoints([]);
      clearMarkerHover();
    },
    [addMarkerAtLonLat, clearMarkerHover, removeRecentMarkers]
  );

  useEffect(() => {
    if (measurementPoints.length === 0) {
      setMeasurementRenderPoints([]);
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;

    const toRenderPoint = (
      marker: PlacedMarker,
      projected: ProjectedPoint | null
    ): MeasurementRenderPoint => ({
      lon: marker.lon,
      lat: marker.lat,
      screenX: projected?.screenX ?? marker.tipScreenX,
      screenY: projected?.screenY ?? marker.tipScreenY
    });

    const tick = async () => {
      const projectedPoints = await Promise.all(
        measurementPoints.map((marker) => projectLonLat(marker.lon, marker.lat))
      );

      if (cancelled) {
        return;
      }

      setMeasurementRenderPoints(
        measurementPoints.map((marker, index) => toRenderPoint(marker, projectedPoints[index] ?? null))
      );

      rafId = window.requestAnimationFrame(() => {
        void tick();
      });
    };

    void tick();

    return () => {
      cancelled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [measurementPoints, projectLonLat]);

  const { segments: measurementSegments, totalDistanceMeters } = useMemo(() => {
    const segments: MeasurementSegmentOverlay[] = [];
    let totalDistanceMeters = 0;

    for (let index = 1; index < measurementPoints.length; index += 1) {
      const startMarker = measurementPoints[index - 1];
      const endMarker = measurementPoints[index];
      const startRenderPoint = measurementRenderPoints[index - 1] ?? {
        screenX: startMarker.tipScreenX,
        screenY: startMarker.tipScreenY
      };
      const endRenderPoint = measurementRenderPoints[index] ?? {
        screenX: endMarker.tipScreenX,
        screenY: endMarker.tipScreenY
      };
      const distanceMeters = haversineDistanceMeters(startMarker, endMarker);
      totalDistanceMeters += distanceMeters;

      segments.push({
        startX: startRenderPoint.screenX,
        startY: startRenderPoint.screenY,
        endX: endRenderPoint.screenX,
        endY: endRenderPoint.screenY,
        centerX: (startRenderPoint.screenX + endRenderPoint.screenX) * 0.5,
        centerY: (startRenderPoint.screenY + endRenderPoint.screenY) * 0.5,
        distanceMeters,
        label: formatDistanceMeters(distanceMeters)
      });
    }

    return { segments, totalDistanceMeters };
  }, [measurementPoints, measurementRenderPoints]);

  const measurementMarkers = useMemo<MeasurementMarkerOverlay[]>(
    () =>
      measurementPoints.map((marker, index) => {
        const renderPoint = measurementRenderPoints[index] ?? {
          screenX: marker.tipScreenX,
          screenY: marker.tipScreenY
        };

        return {
          index,
          lat: marker.lat,
          lon: marker.lon,
          screenX: renderPoint.screenX,
          screenY: renderPoint.screenY
        };
      }),
    [measurementPoints, measurementRenderPoints]
  );

  const hoveredMeasurementMarkerIndex = useMemo<number | null>(() => {
    if (!markerHover) {
      return null;
    }

    for (const marker of measurementMarkers) {
      const lonDelta = Math.abs(marker.lon - markerHover.lon);
      const latDelta = Math.abs(marker.lat - markerHover.lat);
      if (lonDelta <= MARKER_COORDINATE_MATCH_EPSILON && latDelta <= MARKER_COORDINATE_MATCH_EPSILON) {
        return marker.index;
      }
    }

    return null;
  }, [markerHover, measurementMarkers]);

  useEffect(() => {
    if (!isMeasurementActive) {
      return;
    }

    const prompt = measurementPromptText(measurementPoints.length);
    appToast.show(
      <SonnerGroupedPills
        parts={[
          {
            key: "prompt",
            content: <span>{prompt}</span>
          },
          {
            key: "distance",
            content: <span className="font-mono tabular-nums">{formatDistanceMeters(totalDistanceMeters)}</span>
          },
          {
            key: "finish",
            content: (
              <span className="inline-flex items-center gap-1">
                <Kbd className="h-4 px-1 text-[10px]">Enter</Kbd>
                <span>finishes measurement</span>
              </span>
            )
          }
        ]}
      />,
      {
        id: MEASUREMENT_GUIDANCE_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        closeButton: false
      }
    );
  }, [isMeasurementActive, measurementPoints.length, totalDistanceMeters]);

  const handleMeasurementDistanceCopy = useCallback(async (distanceMeters: number) => {
    const formattedDistance = formatDistanceMeters(distanceMeters);

    try {
      await navigator.clipboard.writeText(formattedDistance);
      appToast.show(
        <span className="inline-flex items-baseline gap-1">
          <span>Copied</span>
          <span className="font-mono tabular-nums">{formattedDistance}</span>
          <span>to clipboard</span>
        </span>,
        {
          id: COPIED_DISTANCE_TOAST_ID
        }
      );
    } catch (error) {
      appToast.error("Failed to copy distance to clipboard.");
      console.error("Failed to copy measured distance.", error);
    }
  }, []);

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
        markerHover={markerHover}
        isMeasurementActive={isMeasurementActive}
        hoveredMeasurementMarkerIndex={hoveredMeasurementMarkerIndex}
        measurementMarkers={measurementMarkers}
        measurementSegments={measurementSegments}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerCancel}
        onPointerLeave={handleCanvasPointerLeave}
        onMarkerHoverCopy={handleMarkerHoverCopy}
        onMarkerHoverRemove={handleMarkerHoverRemove}
        onMeasurementMarkerCopy={handleMarkerHoverCopy}
        onRemoveMeasurementMarker={handleRemoveMeasurementMarker}
        onMeasurementDistanceCopy={handleMeasurementDistanceCopy}
      />
      <CsvDropOverlay enabled={canInteract} onDropFiles={handleDroppedFiles} />
      <MapToolbar
        canInteract={canInteract}
        isMounted={isMounted}
        mapStyleId={mapStyleId}
        mapStyles={MAP_STYLES}
        isBoxZoomActive={isBoxZoomActive}
        isZoomInToolActive={isZoomInToolActive}
        isZoomOutToolActive={isZoomOutToolActive}
        isMarkerActive={isMarkerActive}
        isMeasurementActive={isMeasurementActive}
        onMapStyleChange={handleMapStyleChange}
        onToggleBoxZoom={toggleBoxZoomTool}
        onToggleZoomInTool={toggleZoomInTool}
        onToggleZoomOutTool={toggleZoomOutTool}
        onToggleMarker={toggleMarkerTool}
        onToggleMeasurement={toggleMeasurementTool}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />
    </main>
  );
}
