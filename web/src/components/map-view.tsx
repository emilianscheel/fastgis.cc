"use client";

import * as maplibregl from "maplibre-gl";
import { Button } from "@base-ui/react/button";
import { ChevronDown, ChevronRight, Copy, Download, Eye, EyeOff, Minus, Plus, Ruler, ScanSearch, Trash2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent, MutableRefObject } from "react";
import type { FeatureCollection, LineString, Point } from "geojson";

import { readSessionState, writeSessionState } from "@/lib/session-state";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  parseTrajectoryCsv,
  trajectoryColor,
  type Coordinate,
  type Trajectory,
  type TrajectoryPoint,
} from "@/lib/trajectory";

const LIGHT_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const DARK_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
const TRAJECTORY_SOURCE = "trajectories";
const TRAJECTORY_LINE_LAYER = "trajectory-lines";
const TRAJECTORY_POINT_LAYER = "trajectory-points";
const MEASUREMENT_SOURCE = "measurement";
const EMISSION_CLASSES = [
  { label: "0", multiplier: 0 },
  { label: "I", multiplier: 1 },
  { label: "II", multiplier: 2 },
  { label: "III", multiplier: 3 },
  { label: "IV", multiplier: 4 },
  { label: "V", multiplier: 5 },
  { label: "VI", multiplier: 6 },
];

