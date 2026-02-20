"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoxZoomRect } from "@/hooks/use-box-zoom-tool";
import type { MarkerHover } from "@/lib/map-protocol";
import { cn } from "@/lib/utils";

export type MeasurementSegmentOverlay = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  centerX: number;
  centerY: number;
  distanceMeters: number;
  label: string;
};

export type MeasurementMarkerOverlay = {
  index: number;
  lat: number;
  lon: number;
  screenX: number;
  screenY: number;
};

type MapCanvasStageProps = {
  stageRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasKey: number;
  cursorClassName: string;
  boxZoomRect: BoxZoomRect | null;
  markerHover: MarkerHover | null;
  isMeasurementActive: boolean;
  hoveredMeasurementMarkerIndex: number | null;
  measurementMarkers: MeasurementMarkerOverlay[];
  measurementSegments: MeasurementSegmentOverlay[];
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMarkerHoverCopy: (marker: { lat: number; lon: number }) => void;
  onMarkerHoverRemove: (marker: { lat: number; lon: number }) => void;
  onMeasurementMarkerCopy: (marker: { lat: number; lon: number }) => void;
  onRemoveMeasurementMarker: (index: number) => void;
  onMeasurementDistanceCopy: (distanceMeters: number) => void;
};

const MARKER_TOOLTIP_BRIDGE_WIDTH_PX = 120;
const MARKER_TOOLTIP_BRIDGE_HEIGHT_PX = 18;
const MARKER_TOOLTIP_TRANSITION_MS = 180;
const MARKER_TOOLTIP_HOVER_GRACE_MS = 260;
const MARKER_HOVER_REMOVE_TOOLTIP_FROM_ANCHOR_PX = 26;
const MARKER_HOVER_REMOVE_BRIDGE_FROM_ANCHOR_PX = 0;
const MARKER_HOVER_REMOVE_BRIDGE_WIDTH_PX = 184;
const MARKER_HOVER_REMOVE_BRIDGE_HEIGHT_PX = 28;
const MARKER_HOVER_REMOVE_CATCH_FROM_ANCHOR_PX = 0;
const MARKER_HOVER_REMOVE_CATCH_WIDTH_PX = 220;
const MARKER_HOVER_REMOVE_CATCH_HEIGHT_PX = 42;
const MARKER_TOOLTIP_ANCHOR_FROM_TIP_PX = 26;
const TOOLTIP_PILL_CLASS_NAME =
  "pointer-events-auto rounded-full border border-border/80 bg-background/95 px-2 py-1 text-[10px] leading-none text-foreground shadow-sm backdrop-blur-sm";
const TOOLTIP_ANIMATION_CLASS_NAME = "transition-all duration-200 ease-out";
const MARKER_COORDINATE_MATCH_EPSILON = 1e-6;

type CoordinatesLike = {
  lat: number;
  lon: number;
};

function hasSameCoordinates(a: CoordinatesLike, b: CoordinatesLike): boolean {
  return (
    Math.abs(a.lon - b.lon) <= MARKER_COORDINATE_MATCH_EPSILON &&
    Math.abs(a.lat - b.lat) <= MARKER_COORDINATE_MATCH_EPSILON
  );
}

