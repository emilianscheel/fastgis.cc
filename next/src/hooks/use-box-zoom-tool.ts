"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type PointerMessageType = "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP";
type ActiveTool = "pan" | "box-zoom" | "marker";
type BoxZoomDrag = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export type BoxZoomRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type UseBoxZoomToolOptions = {
  canInteract: boolean;
  minSelectionSizePx?: number;
  cancelWheelZoomAnimation: () => void;
  onPanPointerEvent: (
    type: PointerMessageType,
    x: number,
    y: number,
    button?: number
  ) => void;
  onZoomToBox: (
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ) => void;
  onPlaceMarker: (x: number, y: number) => void;
};

const DEFAULT_MIN_SELECTION_PX = 12;

export function useBoxZoomTool({
  canInteract,
  minSelectionSizePx = DEFAULT_MIN_SELECTION_PX,
  cancelWheelZoomAnimation,
  onPanPointerEvent,
  onZoomToBox,
  onPlaceMarker
}: UseBoxZoomToolOptions) {
  const [activeTool, setActiveTool] = useState<ActiveTool>("pan");
  const [boxZoomDrag, setBoxZoomDrag] = useState<BoxZoomDrag | null>(null);

  useEffect(() => {
    if (activeTool !== "box-zoom" && boxZoomDrag) {
      setBoxZoomDrag(null);
    }
  }, [activeTool, boxZoomDrag]);

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

  const handleCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) {
        return;
      }

      const { x, y } = withCanvasPoint(event);

      if (activeTool === "marker") {
        cancelWheelZoomAnimation();
        if (canInteract) {
          onPlaceMarker(x, y);
        }
        setActiveTool("pan");
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);

      if (activeTool === "box-zoom") {
        cancelWheelZoomAnimation();
        setBoxZoomDrag({
          startX: x,
          startY: y,
          currentX: x,
          currentY: y
        });
        return;
      }

      onPanPointerEvent("POINTER_DOWN", x, y, event.button);
    },
    [
      activeTool,
      cancelWheelZoomAnimation,
      canInteract,
      onPanPointerEvent,
      onPlaceMarker,
      withCanvasPoint
    ]
  );

  const handleCanvasPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = withCanvasPoint(event);

      if (activeTool === "box-zoom") {
        setBoxZoomDrag((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            currentX: x,
            currentY: y
          };
        });
        return;
      }

      onPanPointerEvent("POINTER_MOVE", x, y, event.button);
    },
    [activeTool, onPanPointerEvent, withCanvasPoint]
  );

  const handleCanvasPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const { x, y } = withCanvasPoint(event);

      if (activeTool === "box-zoom") {
        setBoxZoomDrag((current) => {
          if (!current) {
            return current;
          }

          const selectionWidth = Math.abs(x - current.startX);
          const selectionHeight = Math.abs(y - current.startY);

          if (
            canInteract &&
            selectionWidth >= minSelectionSizePx &&
            selectionHeight >= minSelectionSizePx
          ) {
            onZoomToBox(current.startX, current.startY, x, y);
          }

          return null;
        });
        return;
      }

      onPanPointerEvent("POINTER_UP", x, y, event.button);
    },
    [activeTool, canInteract, minSelectionSizePx, onPanPointerEvent, onZoomToBox, withCanvasPoint]
  );

  const handleCanvasPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeTool === "box-zoom") {
        cancelWheelZoomAnimation();
        setBoxZoomDrag(null);
        return;
      }

      const { x, y } = withCanvasPoint(event);
      onPanPointerEvent("POINTER_UP", x, y, event.button);
    },
    [activeTool, cancelWheelZoomAnimation, onPanPointerEvent, withCanvasPoint]
  );

  const boxZoomRect = useMemo<BoxZoomRect | null>(() => {
    if (!boxZoomDrag) {
      return null;
    }

    const left = Math.min(boxZoomDrag.startX, boxZoomDrag.currentX);
    const top = Math.min(boxZoomDrag.startY, boxZoomDrag.currentY);
    const width = Math.abs(boxZoomDrag.currentX - boxZoomDrag.startX);
    const height = Math.abs(boxZoomDrag.currentY - boxZoomDrag.startY);

    return { left, top, width, height };
  }, [boxZoomDrag]);

  const isBoxZoomActive = activeTool === "box-zoom";
  const isMarkerActive = activeTool === "marker";
  const canvasCursorClassName = isBoxZoomActive || isMarkerActive
    ? "cursor-crosshair"
    : "cursor-grab active:cursor-grabbing";

  const toggleBoxZoomTool = useCallback(() => {
    setActiveTool((current) => {
      const next = current === "box-zoom" ? "pan" : "box-zoom";
      if (next === "box-zoom") {
        cancelWheelZoomAnimation();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation]);

  const toggleMarkerTool = useCallback(() => {
    setActiveTool((current) => {
      const next = current === "marker" ? "pan" : "marker";
      if (next === "marker") {
        cancelWheelZoomAnimation();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation]);

  return {
    activeTool,
    isBoxZoomActive,
    isMarkerActive,
    boxZoomRect,
    canvasCursorClassName,
    toggleBoxZoomTool,
    toggleMarkerTool,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleCanvasPointerCancel
  };
}
