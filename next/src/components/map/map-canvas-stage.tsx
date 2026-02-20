"use client";

import type * as React from "react";

import type { BoxZoomRect } from "@/hooks/use-box-zoom-tool";
import type { MarkerHover } from "@/lib/map-protocol";

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

type MapCanvasStageProps = {
  stageRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasKey: number;
  cursorClassName: string;
  boxZoomRect: BoxZoomRect | null;
  markerHover: MarkerHover | null;
  isMeasurementActive: boolean;
  measurementSegments: MeasurementSegmentOverlay[];
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMarkerHoverCopy: (marker: MarkerHover) => void;
  onMeasurementDistanceCopy: (distanceMeters: number) => void;
};

const MARKER_TOOLTIP_BRIDGE_WIDTH_PX = 120;
const MARKER_TOOLTIP_BRIDGE_HEIGHT_PX = 18;
const MARKER_PILL_CLASS_NAME =
  "pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-full rounded-full border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] leading-none text-slate-700 shadow-sm tabular-nums";

export function MapCanvasStage({
  stageRef,
  canvasRef,
  canvasKey,
  cursorClassName,
  boxZoomRect,
  markerHover,
  isMeasurementActive,
  measurementSegments,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onMarkerHoverCopy,
  onMeasurementDistanceCopy
}: MapCanvasStageProps) {
  const markerLabel = markerHover
    ? `${markerHover.lat.toFixed(3)}, ${markerHover.lon.toFixed(3)}`
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
      {markerHover && markerLabel ? (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            data-marker-hover-bridge="true"
            aria-hidden="true"
            className="pointer-events-auto absolute z-0 -translate-x-1/2"
            style={{
              left: `${markerHover.screenX}px`,
              top: `${markerHover.screenY}px`,
              width: `${MARKER_TOOLTIP_BRIDGE_WIDTH_PX}px`,
              height: `${MARKER_TOOLTIP_BRIDGE_HEIGHT_PX}px`,
              clipPath: "polygon(0 0, 100% 0, 50% 100%)"
            }}
          />
          <button
            type="button"
            data-marker-hover-pill="true"
            className={MARKER_PILL_CLASS_NAME}
            style={{
              left: `${markerHover.screenX}px`,
              top: `${markerHover.screenY}px`
            }}
            onClick={() => onMarkerHoverCopy(markerHover)}
            title="Copy coordinates"
          >
            {markerLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