type TollSettings = { axles: number; emissionClass: number };

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
  const [selectedPoint, setSelectedPoint] = useState<TrajectoryPoint | null>(null);
  const [pointCardPosition, setPointCardPosition] = useState({ x: 0, y: 0 });
  const [expandedTrajectoryId, setExpandedTrajectoryId] = useState<string | null>(null);
  const [areaZoomEnabled, setAreaZoomEnabled] = useState(false);
  const [zoomSelection, setZoomSelection] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [tollSettings, setTollSettings] = useState<Record<string, TollSettings>>({});
  const styleUrl = resolvedTheme === "dark" ? DARK_STYLE_URL : LIGHT_STYLE_URL;
  const expandedTrajectory = trajectories.find((trajectory) => trajectory.id === expandedTrajectoryId);

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
      map.on("load", () => {
        syncTrajectories(map, trajectoriesRef.current);
        map.on("mouseenter", TRAJECTORY_POINT_LAYER, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", TRAJECTORY_POINT_LAYER, () => {
          map.getCanvas().style.cursor = measurementEnabledRef.current ? "crosshair" : "";
        });
      });
      map.on("moveend", () => {
        const center = map.getCenter();
        cameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
        persist(map, trajectoriesRef.current);
      });
      map.on("click", (event) => {
        if (!measurementEnabledRef.current) {
          const properties = map.queryRenderedFeatures(event.point, { layers: [TRAJECTORY_POINT_LAYER] })[0]?.properties;
          if (!properties) {
            setSelectedPoint(null);
            return;
          }
          setSelectedPoint({
            timestamp: properties.timestamp,
            latitude: properties.latitude,
            longitude: properties.longitude,
            coordinate: [Number(properties.longitude), Number(properties.latitude)],
          });
          return;
        }
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMeasurementEnabled(false);
      setMeasurementPoints([]);
      setCursorPoint(null);
      setAreaZoomEnabled(false);
      setZoomSelection(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedPoint) return;

    const updatePosition = () => {
      const point = map.project(selectedPoint.coordinate);
      setPointCardPosition({ x: point.x, y: point.y });
    };
    updatePosition();
    map.on("move", updatePosition);
    return () => {
      map.off("move", updatePosition);
    };
  }, [selectedPoint]);

  async function importFiles(files: File[]) {
    const imported = (await Promise.all(files.map(async (file) => {
      const csv = await file.text();
      return { name: file.name, csv, points: parseTrajectoryCsv(csv) };
    }))).filter((file): file is { name: string; csv: string; points: TrajectoryPoint[] } => file.points !== null);

    if (imported.length === 0) return;
    setTrajectories((current) => {
      const next = [...current, ...imported.map((file, index) => ({
        id: crypto.randomUUID(),
        name: file.name,
        points: file.points,
        visible: true,
        color: trajectoryColor(current.length + index),
        csv: file.csv,
      }))];
      const map = mapRef.current;
      if (map) fitTrajectories(map, next);
      return next;
    });
  }

  function selectTrajectoryPoint(point: TrajectoryPoint) {
    const map = mapRef.current;
    setSelectedPoint(point);
    if (map) {
      map.easeTo({ center: point.coordinate, zoom: Math.max(map.getZoom(), 16), duration: 650, essential: true });
    }
  }

  function startAreaZoom(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setZoomSelection({
      startX: event.clientX - bounds.left,
      startY: event.clientY - bounds.top,
      endX: event.clientX - bounds.left,
      endY: event.clientY - bounds.top,
    });
  }

  function updateAreaZoom(event: MouseEvent<HTMLDivElement>) {
    if (!zoomSelection) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setZoomSelection((selection) => selection && ({
      ...selection,
      endX: event.clientX - bounds.left,
      endY: event.clientY - bounds.top,
    }));
  }

  function finishAreaZoom() {
    if (!zoomSelection) return;
    const map = mapRef.current;
    const width = Math.abs(zoomSelection.endX - zoomSelection.startX);
    const height = Math.abs(zoomSelection.endY - zoomSelection.startY);
    if (map && width > 8 && height > 8) {
      map.fitBounds([
        map.unproject([zoomSelection.startX, zoomSelection.startY]),
        map.unproject([zoomSelection.endX, zoomSelection.endY]),
      ], { padding: 32, duration: 450, essential: true });
    }
    setZoomSelection(null);
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
        className="map-tool-button"
        onClick={() => {
          setMeasurementEnabled((enabled) => !enabled);
          setMeasurementPoints([]);
          setCursorPoint(null);
          setAreaZoomEnabled(false);
        }}
        type="button"
      >
        <Ruler size={18} />
      </Button>
      <Button
        aria-label="Zoom to area"
        aria-pressed={areaZoomEnabled}
        className="map-tool-button area-zoom-button"
        onClick={() => {
          setAreaZoomEnabled((enabled) => !enabled);
          setMeasurementEnabled(false);
          setMeasurementPoints([]);
          setCursorPoint(null);
        }}
        type="button"
      >
        <ScanSearch size={18} />
      </Button>
      {areaZoomEnabled && (
        <div
          className="area-zoom-overlay"
          onMouseDown={startAreaZoom}
          onMouseMove={updateAreaZoom}
          onMouseUp={finishAreaZoom}
        >
          {zoomSelection && (
            <div
              className="area-zoom-selection"
              style={{
                left: Math.min(zoomSelection.startX, zoomSelection.endX),
                top: Math.min(zoomSelection.startY, zoomSelection.endY),
                width: Math.abs(zoomSelection.endX - zoomSelection.startX),
                height: Math.abs(zoomSelection.endY - zoomSelection.startY),
              }}
            />
          )}
        </div>
      )}
      {trajectories.length > 0 && (
        <aside className="trajectory-card" style={{ width: `${trajectoryPanelWidth(trajectories)}px` }}>
          {trajectories.map((trajectory) => {
            const expanded = expandedTrajectoryId === trajectory.id;
            return (
              <div className="trajectory-item" key={trajectory.id}>
                <div className="trajectory-row">
                  <Button
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${trajectory.name}`}
                    className="icon-button"
                    onClick={() => setExpandedTrajectoryId((id) => id === trajectory.id ? null : trajectory.id)}
                    type="button"
                  >
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Button>
                  <span className="trajectory-name">{trajectory.name}</span>
                  <Button
                    aria-label={`Download ${trajectory.name}`}
                    className="icon-button"
                    onClick={() => downloadTrajectory(trajectory)}
                    type="button"
                  >
                    <Download size={16} />
                  </Button>
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
                <div className={`trajectory-points ${expanded ? "is-expanded" : ""}`}>
                  <TrajectoryPointList points={trajectory.points} onSelect={selectTrajectoryPoint} />
                </div>
              </div>
            );
          })}
        </aside>
      )}
      {expandedTrajectory && (
        <TollCard
          className="floating-toll-card"
          settings={tollSettings[expandedTrajectory.id] ?? { axles: 2, emissionClass: 0 }}
          trajectory={expandedTrajectory}
          onChange={(settings) => setTollSettings((current) => ({ ...current, [expandedTrajectory.id]: settings }))}
          style={{ left: `${trajectoryPanelWidth(trajectories) + 24}px` }}
        />
      )}
      {selectedPoint && (
        <aside className="point-card" style={{ left: pointCardPosition.x, top: pointCardPosition.y }}>
          <CopyValue label={`${selectedPoint.latitude}, ${selectedPoint.longitude}`} />
          <CopyValue label={selectedPoint.timestamp} />
          <CopyValue label={new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(selectedPoint.timestamp))} />
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
  const lines: FeatureCollection<LineString, { color: string }> = {
    type: "FeatureCollection",
    features: trajectories.filter((trajectory) => trajectory.visible).map((trajectory) => ({
      type: "Feature",
      properties: { color: trajectory.color },
      geometry: { type: "LineString", coordinates: trajectory.points.map((point) => point.coordinate) },
    })),
  };
  const points: FeatureCollection<Point, { timestamp: string; latitude: string; longitude: string }> = {
    type: "FeatureCollection",
    features: trajectories.filter((trajectory) => trajectory.visible).flatMap((trajectory) =>
      trajectory.points.map((point) => ({
        type: "Feature" as const,
        properties: { timestamp: point.timestamp, latitude: point.latitude, longitude: point.longitude },
        geometry: { type: "Point" as const, coordinates: point.coordinate },
      })),
    ),
  };
  const source = map.getSource(TRAJECTORY_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData({ type: "FeatureCollection", features: [...lines.features, ...points.features] });
  else {
    map.addSource(TRAJECTORY_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [...lines.features, ...points.features] } });
    map.addLayer({
      id: TRAJECTORY_LINE_LAYER,
      type: "line",
      source: TRAJECTORY_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.9 },
    });
    map.addLayer({
      id: TRAJECTORY_POINT_LAYER,
      type: "circle",
      source: TRAJECTORY_SOURCE,
      filter: ["==", "$type", "Point"],
      paint: { "circle-radius": 3.5, "circle-color": "#000000" },
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
  const coordinates = trajectories.filter((trajectory) => trajectory.visible).flatMap((trajectory) =>
    trajectory.points.map((point) => point.coordinate),
  );
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

function trajectoryDistanceKilometers(trajectory: Trajectory) {
  return trajectory.points.slice(1).reduce(
    (total, point, index) => total + haversine(trajectory.points[index].coordinate, point.coordinate),
    0,
  ) / 1_000;
}

function calculateToll(distanceKilometers: number, settings: TollSettings) {
  const distanceCharge = distanceKilometers;
  const axleCharge = settings.axles * 0.2;
  const emissionSurcharge = (distanceCharge + axleCharge) * settings.emissionClass * 0.1;
  return { distanceCharge, axleCharge, emissionSurcharge, total: distanceCharge + axleCharge + emissionSurcharge };
}

function downloadTrajectory(trajectory: Trajectory) {
  const url = URL.createObjectURL(new Blob([trajectory.csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = trajectory.name;
  link.click();
  URL.revokeObjectURL(url);
}

function TollCard({
  trajectory,
  settings,
  onChange,
  className,
  style,
}: {
  trajectory: Trajectory;
  settings: TollSettings;
  onChange: (settings: TollSettings) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const kilometers = trajectoryDistanceKilometers(trajectory);
  const toll = calculateToll(kilometers, settings);
  const formatEuro = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(value);

  return (
    <section className={["toll-card", className].filter(Boolean).join(" ")} style={style}>
      <div className="toll-row"><span>{kilometers.toFixed(2)} km × €1.00</span><strong>{formatEuro(toll.distanceCharge)}</strong></div>
      <div className="toll-row">
        <span>Axles</span>
        <span className="axle-control">
          <Button aria-label="Decrease axles" className="toll-icon-button" disabled={settings.axles === 1} onClick={() => onChange({ ...settings, axles: settings.axles - 1 })} type="button"><Minus size={14} /></Button>
          <strong>{settings.axles} × €0.20</strong>
          <Button aria-label="Increase axles" className="toll-icon-button" onClick={() => onChange({ ...settings, axles: settings.axles + 1 })} type="button"><Plus size={14} /></Button>
        </span>
        <strong>{formatEuro(toll.axleCharge)}</strong>
      </div>
      <div className="emission-row">
        <span>Emission</span>
        <ButtonGroup aria-label="Emission class" className="emission-group">
          {EMISSION_CLASSES.map((emissionClass) => (
            <Button
              aria-pressed={settings.emissionClass === emissionClass.multiplier}
              className="emission-button"
              key={emissionClass.label}
              onClick={() => onChange({ ...settings, emissionClass: emissionClass.multiplier })}
              type="button"
            >
              {emissionClass.label}
            </Button>
          ))}
        </ButtonGroup>
        <strong>{formatEuro(toll.emissionSurcharge)}</strong>
      </div>
      <div className="toll-total">
        <strong>{formatEuro(toll.total)}</strong>
        <Button aria-label={`Download toll receipt for ${trajectory.name}`} className="receipt-button" onClick={() => void downloadReceipt(trajectory, settings, kilometers, toll)} type="button">
          <Download size={15} />
        </Button>
      </div>
    </section>
  );
}

async function downloadReceipt(trajectory: Trajectory, settings: TollSettings, kilometers: number, toll: ReturnType<typeof calculateToll>) {
  const { jsPDF } = await import("jspdf");
  const receipt = new jsPDF({ unit: "mm", format: [80, 110] });
  const euro = (value: number) => `EUR ${value.toFixed(2)}`;
  receipt.setFont("helvetica", "bold");
  receipt.setFontSize(14);
  receipt.text("TOLL RECEIPT", 8, 12);
  receipt.setFont("helvetica", "normal");
  receipt.setFontSize(8);
  receipt.text(trajectory.name, 8, 19, { maxWidth: 64 });
  receipt.text(`${kilometers.toFixed(2)} km × EUR 1.00`, 8, 31);
  receipt.text(euro(toll.distanceCharge), 72, 31, { align: "right" });
  receipt.text(`${settings.axles} axles × EUR 0.20`, 8, 38);
  receipt.text(euro(toll.axleCharge), 72, 38, { align: "right" });
  receipt.text(`Euro class +${settings.emissionClass * 10}%`, 8, 45);
  receipt.text(euro(toll.emissionSurcharge), 72, 45, { align: "right" });
  receipt.setLineWidth(0.2);
  receipt.line(8, 53, 72, 53);
  receipt.setFont("helvetica", "bold");
  receipt.setFontSize(13);
  receipt.text("TOTAL", 8, 62);
  receipt.text(euro(toll.total), 72, 62, { align: "right" });
  receipt.save(`${trajectory.name.replace(/\.csv$/i, "")}-toll-receipt.pdf`);
}

function CopyValue({ label }: { label: string }) {
  return (
    <div className="point-value">
      <span>{label}</span>
      <Button aria-label={`Copy ${label}`} className="icon-button" onClick={() => void navigator.clipboard.writeText(label)} type="button">
        <Copy size={15} />
      </Button>
    </div>
  );
}

const POINT_ROW_HEIGHT = 28;
const VISIBLE_POINT_ROWS = 10;

function TrajectoryPointList({
  points,
  onSelect,
}: {
  points: TrajectoryPoint[];
  onSelect: (point: TrajectoryPoint) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / POINT_ROW_HEIGHT) - 2);
  const visiblePoints = points.slice(firstVisibleIndex, firstVisibleIndex + VISIBLE_POINT_ROWS + 4);

  return (
    <div
      className="trajectory-points-scroll"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{ height: POINT_ROW_HEIGHT * VISIBLE_POINT_ROWS }}
    >
      <div className="trajectory-points-spacer" style={{ height: points.length * POINT_ROW_HEIGHT }}>
        <div className="trajectory-points-window" style={{ transform: `translateY(${firstVisibleIndex * POINT_ROW_HEIGHT}px)` }}>
          {visiblePoints.map((point, offset) => {
            const index = firstVisibleIndex + offset;
            return (
              <div
                className="trajectory-point-row"
                key={`${point.timestamp}-${index}`}
              >
                <span className="trajectory-point-line">{index + 2}</span>
                <CopyPointCell point={point} value={point.timestamp} onSelect={onSelect} />
                <CopyPointCell point={point} value={point.latitude} onSelect={onSelect} />
                <CopyPointCell point={point} value={point.longitude} onSelect={onSelect} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CopyPointCell({
  point,
  value,
  onSelect,
}: {
  point: TrajectoryPoint;
  value: string;
  onSelect: (point: TrajectoryPoint) => void;
}) {
  return (
    <Button
      aria-label={`Copy ${value}`}
      className="trajectory-point-cell"
      onClick={() => {
        onSelect(point);
        void navigator.clipboard.writeText(value);
      }}
      type="button"
    >
      {value}
    </Button>
  );
}

function trajectoryPanelWidth(trajectories: Trajectory[]) {
  const pointWidth = Math.max(
    ...trajectories.flatMap((trajectory) => trajectory.points.map((point) =>
      40 + 8 + point.timestamp.length * 7.25 + 8 + point.latitude.length * 7.25 + 8 + point.longitude.length * 7.25,
    )),
  );
  const fileWidth = Math.max(...trajectories.map((trajectory) => 28 + trajectory.name.length * 7.25 + 84));
  return Math.min(window.innerWidth - 24, Math.ceil(Math.max(pointWidth, fileWidth)));
}
