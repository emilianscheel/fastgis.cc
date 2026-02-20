"use client";

import type * as React from "react";

import type { BoxZoomRect } from "@/hooks/use-box-zoom-tool";
import type { MarkerHover } from "@/lib/map-protocol";

type MapCanvasStageProps = {
  stageRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasKey: number;
  cursorClassName: string;
  boxZoomRect: BoxZoomRect | null;
  markerHover: MarkerHover | null;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMarkerHoverCopy: (marker: MarkerHover) => void;
};

const MARKER_TOOLTIP_BRIDGE_WIDTH_PX = 120;
const MARKER_TOOLTIP_BRIDGE_HEIGHT_PX = 18;

export function MapCanvasStage({
  stageRef,
  canvasRef,
  canvasKey,
  cursorClassName,
  boxZoomRect,
  markerHover,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onMarkerHoverCopy
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
            className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-full rounded-full border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] leading-none text-slate-700 shadow-sm tabular-nums"
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