function useTooltipPresence<T>(
  value: T | null,
  getIdentity?: (value: T) => string,
  options?: { keepAlive?: boolean }
) {
  const keepAlive = options?.keepAlive ?? false;
  const [renderValue, setRenderValue] = useState<T | null>(value);
  const [isVisible, setIsVisible] = useState<boolean>(Boolean(value));
  const identity = value ? (getIdentity ? getIdentity(value) : "present") : null;
  const activeIdentityRef = useRef<string | null>(identity);

  useEffect(() => {
    if (value) {
      setRenderValue(value);
    }
  }, [value]);

  useEffect(() => {
    if (identity) {
      const isSameIdentity = activeIdentityRef.current === identity;
      activeIdentityRef.current = identity;
      if (isSameIdentity) {
        return;
      }

      setIsVisible(false);
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    activeIdentityRef.current = null;
  }, [identity]);

  useEffect(() => {
    if (identity) {
      return;
    }

    if (keepAlive && renderValue) {
      setIsVisible(true);
      return;
    }

    const hideTimeoutId = window.setTimeout(() => {
      setIsVisible(false);
    }, MARKER_TOOLTIP_HOVER_GRACE_MS);
    const clearTimeoutId = window.setTimeout(() => {
      setRenderValue(null);
    }, MARKER_TOOLTIP_HOVER_GRACE_MS + MARKER_TOOLTIP_TRANSITION_MS);
    return () => {
      window.clearTimeout(hideTimeoutId);
      window.clearTimeout(clearTimeoutId);
    };
  }, [identity, keepAlive, renderValue]);

  return { renderValue, isVisible };
}

type HoverTooltipMarker = {
  lat: number;
  lon: number;
  screenX: number;
  screenY: number;
};

function markerIdentityKey(marker: CoordinatesLike): string {
  return `${marker.lat.toFixed(6)}:${marker.lon.toFixed(6)}`;
}

type HoveredMarkerTooltipsProps = {
  marker: HoverTooltipMarker;
  visible: boolean;
  onCopy: (marker: { lat: number; lon: number }) => void;
  onRemove: (marker: { lat: number; lon: number }) => void;
  zIndexClassName?: string;
  enableHoverCatch?: boolean;
  onTooltipPointerEnter?: () => void;
  onTooltipPointerLeave?: () => void;
};

function HoveredMarkerTooltips({
  marker,
  visible,
  onCopy,
  onRemove,
  zIndexClassName = "z-20",
  enableHoverCatch = true,
  onTooltipPointerEnter,
  onTooltipPointerLeave
}: HoveredMarkerTooltipsProps) {
  const markerLabel = `${marker.lat.toFixed(3)}, ${marker.lon.toFixed(3)}`;

  return (
    <div className={cn("pointer-events-none absolute inset-0", zIndexClassName)}>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute z-0 -translate-x-1/2",
          TOOLTIP_ANIMATION_CLASS_NAME,
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
        )}
        style={{
          left: `${marker.screenX}px`,
          top: `${marker.screenY}px`,
          width: `${MARKER_TOOLTIP_BRIDGE_WIDTH_PX}px`,
          height: `${MARKER_TOOLTIP_BRIDGE_HEIGHT_PX}px`,
          clipPath: "polygon(0 0, 100% 0, 50% 100%)"
        }}
      />
      <div
        className="absolute z-10 -translate-x-1/2 -translate-y-full"
        style={{
          left: `${marker.screenX}px`,
          top: `${marker.screenY}px`
        }}
      >
        <button
          type="button"
          className={cn(
            TOOLTIP_PILL_CLASS_NAME,
            "font-mono tabular-nums",
            TOOLTIP_ANIMATION_CLASS_NAME,
            visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-2"
          )}
          onPointerEnter={onTooltipPointerEnter}
          onPointerLeave={onTooltipPointerLeave}
          onClick={() => onCopy(marker)}
          title="Copy coordinates"
        >
          {markerLabel}
        </button>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute z-0 -translate-x-1/2",
          "transition-opacity duration-100 ease-out",
          visible ? "opacity-100" : "opacity-0"
        )}
        style={{
          left: `${marker.screenX}px`,
          top: `${marker.screenY + MARKER_HOVER_REMOVE_BRIDGE_FROM_ANCHOR_PX}px`,
          width: `${MARKER_HOVER_REMOVE_BRIDGE_WIDTH_PX}px`,
          height: `${MARKER_HOVER_REMOVE_BRIDGE_HEIGHT_PX}px`,
          clipPath: "polygon(50% 0, 0 100%, 100% 100%)"
        }}
      />
      <div
        aria-hidden="true"
        className={cn(
          "absolute z-[5] -translate-x-1/2",
          enableHoverCatch && visible ? "pointer-events-auto" : "pointer-events-none"
        )}
        style={{
          left: `${marker.screenX}px`,
          top: `${marker.screenY + MARKER_HOVER_REMOVE_CATCH_FROM_ANCHOR_PX}px`,
          width: `${MARKER_HOVER_REMOVE_CATCH_WIDTH_PX}px`,
          height: `${MARKER_HOVER_REMOVE_CATCH_HEIGHT_PX}px`
        }}
      />
      <div
        className="absolute z-10 -translate-x-1/2"
        style={{
          left: `${marker.screenX}px`,
          top: `${marker.screenY + MARKER_HOVER_REMOVE_TOOLTIP_FROM_ANCHOR_PX}px`
        }}
      >
        <button
          type="button"
          className={cn(
            TOOLTIP_PILL_CLASS_NAME,
            TOOLTIP_ANIMATION_CLASS_NAME,
            visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 -translate-y-2"
          )}
          onPointerEnter={onTooltipPointerEnter}
          onPointerLeave={onTooltipPointerLeave}
          onClick={() => onRemove(marker)}
          title="Remove marker"
        >
          remove
        </button>
      </div>
    </div>
  );
}

