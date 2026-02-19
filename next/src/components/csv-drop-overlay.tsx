"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

type CsvDropOverlayProps = {
  enabled: boolean;
  onDropFiles: (files: File[]) => void | Promise<void>;
};

function isFileDragEvent(event: DragEvent): boolean {
  const dataTransferTypes = event.dataTransfer?.types;
  if (!dataTransferTypes) return false;
  return Array.from(dataTransferTypes).includes("Files");
}

export function CsvDropOverlay({ enabled, onDropFiles }: CsvDropOverlayProps) {
  const dragDepthRef = useRef(0);
  const [isDragOverPage, setIsDragOverPage] = useState(false);

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (!isFileDragEvent(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOverPage(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!isFileDragEvent(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      }
      setIsDragOverPage(true);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!isFileDragEvent(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOverPage(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!isFileDragEvent(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOverPage(false);
      if (!enabled) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      void onDropFiles(files);
    };

    const resetDragState = () => {
      dragDepthRef.current = 0;
      setIsDragOverPage(false);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", resetDragState);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", resetDragState);
    };
  }, [enabled, onDropFiles]);

  if (!isDragOverPage) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-white/95">
      <div className="flex flex-col items-center gap-4">
        <Upload className="h-11 w-11 text-neutral-500" aria-hidden="true" />
        <p className="text-2xl font-medium text-neutral-500">Drop any file here to view it on the map</p>
      </div>
    </div>
  );
}
