"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type PointerMessageType = "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP";
type InteractionTool = "pan" | "marker" | "measure";
type ZoomTool = "default" | "box-zoom" | "zoom-in" | "zoom-out";
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
  onHoverPoint: (x: number, y: number) => void;
  onHoverClear: () => void;
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
  onClickZoom: (direction: "in" | "out", x: number, y: number) => void;
  onPlaceMarker: (x: number, y: number) => void;
  onPlaceMeasurement: (x: number, y: number) => void;
};

const DEFAULT_MIN_SELECTION_PX = 12;

export function useBoxZoomTool({
  canInteract,
  minSelectionSizePx = DEFAULT_MIN_SELECTION_PX,
  cancelWheelZoomAnimation,
  onHoverPoint,
  onHoverClear,
  onPanPointerEvent,
  onZoomToBox,
  onClickZoom,
  onPlaceMarker,
  onPlaceMeasurement
}: UseBoxZoomToolOptions) {
  const [interactionTool, setInteractionTool] = useState<InteractionTool>("pan");
  const [zoomTool, setZoomTool] = useState<ZoomTool>("default");
  const [boxZoomDrag, setBoxZoomDrag] = useState<BoxZoomDrag | null>(null);

  useEffect(() => {
    if (zoomTool !== "box-zoom" && boxZoomDrag) {
      setBoxZoomDrag(null);
    }
  }, [boxZoomDrag, zoomTool]);

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

      if (zoomTool === "box-zoom") {
        event.currentTarget.setPointerCapture(event.pointerId);
        cancelWheelZoomAnimation();
        onHoverClear();
        setBoxZoomDrag({
          startX: x,
          startY: y,
          currentX: x,
          currentY: y
        });
        return;
      }
      if (zoomTool === "zoom-in" || zoomTool === "zoom-out") {
        cancelWheelZoomAnimation();
        onHoverClear();
        if (canInteract) {
          onClickZoom(zoomTool === "zoom-in" ? "in" : "out", x, y);
        }
        return;
      }

      if (interactionTool === "measure") {
        cancelWheelZoomAnimation();
        onHoverClear();
        if (canInteract) {
          onPlaceMeasurement(x, y);
        }
        return;
      }

      onHoverPoint(x, y);

      if (interactionTool === "marker") {
        cancelWheelZoomAnimation();
        onHoverClear();
        if (canInteract) {
          onPlaceMarker(x, y);
        }
        setInteractionTool("pan");
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);

      onPanPointerEvent("POINTER_DOWN", x, y, event.button);
    },
    [
      cancelWheelZoomAnimation,
      canInteract,
      interactionTool,
      onHoverClear,
      onHoverPoint,
      onPlaceMeasurement,
      onPanPointerEvent,
      onClickZoom,
      onPlaceMarker,
      withCanvasPoint,
      zoomTool
    ]
  );

  const handleCanvasPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = withCanvasPoint(event);

      if (zoomTool === "box-zoom") {
        onHoverClear();
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
      if (zoomTool === "zoom-in" || zoomTool === "zoom-out") {
        onHoverPoint(x, y);
        return;
      }

      if (interactionTool === "measure") {
        onHoverPoint(x, y);
        return;
      }

      onHoverPoint(x, y);
      onPanPointerEvent("POINTER_MOVE", x, y, event.button);
    },
    [interactionTool, onHoverClear, onHoverPoint, onPanPointerEvent, withCanvasPoint, zoomTool]
  );

  const handleCanvasPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const { x, y } = withCanvasPoint(event);

      if (zoomTool === "box-zoom") {
        onHoverClear();
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
      if (zoomTool === "zoom-in" || zoomTool === "zoom-out") {
        onHoverPoint(x, y);
        return;
      }

      if (interactionTool === "measure") {
        return;
      }

      onHoverPoint(x, y);
      onPanPointerEvent("POINTER_UP", x, y, event.button);
    },
    [
      canInteract,
      interactionTool,
      minSelectionSizePx,
      onHoverClear,
      onHoverPoint,
      onPanPointerEvent,
      onZoomToBox,
      withCanvasPoint,
      zoomTool
    ]
  );

  const handleCanvasPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      onHoverClear();
      if (zoomTool === "box-zoom") {
        cancelWheelZoomAnimation();
        setBoxZoomDrag(null);
        return;
      }
      if (zoomTool === "zoom-in" || zoomTool === "zoom-out") {
        return;
      }

      if (interactionTool === "measure") {
        return;
      }

      const { x, y } = withCanvasPoint(event);
      onPanPointerEvent("POINTER_UP", x, y, event.button);
    },
    [cancelWheelZoomAnimation, interactionTool, onHoverClear, onPanPointerEvent, withCanvasPoint, zoomTool]
  );

  const handleCanvasPointerLeave = useCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      onHoverClear();
    },
    [onHoverClear]
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

  const isBoxZoomActive = zoomTool === "box-zoom";
  const isZoomInToolActive = zoomTool === "zoom-in";
  const isZoomOutToolActive = zoomTool === "zoom-out";
  const isMarkerActive = interactionTool === "marker";
  const isMeasurementActive = interactionTool === "measure";
  const canvasCursorClassName =
    zoomTool === "zoom-in"
      ? "cursor-zoom-in"
      : zoomTool === "zoom-out"
        ? "cursor-zoom-out"
        : isBoxZoomActive || isMarkerActive || isMeasurementActive
          ? "cursor-crosshair"
          : "cursor-grab active:cursor-grabbing";

  const toggleBoxZoomTool = useCallback(() => {
    setZoomTool((current) => {
      const next = current === "box-zoom" ? "default" : "box-zoom";
      if (next === "box-zoom") {
        cancelWheelZoomAnimation();
        onHoverClear();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation, onHoverClear]);

  const toggleMarkerTool = useCallback(() => {
    setInteractionTool((current) => {
      const next = current === "marker" ? "pan" : "marker";
      if (next === "marker") {
        cancelWheelZoomAnimation();
        onHoverClear();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation, onHoverClear]);

  const toggleMeasurementTool = useCallback(() => {
    setInteractionTool((current) => {
      const next = current === "measure" ? "pan" : "measure";
      if (next === "measure") {
        cancelWheelZoomAnimation();
        onHoverClear();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation, onHoverClear]);

  const toggleZoomInTool = useCallback(() => {
    setZoomTool((current) => {
      const next = current === "zoom-in" ? "default" : "zoom-in";
      if (next === "zoom-in") {
        cancelWheelZoomAnimation();
        onHoverClear();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation, onHoverClear]);

  const toggleZoomOutTool = useCallback(() => {
    setZoomTool((current) => {
      const next = current === "zoom-out" ? "default" : "zoom-out";
      if (next === "zoom-out") {
        cancelWheelZoomAnimation();
        onHoverClear();
      }
      return next;
    });
  }, [cancelWheelZoomAnimation, onHoverClear]);

  return {
    interactionTool,
    zoomTool,
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
  };
}
