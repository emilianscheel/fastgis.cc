"use client";

import { useEffect } from "react";

type UseZoomShortcutsOptions = {
  enabled: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function isZoomInShortcut(event: KeyboardEvent): boolean {
  return event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+" || event.key === "=";
}

function isZoomOutShortcut(event: KeyboardEvent): boolean {
  return event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-" || event.key === "_";
}

export function useZoomShortcuts({ enabled, onZoomIn, onZoomOut }: UseZoomShortcutsOptions) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled) return;
      if (isEditableTarget(event.target)) return;
      if (event.altKey) return;

      const hasZoomModifier = event.ctrlKey || event.metaKey;
      if (!hasZoomModifier) return;

      if (isZoomInShortcut(event)) {
        event.preventDefault();
        onZoomIn();
        return;
      }

      if (isZoomOutShortcut(event)) {
        event.preventDefault();
        onZoomOut();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, onZoomIn, onZoomOut]);
}
