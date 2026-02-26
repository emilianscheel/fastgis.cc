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
import { useMapEngineRuntime, type BasemapStyleConfig } from "@/hooks/use-map-engine-runtime";
import { useZoomShortcuts } from "@/hooks/use-zoom-shortcuts";
import { appToast } from "@/lib/app-toast";
import { dispatchScannedImport, scanImportFile } from "@/lib/import";
import type { PlacedMarker, ProjectedPoint } from "@/lib/map-protocol";

type RasterMapStyle = MapStyleOption & {
  engineKind: "raster";
  tileUrlTemplate: string;
};

type VectorMapStyle = MapStyleOption & {
  engineKind: "vector";
  vectorSource: {
    tileJsonUrl: string;
    stylePreset: "osm-vector-minimal";
    backendPreference: "webgl2" | "webgpu";
  };
};

type MapStyle = RasterMapStyle | VectorMapStyle;

type BaseMapConfig = {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  cacheSize: number;
};

type MeasurementRenderPoint = {
  lon: number;
  lat: number;
  screenX: number;
  screenY: number;
};

type ActiveMeasurementDrag = {
  markerIndex: number;
  marker: PlacedMarker;
  sessionId: number;
  inFlight: boolean;
  queuedTarget: { x: number; y: number } | null;
  dropRequested: boolean;
};

const LIGHT_THEME_MAP_STYLE_ID = "carto-light";
const DARK_THEME_MAP_STYLE_ID = "carto-dark";

const MAP_STYLES: MapStyle[] = [
  {
    id: "osm-fr-hot",
    label: "OpenStreetMap France HOT",
    engineKind: "raster",
    typeHintLabel: "Raster",
    tileUrlTemplate: "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png"
  },
  {
    id: "carto-light",
    label: "Carto Light",
    engineKind: "raster",
    typeHintLabel: "Raster",
    tileUrlTemplate: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
  },
  {
    id: "carto-dark",
    label: "Carto Dark",
    engineKind: "raster",
    typeHintLabel: "Raster",
    tileUrlTemplate: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
  },
  {
    id: "osm-vector-minimal",
    label: "OSM Vector Minimal",
    engineKind: "vector",
    typeHintLabel: "Vector",
    vectorSource: {
      tileJsonUrl: "https://vector.openstreetmap.org/shortbread_v1/tilejson.json",
      stylePreset: "osm-vector-minimal",
      backendPreference: "webgpu"
    }
  }
];

const BASE_MAP_CONFIG: BaseMapConfig = {
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  cacheSize: 2048
};

const ZOOM_STEP_DELTA = 1200;
const ZOOM_STEP_ANIMATION_MS = 300;
const EARTH_RADIUS_METERS = 6_371_000;
const MARKER_COORDINATE_MATCH_EPSILON = 1e-6;
const LOCATION_MARKER_HEAD_RADIUS_PX = 8;
const LOCATION_MARKER_HEAD_CENTER_OFFSET_Y_PX = 12;
const LOCATION_MARKER_TAIL_HALF_WIDTH_PX = 5;
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

function markerHeadCenterFromTip(tipX: number, tipY: number): { x: number; y: number } {
  return {
    x: tipX,
    y: tipY - LOCATION_MARKER_HEAD_CENTER_OFFSET_Y_PX
  };
}

function markerTailTopY(headCenterY: number): number {
  return headCenterY + LOCATION_MARKER_HEAD_RADIUS_PX - 1;
}

function triangleSign(
  pointX: number,
  pointY: number,
  aX: number,
  aY: number,
  bX: number,
  bY: number
): number {
  return (pointX - bX) * (aY - bY) - (aX - bX) * (pointY - bY);
}

