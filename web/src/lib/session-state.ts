import type { Trajectory } from "@/lib/trajectory";
import type { ResolvedOsmWay } from "@/lib/link-route";

export type LinkRoute = {
  kind: "links";
  id: string;
  name: string;
  linkIds: string[];
  ways: ResolvedOsmWay[];
  visible: boolean;
  csv: string;
};

export type RouteItem = Trajectory | LinkRoute;

const KEY = "trajectory-map-state";

export type SessionState = {
  routes: RouteItem[];
  camera?: {
    center: [number, number];
    zoom: number;
  };
};

export function readSessionState(): SessionState | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    if (!value) return null;
    const state = JSON.parse(value) as SessionState & { trajectories?: Trajectory[] };
    const storedRoutes = state.routes ?? state.trajectories?.map((trajectory) => ({ ...trajectory, kind: "trajectory" as const }));
    const routes = storedRoutes?.map((route) => route.kind === "trajectory"
      ? { ...route, colorMode: route.colorMode ?? "solid" as const }
      : route);
    return routes ? { ...state, routes } : null;
  } catch {
    return null;
  }
}

export function writeSessionState(state: SessionState) {
  window.sessionStorage.setItem(KEY, JSON.stringify(state));
}
