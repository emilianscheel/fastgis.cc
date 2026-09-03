"use client";

import * as maplibregl from "maplibre-gl";
import { Button } from "@base-ui/react/button";
import { Eye, EyeOff, Ruler, Trash2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type { DragEvent, MutableRefObject } from "react";
import type { FeatureCollection, LineString } from "geojson";

import { readSessionState, writeSessionState } from "@/lib/session-state";
import { parseTrajectoryCsv, trajectoryColor, type Coordinate, type Trajectory } from "@/lib/trajectory";

const LIGHT_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const DARK_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
const TRAJECTORY_SOURCE = "trajectories";
const MEASUREMENT_SOURCE = "measurement";

export function MapView() {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const trajectoriesRef = useRef<Trajectory[]>([]);
  const measurementEnabledRef = useRef(false);
  const measurementPointsRef = useRef<Coordinate[]>([]);
  const cameraRef = useRef({ center: [8.6821, 50.1109] as [number, number], zoom: 3.1 });
  const restoredSessionRef = useRef(false);
  const [trajectories, setTrajectories] = useState<Trajectory[]>([]);
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurementPoints, setMeasurementPoints] = useState<Coordinate[]>([]);
  const [cursorPoint, setCursorPoint] = useState<Coordinate | null>(null);
  const styleUrl = resolvedTheme === "dark" ? DARK_STYLE_URL : LIGHT_STYLE_URL;

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      if (!restoredSessionRef.current) {
        const stored = readSessionState();
        if (stored) {
          trajectoriesRef.current = stored.trajectories;
          setTrajectories(stored.trajectories);
          if (stored.camera) cameraRef.current = stored.camera;
        }
        restoredSessionRef.current = true;
      }

      if (!containerRef.current) return;
      maplibregl.setWorkerUrl(WORKER_URL);
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl,
        center: cameraRef.current.center,
        zoom: cameraRef.current.zoom,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => syncTrajectories(map, trajectoriesRef.current));
      map.on("moveend", () => {
        const center = map.getCenter();
        cameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
        persist(map, trajectoriesRef.current);
      });
      map.on("click", (event) => {
        if (!measurementEnabledRef.current) return;
        setMeasurementPoints((points) => [...points, [event.lngLat.lng, event.lngLat.lat]]);
        setCursorPoint(null);
      });
      map.on("mousemove", (event) => {
        if (measurementEnabledRef.current && measurementPointsRef.current.length > 0) {
          setCursorPoint([event.lngLat.lng, event.lngLat.lat]);
        }
      });
      mapRef.current = map;
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  useEffect(() => {
    trajectoriesRef.current = trajectories;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    syncTrajectories(map, trajectories);
    persist(map, trajectories);
  }, [trajectories]);

  useEffect(() => {
    const map = mapRef.current;
    measurementEnabledRef.current = measurementEnabled;
    measurementPointsRef.current = measurementPoints;
    if (!map?.isStyleLoaded()) return;
    map.getCanvas().style.cursor = measurementEnabled ? "crosshair" : "";
    if (measurementEnabled) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    const coordinates = cursorPoint ? [...measurementPoints, cursorPoint] : measurementPoints;
    syncMeasurement(map, markerRef, coordinates);
  }, [cursorPoint, measurementEnabled, measurementPoints]);

  async function importFiles(files: File[]) {
    const imported = (await Promise.all(files.map(async (file) => ({
      name: file.name,
      coordinates: parseTrajectoryCsv(await file.text()),
    })))).filter((file): file is { name: string; coordinates: Coordinate[] } => file.coordinates !== null);

    if (imported.length === 0) return;
    setTrajectories((current) => {
      const next = [...current, ...imported.map((file, index) => ({
        id: crypto.randomUUID(),
        name: file.name,
        coordinates: file.coordinates,
        visible: true,
        color: trajectoryColor(current.length + index),
      }))];
      const map = mapRef.current;
      if (map) fitTrajectories(map, next);
      return next;
    });
  }

  return (
    <main
      className="map-root"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="map" ref={containerRef} />
      <Button
        aria-label="Measure distance"
        aria-pressed={measurementEnabled}
        className="measure-button"
        onClick={() => {
          setMeasurementEnabled((enabled) => !enabled);
          setMeasurementPoints([]);
          setCursorPoint(null);
        }}
        type="button"
      >
        <Ruler size={18} />
      </Button>
      {trajectories.length > 0 && (
        <aside className="trajectory-card">
          {trajectories.map((trajectory) => (
            <div className="trajectory-row" key={trajectory.id}>
              <span className="trajectory-name" title={trajectory.name}>{trajectory.name}</span>
              <Button
                aria-label={trajectory.visible ? `Hide ${trajectory.name}` : `Show ${trajectory.name}`}
                className="icon-button"
                onClick={() => setTrajectories((current) => current.map((item) =>
                  item.id === trajectory.id ? { ...item, visible: !item.visible } : item,
                ))}
                type="button"
              >
                {trajectory.visible ? <Eye size={16} /> : <EyeOff size={16} />}
              </Button>
              <Button
                aria-label={`Delete ${trajectory.name}`}
                className="icon-button"
                onClick={() => setTrajectories((current) => current.filter((item) => item.id !== trajectory.id))}
                type="button"
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </aside>
      )}
    </main>
  );
}

function persist(map: maplibregl.Map, trajectories: Trajectory[]) {
  const center = map.getCenter();
  writeSessionState({ trajectories, camera: { center: [center.lng, center.lat], zoom: map.getZoom() } });
}

function syncTrajectories(map: maplibregl.Map, trajectories: Trajectory[]) {
  const data: FeatureCollection<LineString, { color: string }> = {
    type: "FeatureCollection",
    features: trajectories.filter((trajectory) => trajectory.visible).map((trajectory) => ({
      type: "Feature",
      properties: { color: trajectory.color },
      geometry: { type: "LineString", coordinates: trajectory.coordinates },
    })),
  };
  const source = map.getSource(TRAJECTORY_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else {
    map.addSource(TRAJECTORY_SOURCE, { type: "geojson", data });
    map.addLayer({
      id: "trajectory-lines",
      type: "line",
      source: TRAJECTORY_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.9 },
    });
  }
}

function syncMeasurement(
  map: maplibregl.Map,
  markerRef: MutableRefObject<maplibregl.Marker | null>,
  coordinates: Coordinate[],
) {
  const data: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: coordinates.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] : [],
  };
  const source = map.getSource(MEASUREMENT_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else {
    map.addSource(MEASUREMENT_SOURCE, { type: "geojson", data });
    map.addLayer({
      id: "measurement-line",
      type: "line",
      source: MEASUREMENT_SOURCE,
      paint: { "line-color": "#52525b", "line-width": 3, "line-dasharray": [1.5, 1.5] },
    });
  }

  if (coordinates.length < 2) {
    markerRef.current?.remove();
    markerRef.current = null;
    return;
  }

  const label = document.createElement("div");
  label.className = "measurement-label";
  label.textContent = formatDistance(measureDistance(coordinates));
  markerRef.current?.remove();
  markerRef.current = new maplibregl.Marker({ element: label, anchor: "bottom-left", offset: [8, -8] })
    .setLngLat(coordinates[coordinates.length - 1])
    .addTo(map);
}

function fitTrajectories(map: maplibregl.Map, trajectories: Trajectory[]) {
  const coordinates = trajectories.filter((trajectory) => trajectory.visible).flatMap((trajectory) => trajectory.coordinates);
  if (coordinates.length === 0) return;
  const bounds = coordinates.reduce(
    (result, coordinate) => result.extend(coordinate),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration: 700 });
}

function measureDistance(coordinates: Coordinate[]) {
  return coordinates.slice(1).reduce((total, coordinate, index) => total + haversine(coordinates[index], coordinate), 0);
}

function haversine([longitudeA, latitudeA]: Coordinate, [longitudeB, latitudeB]: Coordinate) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters: number) {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(2)} km` : `${Math.round(meters)} m`;
}