function pointInTriangle(
  pointX: number,
  pointY: number,
  aX: number,
  aY: number,
  bX: number,
  bY: number,
  cX: number,
  cY: number
): boolean {
  const d1 = triangleSign(pointX, pointY, aX, aY, bX, bY);
  const d2 = triangleSign(pointX, pointY, bX, bY, cX, cY);
  const d3 = triangleSign(pointX, pointY, cX, cY, aX, aY);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function markerContainsPointer(
  tipX: number,
  tipY: number,
  pointerX: number,
  pointerY: number
): boolean {
  const headCenter = markerHeadCenterFromTip(tipX, tipY);
  const dx = pointerX - headCenter.x;
  const dy = pointerY - headCenter.y;
  const inHead = dx * dx + dy * dy <= LOCATION_MARKER_HEAD_RADIUS_PX * LOCATION_MARKER_HEAD_RADIUS_PX;
  if (inHead) {
    return true;
  }

  const tailTopY = markerTailTopY(headCenter.y);
  return pointInTriangle(
    pointerX,
    pointerY,
    tipX,
    tipY,
    tipX - LOCATION_MARKER_TAIL_HALF_WIDTH_PX,
    tailTopY,
    tipX + LOCATION_MARKER_TAIL_HALF_WIDTH_PX,
    tailTopY
  );
}

function mapStyleForTheme(theme?: string): MapStyle["id"] {
  return theme === "dark" ? DARK_THEME_MAP_STYLE_ID : LIGHT_THEME_MAP_STYLE_ID;
}

function getMapStyleById(id: MapStyle["id"]): MapStyle {
  return MAP_STYLES.find((style) => style.id === id) ?? MAP_STYLES[0];
}

function toBasemapStyleConfig(style: MapStyle): BasemapStyleConfig {
  if (style.engineKind === "raster") {
    return {
      id: style.id,
      engineKind: "raster",
      tileUrlTemplate: style.tileUrlTemplate
    };
  }

  return {
    id: style.id,
    engineKind: "vector",
    vectorSource: style.vectorSource
  };
}

export function MapShell() {
  const { resolvedTheme } = useTheme();

  const [isMounted, setIsMounted] = useState(false);
  const [mapStyleId, setMapStyleId] = useState<MapStyle["id"]>(LIGHT_THEME_MAP_STYLE_ID);
  const selectedMapStyle = useMemo(() => getMapStyleById(mapStyleId), [mapStyleId]);
  const selectedBasemapStyle = useMemo(
    () => toBasemapStyleConfig(selectedMapStyle),
    [selectedMapStyle]
  );

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
    loadMarkerCsv,
    getViewState,
    activeEngineKind
  } = useMapEngineRuntime({
    basemapStyle: selectedBasemapStyle,
    baseMapConfig: BASE_MAP_CONFIG
  });
  const isVectorStyleSelected = selectedMapStyle.engineKind === "vector";
  const isVectorEngineActive = activeEngineKind === "vector";

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
  const measurementRenderPointsRef = useRef<MeasurementRenderPoint[]>([]);
  const activeMeasurementDragRef = useRef<ActiveMeasurementDrag | null>(null);

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
          removeRecentMarkers(1);
          return;
        }

        setMeasurementPoints((current) => {
          const next = [...current, marker];
          measurementPointsRef.current = next;
          return next;
        });
      })();
    },
    [placeMarkerWithInfo, removeRecentMarkers]
  );

  const finishMeasurement = useCallback(() => {
    const currentPoints = measurementPointsRef.current;
    measurementSessionIdRef.current += 1;
    activeMeasurementDragRef.current = null;

    if (currentPoints.length > 0) {
      removeRecentMarkers(currentPoints.length);
    }

    measurementPointsRef.current = [];
    setMeasurementPoints([]);
    setMeasurementRenderPoints([]);
  }, [removeRecentMarkers]);

  const findMeasurementMarkerIndexAtPoint = useCallback((x: number, y: number): number | null => {
    const points = measurementPointsRef.current;
    const renderPoints = measurementRenderPointsRef.current;

    for (let index = points.length - 1; index >= 0; index -= 1) {
      const marker = points[index];
      const renderPoint = renderPoints[index];
      const tipX = renderPoint?.screenX ?? marker.tipScreenX;
      const tipY = renderPoint?.screenY ?? marker.tipScreenY;
      if (markerContainsPointer(tipX, tipY, x, y)) {
        return index;
      }
    }

    return null;
  }, []);

  const handleStartMeasurementMarkerDrag = useCallback(
    (x: number, y: number): boolean => {
      const markerIndex = findMeasurementMarkerIndexAtPoint(x, y);
      if (markerIndex === null) {
        return false;
      }

      const marker = measurementPointsRef.current[markerIndex];
      if (!marker) {
        return false;
      }

      activeMeasurementDragRef.current = {
        markerIndex,
        marker,
        sessionId: measurementSessionIdRef.current,
        inFlight: false,
        queuedTarget: null,
        dropRequested: false
      };
      return true;
    },
    [findMeasurementMarkerIndexAtPoint]
  );

  const commitMeasurementDragTarget = useCallback(
    (activeDrag: ActiveMeasurementDrag, x: number, y: number) => {
      const run = (targetX: number, targetY: number) => {
        if (activeDrag.inFlight) {
          activeDrag.queuedTarget = { x: targetX, y: targetY };
          return;
        }

        activeDrag.inFlight = true;
        const previousMarker = activeDrag.marker;

        void (async () => {
          const marker = await placeMarkerWithInfo(targetX, targetY);

          if (!marker) {
            activeDrag.inFlight = false;
          } else if (
            !isMeasurementActiveRef.current ||
            activeDrag.sessionId !== measurementSessionIdRef.current
          ) {
            removeRecentMarkers(1);
            activeDrag.inFlight = false;
            activeDrag.queuedTarget = null;
            if (activeMeasurementDragRef.current === activeDrag) {
              activeMeasurementDragRef.current = null;
            }
            return;
          } else {
            removeMarkerByLonLat(previousMarker.lon, previousMarker.lat);
            activeDrag.marker = marker;

            setMeasurementPoints((current) => {
              if (
                activeDrag.markerIndex < 0 ||
                activeDrag.markerIndex >= current.length ||
                activeDrag.sessionId !== measurementSessionIdRef.current
              ) {
                return current;
              }

              const next = [...current];
              next[activeDrag.markerIndex] = marker;
              measurementPointsRef.current = next;
              return next;
            });

            activeDrag.inFlight = false;
          }

          const queuedTarget = activeDrag.queuedTarget;
          activeDrag.queuedTarget = null;
          if (queuedTarget) {
            run(queuedTarget.x, queuedTarget.y);
            return;
          }

          if (activeDrag.dropRequested && activeMeasurementDragRef.current === activeDrag) {
            activeMeasurementDragRef.current = null;
          }
        })();
      };

      run(x, y);
    },
    [placeMarkerWithInfo, removeMarkerByLonLat, removeRecentMarkers]
  );

  const handleDragMeasurementMarker = useCallback(
    (x: number, y: number) => {
      const activeDrag = activeMeasurementDragRef.current;
      if (!activeDrag) {
        return;
      }

      commitMeasurementDragTarget(activeDrag, x, y);
    },
    [commitMeasurementDragTarget]
  );

  const handleDropMeasurementMarker = useCallback(
    (x: number, y: number) => {
      const activeDrag = activeMeasurementDragRef.current;
      if (!activeDrag) {
        return;
      }

      activeDrag.dropRequested = true;
      commitMeasurementDragTarget(activeDrag, x, y);
    },
    [commitMeasurementDragTarget]
  );

  const handleCancelMeasurementMarkerDrag = useCallback(() => {
    const activeDrag = activeMeasurementDragRef.current;
    if (!activeDrag) {
      return;
    }

    activeDrag.dropRequested = true;
    activeDrag.queuedTarget = null;
    if (!activeDrag.inFlight) {
      activeMeasurementDragRef.current = null;
    }
  }, []);

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
    onPlaceMeasurement: handlePlaceMeasurement,
    onStartMeasurementMarkerDrag: handleStartMeasurementMarkerDrag,
    onDragMeasurementMarker: handleDragMeasurementMarker,
    onDropMeasurementMarker: handleDropMeasurementMarker,
    onCancelMeasurementMarkerDrag: handleCancelMeasurementMarkerDrag
  });

  useEffect(() => {
    if (!(isVectorEngineActive || isVectorStyleSelected)) {
      return;
    }

    if (isMarkerActive) {
      toggleMarkerTool();
    }
    if (isMeasurementActive) {
      toggleMeasurementTool();
    }
  }, [
    isMarkerActive,
    isMeasurementActive,
    isVectorEngineActive,
    isVectorStyleSelected,
    toggleMarkerTool,
    toggleMeasurementTool
  ]);

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
    measurementRenderPointsRef.current = measurementRenderPoints;
  }, [measurementRenderPoints]);

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
            key: "adjust",
            content: <span>drag a marker to adjust a point</span>
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

  const handleImportBytes = useCallback(
    (file: File, bytes: Uint8Array) => {
      if (isVectorEngineActive || isVectorStyleSelected) {
        appToast.error("CSV import is not available for the vector style yet.");
        return;
      }

      const scanResult = scanImportFile({
        fileName: file.name,
        mimeType: file.type,
        bytes
      });

      if (!scanResult) {
        appToast.error(`Unsupported import format: ${file.name}`);
        return;
      }

      const dispatchResult = dispatchScannedImport(scanResult, file.name, bytes, {
        loadTrajectoryCsv,
        loadMarkerCsv
      });

      if (!dispatchResult.accepted) {
        appToast.error(`No import handler available for: ${file.name}`);
      }
    },
    [isVectorEngineActive, isVectorStyleSelected, loadMarkerCsv, loadTrajectoryCsv]
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!canInteract) return;

      const bytes = new Uint8Array(await file.arrayBuffer());
      handleImportBytes(file, bytes);
    },
    [canInteract, handleImportBytes]
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

  const showVectorToolUnavailable = useCallback((toolName: string) => {
    appToast.error(`${toolName} is not available in the vector style MVP yet.`);
  }, []);

  const handleToggleMarkerTool = useCallback(() => {
    if (isVectorEngineActive || isVectorStyleSelected) {
      showVectorToolUnavailable("Marker tool");
      return;
    }
    toggleMarkerTool();
  }, [isVectorEngineActive, isVectorStyleSelected, showVectorToolUnavailable, toggleMarkerTool]);

  const handleToggleMeasurementTool = useCallback(() => {
    if (isVectorEngineActive || isVectorStyleSelected) {
      showVectorToolUnavailable("Measurement tool");
      return;
    }
    toggleMeasurementTool();
  }, [
    isVectorEngineActive,
    isVectorStyleSelected,
    showVectorToolUnavailable,
    toggleMeasurementTool
  ]);

  const handleMapStyleChange = useCallback(
    (value: string) => {
      const nextStyle = MAP_STYLES.find((style) => style.id === value);
      if (!nextStyle) return;

      void (async () => {
        try {
          await getViewState();
        } catch (error) {
          console.error("Failed to capture current map view before style switch.", error);
        }
        setMapStyleId(nextStyle.id);
      })();
    },
    [getViewState]
  );

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
      <CsvDropOverlay enabled={canInteract && !isVectorEngineActive && !isVectorStyleSelected} onDropFiles={handleDroppedFiles} />
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
        onToggleMarker={handleToggleMarkerTool}
        onToggleMeasurement={handleToggleMeasurementTool}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />
    </main>
  );
}
