import type { Trajectory } from "@/lib/trajectory";

const KEY = "trajectory-map-state";

export type SessionState = {
  trajectories: Trajectory[];
  camera?: {
    center: [number, number];
    zoom: number;
  };
};

export function readSessionState(): SessionState | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value ? (JSON.parse(value) as SessionState) : null;
  } catch {
    return null;
  }
}

export function writeSessionState(state: SessionState) {
  window.sessionStorage.setItem(KEY, JSON.stringify(state));
}
