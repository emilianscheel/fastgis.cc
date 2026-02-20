"use client";

import type * as React from "react";
import { useEffect, useMemo, useState } from "react";

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
  onMarkerHoverCopy: (marker: MarkerHover) => void;
  onMarkerHoverRemove: (marker: { lat: number; lon: number }) => void;
  onMeasurementMarkerCopy: (marker: { lat: number; lon: number }) => void;
  onRemoveMeasurementMarker: (index: number) => void;
  onMeasurementDistanceCopy: (distanceMeters: number) => void;
};

const MARKER_TOOLTIP_BRIDGE_WIDTH_PX = 120;
const MARKER_TOOLTIP_BRIDGE_HEIGHT_PX = 18;
const MARKER_TOOLTIP_TRANSITION_MS = 180;
const RULER_MARKER_COORDS_TOOLTIP_OFFSET_Y_PX = 26;
const RULER_MARKER_REMOVE_TOOLTIP_OFFSET_Y_PX = 10;
const RULER_MARKER_REMOVE_BRIDGE_OFFSET_Y_PX = 2;
const MARKER_HOVER_REMOVE_TOOLTIP_FROM_ANCHOR_PX = 26;
const MARKER_HOVER_REMOVE_BRIDGE_FROM_ANCHOR_PX = 0;
const MARKER_HOVER_REMOVE_BRIDGE_WIDTH_PX = 184;
const MARKER_HOVER_REMOVE_BRIDGE_HEIGHT_PX = 28;
const MARKER_HOVER_REMOVE_CATCH_FROM_ANCHOR_PX = 0;
const MARKER_HOVER_REMOVE_CATCH_WIDTH_PX = 220;
const MARKER_HOVER_REMOVE_CATCH_HEIGHT_PX = 42;
const MARKER_PILL_CLASS_NAME =
  "pointer-events-auto rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] leading-none text-slate-700 shadow-sm";
const TOOLTIP_ANIMATION_CLASS_NAME = "transition-all duration-200 ease-out";

