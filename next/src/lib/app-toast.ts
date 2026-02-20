import { createElement, type ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";

type AppToastOptions = ExternalToast;

const DEFAULT_TOAST_DURATION_MS = 2400;
const COPY_COORDINATES_TOAST_ID = "marker-copy-coordinates";

function withDefaults(options?: AppToastOptions): AppToastOptions {
  return {
    duration: DEFAULT_TOAST_DURATION_MS,
    ...options
  };
}

function formatCoordinateValue(value: number): string {
  return value.toFixed(3);
}

function copiedCoordinatesContent(coordinates: string): ReactNode {
  return createElement(
    "span",
    { className: "inline-flex items-baseline gap-1" },
    "Copied ",
    createElement("span", { className: "font-mono tabular-nums" }, coordinates),
    " coordinates to clipboard"
  );
}

function showToast(message: ReactNode, options?: AppToastOptions) {
  return toast(message, withDefaults(options));
}

export const appToast = {
  show(message: ReactNode, options?: AppToastOptions) {
    return showToast(message, options);
  },
  success(message: ReactNode, options?: AppToastOptions) {
    return toast.success(message, withDefaults(options));
  },
  error(message: ReactNode, options?: AppToastOptions) {
    return toast.error(message, withDefaults(options));
  },
  copiedCoordinates(lat: number, lon: number, options?: AppToastOptions) {
    const coordinates = `${formatCoordinateValue(lat)}, ${formatCoordinateValue(lon)}`;
    return showToast(copiedCoordinatesContent(coordinates), {
      id: COPY_COORDINATES_TOAST_ID,
      ...options
    });
  }
};