export function MapCanvasStage({
  stageRef,
  canvasRef,
  canvasKey,
  cursorClassName,
  boxZoomRect,
  markerHover,
  isMeasurementActive,
  hoveredMeasurementMarkerIndex,
  measurementMarkers,
  measurementSegments,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onMarkerHoverCopy,
  onMarkerHoverRemove,
  onMeasurementMarkerCopy,
  onRemoveMeasurementMarker,
  onMeasurementDistanceCopy
}: MapCanvasStageProps) {
  const [isHoveredTooltipPinned, setIsHoveredTooltipPinned] = useState(false);

  const hoveredMeasurementMarker = useMemo<MeasurementMarkerOverlay | null>(() => {
    if (hoveredMeasurementMarkerIndex === null) {
      return null;
    }

    return measurementMarkers.find((marker) => marker.index === hoveredMeasurementMarkerIndex) ?? null;
  }, [hoveredMeasurementMarkerIndex, measurementMarkers]);

  const { renderValue: markerTooltipMarker, isVisible: isMarkerTooltipVisible } =
    useTooltipPresence<MarkerHover>(markerHover, markerIdentityKey, {
      keepAlive: isHoveredTooltipPinned
    });
  const { renderValue: rulerTooltipMarker, isVisible: isRulerTooltipVisible } = useTooltipPresence<
    MeasurementMarkerOverlay
  >(hoveredMeasurementMarker, markerIdentityKey, {
    keepAlive: isHoveredTooltipPinned
  });

  useEffect(() => {
    if (markerTooltipMarker || rulerTooltipMarker) {
      return;
    }

    setIsHoveredTooltipPinned(false);
  }, [markerTooltipMarker, rulerTooltipMarker]);

  const activeHoveredTooltip = useMemo<{
    marker: HoverTooltipMarker;
    onCopy: (marker: { lat: number; lon: number }) => void;
    onRemove: (marker: { lat: number; lon: number }) => void;
    visible: boolean;
    enableHoverCatch: boolean;
  } | null>(() => {
    if (rulerTooltipMarker) {
      return {
        marker: {
          lat: rulerTooltipMarker.lat,
          lon: rulerTooltipMarker.lon,
          screenX: rulerTooltipMarker.screenX,
          screenY: rulerTooltipMarker.screenY - MARKER_TOOLTIP_ANCHOR_FROM_TIP_PX
        },
        onCopy: onMeasurementMarkerCopy,
        onRemove: () => onRemoveMeasurementMarker(rulerTooltipMarker.index),
        visible: isRulerTooltipVisible,
        enableHoverCatch: false
      };
    }

    if (!markerTooltipMarker) {
      return null;
    }

    if (
      hoveredMeasurementMarker &&
      hasSameCoordinates(markerTooltipMarker, hoveredMeasurementMarker)
    ) {
      return null;
    }

    return {
      marker: {
        lat: markerTooltipMarker.lat,
        lon: markerTooltipMarker.lon,
        screenX: markerTooltipMarker.screenX,
        screenY: markerTooltipMarker.screenY
      },
      onCopy: onMarkerHoverCopy,
      onRemove: onMarkerHoverRemove,
      visible: isMarkerTooltipVisible,
      enableHoverCatch: true
    };
  }, [
    hoveredMeasurementMarker,
    isMarkerTooltipVisible,
    isRulerTooltipVisible,
    markerTooltipMarker,
    onMarkerHoverCopy,
    onMarkerHoverRemove,
    onMeasurementMarkerCopy,
    onRemoveMeasurementMarker,
    rulerTooltipMarker
  ]);

  return (
    <div className="absolute inset-0" onPointerLeave={onPointerLeave}>
      <div ref={stageRef} className="absolute inset-0">
        <canvas
          key={canvasKey}
          ref={canvasRef}
          aria-label="map-canvas"
          className={`h-full w-full touch-none select-none ${cursorClassName}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />
      </div>
      <div
        className={`pointer-events-none absolute inset-0 z-[5] transition-opacity duration-300 ease-out ${
          isMeasurementActive ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-0 [background:linear-gradient(to_right,rgba(249,115,22,0.16)_0%,transparent_18%,transparent_82%,rgba(249,115,22,0.16)_100%),linear-gradient(to_bottom,rgba(249,115,22,0.16)_0%,transparent_18%,transparent_82%,rgba(249,115,22,0.16)_100%)]" />
      </div>
      {boxZoomRect ? (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            className="absolute border border-primary bg-primary/10"
            style={{
              left: `${boxZoomRect.left}px`,
              top: `${boxZoomRect.top}px`,
              width: `${boxZoomRect.width}px`,
              height: `${boxZoomRect.height}px`
            }}
          />
        </div>
      ) : null}
      {measurementSegments.length > 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10">
          <svg className="absolute inset-0 h-full w-full">
            {measurementSegments.map((segment, index) => (
              <line
                key={`${segment.startX}-${segment.startY}-${segment.endX}-${segment.endY}-${index}`}
                x1={segment.startX}
                y1={segment.startY}
                x2={segment.endX}
                y2={segment.endY}
                stroke="#f97316"
                strokeWidth={3}
                strokeLinecap="round"
              />
            ))}
          </svg>
          {measurementSegments.map((segment, index) => (
            <button
              key={`${segment.centerX}-${segment.centerY}-${segment.distanceMeters}-${index}`}
              type="button"
              className={cn(
                TOOLTIP_PILL_CLASS_NAME,
                "absolute z-20 -translate-x-1/2 -translate-y-1/2 font-mono tabular-nums"
              )}
              style={{
                left: `${segment.centerX}px`,
                top: `${segment.centerY}px`
              }}
              onClick={() => onMeasurementDistanceCopy(segment.distanceMeters)}
              title="Copy distance"
            >
              {segment.label}
            </button>
          ))}
        </div>
      ) : null}
      {activeHoveredTooltip ? (
        <HoveredMarkerTooltips
          marker={activeHoveredTooltip.marker}
          visible={activeHoveredTooltip.visible}
          onCopy={activeHoveredTooltip.onCopy}
          onRemove={activeHoveredTooltip.onRemove}
          enableHoverCatch={activeHoveredTooltip.enableHoverCatch}
          onTooltipPointerEnter={() => setIsHoveredTooltipPinned(true)}
          onTooltipPointerLeave={() => setIsHoveredTooltipPinned(false)}
        />
      ) : null}
    </div>
  );
}
