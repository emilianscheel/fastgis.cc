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
const SESSION_KEY = "trajectory-map-session";
const DATABASE = "trajectory-map";
const STORE = "sessions";

export type SessionState = {
  routes: RouteItem[];
  camera?: {
    center: [number, number];
    zoom: number;
  };
};

function sessionId() {
  let id = window.sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Browser storage is blocked by another tab. Close other fastgis.cc tabs and retry."));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed."));
  });
}

export async function readSessionState(): Promise<SessionState | null> {
  // Keep legacy routes usable even if the database is unavailable or full.
  const legacy = window.sessionStorage.getItem(KEY);
  if (legacy) {
    const state = normalizeState(JSON.parse(legacy));
    if (!state) throw new Error("The saved trajectory session is invalid.");
    return state;
  }
  const id = sessionId();
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    const routes = store.get(`${id}:routes`);
    const camera = store.get(`${id}:camera`);
    await done;
    return routes.result ? normalizeState({ routes: routes.result, camera: camera.result }) : null;
  } finally {
    database.close();
  }
}

function normalizeState(state: SessionState & { trajectories?: Trajectory[] }): SessionState | null {
  const storedRoutes = state.routes ?? state.trajectories?.map((trajectory) => ({ ...trajectory, kind: "trajectory" as const }));
  const routes = storedRoutes?.map((route) => route.kind === "trajectory"
    ? { ...route, colorMode: route.colorMode ?? "solid" as const }
    : route);
  return routes ? { ...state, routes } : null;
}

let pendingWrite: Promise<void> = Promise.resolve();

export function writeSessionState(state: Partial<SessionState>): Promise<void> {
  // Keep rapid updates ordered, but let a later save retry after a failed one.
  pendingWrite = pendingWrite.then(() => saveState(state), () => saveState(state));
  return pendingWrite;
}

async function saveState(state: Partial<SessionState>): Promise<void> {
  const id = sessionId();
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    try {
      if (state.routes !== undefined) store.put(state.routes, `${id}:routes`);
      if (state.camera !== undefined) store.put(state.camera, `${id}:camera`);
    } catch (error) {
      transaction.abort();
      await done.catch(() => { /* Report the original write error below. */ });
      throw error;
    }
    await done;
    if (state.routes !== undefined && state.camera !== undefined) {
      window.sessionStorage.removeItem(KEY);
    }
  } finally {
    database.close();
  }
}