function useTooltipPresence<T>(value: T | null) {
  const [renderValue, setRenderValue] = useState<T | null>(value);
  const [isVisible, setIsVisible] = useState<boolean>(Boolean(value));

  useEffect(() => {
    if (value) {
      setRenderValue(value);
      setIsVisible(false);
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsVisible(false);
    const timeoutId = window.setTimeout(() => {
      setRenderValue(null);
    }, MARKER_TOOLTIP_TRANSITION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [value]);

  return { renderValue, isVisible };
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
  const hoveredMeasurementMarker = useMemo<MeasurementMarkerOverlay | null>(() => {
    if (hoveredMeasurementMarkerIndex === null) {
      return null;
    }

    return measurementMarkers.find((marker) => marker.index === hoveredMeasurementMarkerIndex) ?? null;
  }, [hoveredMeasurementMarkerIndex, measurementMarkers]);

  const { renderValue: markerTooltipMarker, isVisible: isMarkerTooltipVisible } = useTooltipPresence<
    MarkerHover
  >(!isMeasurementActive ? markerHover : null);
  const { renderValue: rulerTooltipMarker, isVisible: isRulerTooltipVisible } = useTooltipPresence<
    MeasurementMarkerOverlay
  >(isMeasurementActive ? hoveredMeasurementMarker : null);

  const markerLabel = markerTooltipMarker
    ? `${markerTooltipMarker.lat.toFixed(3)}, ${markerTooltipMarker.lon.toFixed(3)}`
    : null;
  const rulerMarkerLabel = rulerTooltipMarker
    ? `${rulerTooltipMarker.lat.toFixed(3)}, ${rulerTooltipMarker.lon.toFixed(3)}`
    : null;

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
              className="pointer-events-auto absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] leading-none text-slate-700 shadow-sm tabular-nums"
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
      {rulerTooltipMarker && rulerMarkerLabel ? (
        <div className="pointer-events-none absolute inset-0 z-20">
          <div
            key={`measurement-marker-coords-bridge-${rulerTooltipMarker.index}`}
            aria-hidden="true"
            className={cn(
              "pointer-events-auto absolute z-0 -translate-x-1/2",
              TOOLTIP_ANIMATION_CLASS_NAME,
              isRulerTooltipVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
            style={{
              left: `${rulerTooltipMarker.screenX}px`,
              top: `${rulerTooltipMarker.screenY - RULER_MARKER_COORDS_TOOLTIP_OFFSET_Y_PX}px`,
              width: `${MARKER_TOOLTIP_BRIDGE_WIDTH_PX}px`,
              height: `${MARKER_TOOLTIP_BRIDGE_HEIGHT_PX}px`,
              clipPath: "polygon(0 0, 100% 0, 50% 100%)"
            }}
          />
          <div
            key={`measurement-marker-coords-${rulerTooltipMarker.index}`}
            className="absolute z-10 -translate-x-1/2"
            style={{
              left: `${rulerTooltipMarker.screenX}px`,
              top: `${rulerTooltipMarker.screenY - RULER_MARKER_COORDS_TOOLTIP_OFFSET_Y_PX}px`
            }}
          >
            <button
              type="button"
              className={cn(
                MARKER_PILL_CLASS_NAME,
                "font-mono tabular-nums",
                TOOLTIP_ANIMATION_CLASS_NAME,
                isRulerTooltipVisible
                  ? "opacity-100 translate-y-0"
                  : "pointer-events-none opacity-0 translate-y-2"
              )}
              onClick={() => onMeasurementMarkerCopy(rulerTooltipMarker)}
              title="Copy coordinates"
            >
              {rulerMarkerLabel}
            </button>
          </div>
          <div
            key={`measurement-marker-remove-bridge-${rulerTooltipMarker.index}`}
            aria-hidden="true"
            className={cn(
              "pointer-events-auto absolute z-0 -translate-x-1/2",
              TOOLTIP_ANIMATION_CLASS_NAME,
              isRulerTooltipVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
            )}
            style={{
              left: `${rulerTooltipMarker.screenX}px`,
              top: `${rulerTooltipMarker.screenY + RULER_MARKER_REMOVE_BRIDGE_OFFSET_Y_PX}px`,
              width: `${MARKER_TOOLTIP_BRIDGE_WIDTH_PX}px`,
              height: `${MARKER_TOOLTIP_BRIDGE_HEIGHT_PX}px`,
              clipPath: "polygon(50% 0, 0 100%, 100% 100%)"
            }}
          >
            <span />
          </div>
          <div
            key={`measurement-marker-remove-${rulerTooltipMarker.index}`}
            className="absolute z-10 -translate-x-1/2"
            style={{
              left: `${rulerTooltipMarker.screenX}px`,
              top: `${rulerTooltipMarker.screenY + RULER_MARKER_REMOVE_TOOLTIP_OFFSET_Y_PX}px`
            }}
          >
            <button
              type="button"
              className={cn(
                MARKER_PILL_CLASS_NAME,
                TOOLTIP_ANIMATION_CLASS_NAME,
                isRulerTooltipVisible
                  ? "opacity-100 translate-y-0"
                  : "pointer-events-none opacity-0 -translate-y-2"
              )}
              onClick={() => onRemoveMeasurementMarker(rulerTooltipMarker.index)}
              title="Remove marker"
            >
              remove
            </button>
          </div>
        </div>
      ) : null}
      {markerTooltipMarker && markerLabel ? (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            data-marker-hover-bridge="true"
            aria-hidden="true"
            className={cn(
              "pointer-events-auto absolute z-0 -translate-x-1/2",
              TOOLTIP_ANIMATION_CLASS_NAME,
              isMarkerTooltipVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
            style={{
              left: `${markerTooltipMarker.screenX}px`,
              top: `${markerTooltipMarker.screenY}px`,
              width: `${MARKER_TOOLTIP_BRIDGE_WIDTH_PX}px`,
              height: `${MARKER_TOOLTIP_BRIDGE_HEIGHT_PX}px`,
              clipPath: "polygon(0 0, 100% 0, 50% 100%)"
            }}
          />
          <div
            className="absolute z-10 -translate-x-1/2 -translate-y-full"
            style={{
              left: `${markerTooltipMarker.screenX}px`,
              top: `${markerTooltipMarker.screenY}px`
            }}
          >
            <button
              type="button"
              data-marker-hover-pill="true"
              className={cn(
                MARKER_PILL_CLASS_NAME,
                "font-mono tabular-nums",
                TOOLTIP_ANIMATION_CLASS_NAME,
                isMarkerTooltipVisible
                  ? "opacity-100 translate-y-0"
                  : "pointer-events-none opacity-0 translate-y-2"
              )}
              onClick={() => onMarkerHoverCopy(markerTooltipMarker)}
              title="Copy coordinates"
            >
              {markerLabel}
            </button>
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-auto absolute z-0 -translate-x-1/2",
              "transition-opacity duration-100 ease-out",
              isMarkerTooltipVisible ? "opacity-100" : "opacity-0"
            )}
            style={{
              left: `${markerTooltipMarker.screenX}px`,
              top: `${markerTooltipMarker.screenY + MARKER_HOVER_REMOVE_BRIDGE_FROM_ANCHOR_PX}px`,
              width: `${MARKER_HOVER_REMOVE_BRIDGE_WIDTH_PX}px`,
              height: `${MARKER_HOVER_REMOVE_BRIDGE_HEIGHT_PX}px`,
              clipPath: "polygon(50% 0, 0 100%, 100% 100%)"
            }}
          >
            <span />
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "absolute z-[5] -translate-x-1/2",
              isMarkerTooltipVisible ? "pointer-events-auto" : "pointer-events-none"
            )}
            style={{
              left: `${markerTooltipMarker.screenX}px`,
              top: `${markerTooltipMarker.screenY + MARKER_HOVER_REMOVE_CATCH_FROM_ANCHOR_PX}px`,
              width: `${MARKER_HOVER_REMOVE_CATCH_WIDTH_PX}px`,
              height: `${MARKER_HOVER_REMOVE_CATCH_HEIGHT_PX}px`
            }}
          />
          <div
            className="absolute z-10 -translate-x-1/2"
            style={{
              left: `${markerTooltipMarker.screenX}px`,
              top: `${markerTooltipMarker.screenY + MARKER_HOVER_REMOVE_TOOLTIP_FROM_ANCHOR_PX}px`
            }}
          >
            <button
              type="button"
              className={cn(
                MARKER_PILL_CLASS_NAME,
                TOOLTIP_ANIMATION_CLASS_NAME,
                isMarkerTooltipVisible
                  ? "opacity-100 translate-y-0"
                  : "pointer-events-none opacity-0 -translate-y-2"
              )}
              onClick={() =>
                onMarkerHoverRemove({
                  lat: markerTooltipMarker.lat,
                  lon: markerTooltipMarker.lon
                })
              }
              title="Remove marker"
            >
              remove
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
