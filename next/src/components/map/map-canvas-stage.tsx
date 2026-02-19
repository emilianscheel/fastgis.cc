"use client";

import type * as React from "react";

import type { BoxZoomRect } from "@/hooks/use-box-zoom-tool";

type MapCanvasStageProps = {
  stageRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasKey: number;
  cursorClassName: string;
  boxZoomRect: BoxZoomRect | null;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
};

export function MapCanvasStage({
  stageRef,
  canvasRef,
  canvasKey,
  cursorClassName,
  boxZoomRect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: MapCanvasStageProps) {
  return (
    <>
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
    </>
  );
}
