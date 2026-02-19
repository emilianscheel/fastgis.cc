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
    ? `WGS84 ${markerHover.lat.toFixed(6)}, ${markerHover.lon.toFixed(6)}`
    : null;

  return (
    <>
      <div ref={stageRef} className="absolute inset-0" onPointerLeave={onPointerLeave}>
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
          <button
            type="button"
            data-marker-hover-pill="true"
            className="pointer-events-auto absolute -translate-x-1/2 -translate-y-full rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] leading-none text-slate-700 shadow-sm"
            style={{
              left: `${markerHover.screenX}px`,
              top: `${markerHover.screenY}px`
            }}
            onClick={() => onMarkerHoverCopy(markerHover)}
            title="Copy WGS84 coordinates"
          >
            {markerLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
