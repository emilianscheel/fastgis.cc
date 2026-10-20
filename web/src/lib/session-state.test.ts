import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

import { readSessionState, writeSessionState, type SessionState } from "./session-state";
import type { Trajectory } from "./trajectory";

const LEGACY_KEY = "trajectory-map-state";
const LIMIT = 5 * 1024 * 1024;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

class QuotaStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    const next = new Map(this.values).set(key, value);
    const bytes = [...next].reduce((total, [name, item]) => total + (name.length + item.length) * 2, 0);
    if (bytes > LIMIT) throw new DOMException("Storage is full", "QuotaExceededError");
    this.values = next;
  }
}

let storage: QuotaStorage;

beforeEach(() => {
  storage = new QuotaStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: storage, indexedDB: new IDBFactory() },
  });
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function route(index: number, count = 1): Trajectory {
  return {
    kind: "trajectory",
    id: `route-${index}`,
    name: `route-${index}.csv`,
    visible: true,
    color: "#2563eb",
    colorMode: "solid",
    points: Array.from({ length: count }, () => ({
      timestamp: "2026-10-20T10:00:00",
      latitude: "50.1109",
      longitude: "8.6821",
      coordinate: [8.6821, 50.1109],
      speed: 30,
      direction: 90,
    })),
    csv: "timestamp,latitude,longitude\n" + "2026-10-20T10:00:00,50.1109,8.6821\n".repeat(count),
  };
}

test("stores and restores dozens of trajectories exceeding the Web Storage quota", async () => {
  const state: SessionState = {
    routes: Array.from({ length: 30 }, (_, index) => route(index, 1200)),
    camera: { center: [8.6821, 50.1109], zoom: 10 },
  };
  expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeGreaterThan(LIMIT);
  expect(() => storage.setItem(LEGACY_KEY, JSON.stringify(state))).toThrow("Storage is full");

  await writeSessionState(state);
  expect(await readSessionState()).toEqual(state);
  expect(storage.length).toBe(1);
  expect(storage.getItem("trajectory-map-session")?.length).toBe(36);
});

test("camera-only updates never rewrite the route payload", async () => {
  await writeSessionState({ routes: [route(0)] });
  const put = spyOn(IDBObjectStore.prototype, "put");
  try {
    await writeSessionState({ camera: { center: [9, 51], zoom: 12 } });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toEndWith(":camera");
    expect(await readSessionState()).toEqual({
      routes: [route(0)],
      camera: { center: [9, 51], zoom: 12 },
    });
  } finally {
    put.mockRestore();
  }
});

test("migrates legacy trajectories without removing them before a successful save", async () => {
  const { kind, colorMode, ...legacyRoute } = route(0);
  const camera: SessionState["camera"] = { center: [9, 51], zoom: 12 };
  storage.setItem(LEGACY_KEY, JSON.stringify({ trajectories: [legacyRoute], camera }));
  const restored = await readSessionState();
  expect(restored?.routes).toEqual([{ ...legacyRoute, kind, colorMode }]);
  expect(storage.getItem(LEGACY_KEY)).not.toBeNull();

  await writeSessionState({ routes: restored!.routes, camera });
  expect(storage.getItem(LEGACY_KEY)).toBeNull();
  expect(await readSessionState()).toEqual({ routes: [route(0)], camera });
});

test("a quota failure preserves legacy data and previously saved routes, then permits retry", async () => {
  const original: SessionState = { routes: [route(0)], camera: { center: [8, 50], zoom: 3 } };
  await writeSessionState(original);
  storage.setItem(LEGACY_KEY, JSON.stringify(original));
  const originalPut = IDBObjectStore.prototype.put;
  const put = spyOn(IDBObjectStore.prototype, "put")
    .mockImplementationOnce(originalPut)
    .mockImplementationOnce(() => {
      throw new DOMException("Database quota exceeded", "QuotaExceededError");
    });
  try {
    await expect(writeSessionState({ ...original, routes: [route(1)] })).rejects.toThrow("Database quota exceeded");
    expect(storage.getItem(LEGACY_KEY)).not.toBeNull();
  } finally {
    put.mockRestore();
  }
  storage.removeItem(LEGACY_KEY);
  expect(await readSessionState()).toEqual(original);
  await writeSessionState({ ...original, routes: [route(2)] });
  expect((await readSessionState())?.routes).toEqual([route(2)]);
});

test("rapid saves remain ordered and deleting all routes persists an empty collection", async () => {
  await Promise.all([
    writeSessionState({ routes: [route(0)] }),
    writeSessionState({ routes: [route(0), route(1)] }),
    writeSessionState({ routes: [] }),
  ]);
  expect((await readSessionState())?.routes).toEqual([]);
});

test("new tabs start empty without overwriting another tab's routes", async () => {
  await writeSessionState({ routes: [route(0)] });
  const firstTab = storage.getItem("trajectory-map-session")!;
  storage.clear();
  expect(await readSessionState()).toBeNull();
  await writeSessionState({ routes: [route(1)] });
  storage.setItem("trajectory-map-session", firstTab);
  expect((await readSessionState())?.routes).toEqual([route(0)]);
});

test("unavailable IndexedDB is reported while legacy routes can still be read", async () => {
  Object.defineProperty(window, "indexedDB", {
    get() { throw new DOMException("Storage access denied", "SecurityError"); },
  });
  await expect(readSessionState()).rejects.toThrow("Storage access denied");
  storage.setItem(LEGACY_KEY, JSON.stringify({ routes: [route(0)] }));
  expect((await readSessionState())?.routes).toEqual([route(0)]);
});
