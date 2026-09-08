export type Coordinate = [longitude: number, latitude: number];

export type TrajectoryPoint = {
  coordinate: Coordinate;
  latitude: string;
  longitude: string;
  timestamp: string;
  speed?: number;
  direction?: number;
};

export type Trajectory = {
  id: string;
  name: string;
  points: TrajectoryPoint[];
  visible: boolean;
  color: string;
  csv: string;
};

const TRAJECTORY_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];

const COLUMN_ALIASES = {
  timestamp: ["timestamp", "time", "datetime", "date", "zeit", "datum"],
  latitude: ["latitude", "lat", "breite", "y"],
  longitude: ["longitude", "lon", "lng", "laenge", "länge", "x"],
  speed: ["speed", "velocity", "kmh", "km/h", "geschwindigkeit"],
  direction: ["direction", "heading", "bearing", "course", "richtung"],
};

type ColumnIndexes = { timestamp?: number; latitude: number; longitude: number; speed?: number; direction?: number };

export function parseTrajectory(content: string): TrajectoryPoint[] | null {
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

  const separator = detectSeparator(lines.slice(0, 8));
  const records = lines.map((line) => splitRecord(line, separator));
  const indexes = detectColumns(records[0]);
  const data = indexes ? records.slice(1) : records;
  const columns = indexes ?? inferColumns(data);
  if (!columns) return null;

  const points = data.flatMap((cells) => parsePoint(cells, columns));
  return points.length > 0 ? points : null;
}

export const parseTrajectoryCsv = parseTrajectory;

function detectSeparator(lines: string[]) {
  return [",", ";", "\t", "|"].reduce(
    (best, separator) => lines.reduce((count, line) => count + line.split(separator).length - 1, 0) > best.count
      ? { separator, count: lines.reduce((count, line) => count + line.split(separator).length - 1, 0) }
      : best,
    { separator: ",", count: 0 },
  ).separator;
}

function splitRecord(line: string, separator: string) {
  return line.split(separator).map((value) => value.trim().replace(/^"|"$/g, ""));
}

function detectColumns(header: string[]): ColumnIndexes | null {
  const normalized = header.map((value) => value.toLowerCase().replace(/[^a-zäöü/]/g, ""));
  const find = (name: keyof typeof COLUMN_ALIASES) => normalized.findIndex((value) => COLUMN_ALIASES[name].includes(value));
  const latitude = find("latitude");
  const longitude = find("longitude");
  if (latitude < 0 || longitude < 0) return null;
  const optional = (name: keyof Omit<ColumnIndexes, "latitude" | "longitude">) => {
    const index = find(name);
    return index < 0 ? undefined : index;
  };
  return { latitude, longitude, timestamp: optional("timestamp"), speed: optional("speed"), direction: optional("direction") };
}

function inferColumns(rows: string[][]): ColumnIndexes | null {
  const sample = rows.find((row) => row.length > 1);
  if (!sample) return null;
  for (let latitude = 0; latitude < sample.length - 1; latitude += 1) {
    const longitude = latitude + 1;
    if (isLatitude(sample[latitude]) && isLongitude(sample[longitude])) {
      const timestampIndex = sample.findIndex((value) => !Number.isNaN(Date.parse(value)));
      return {
        latitude,
        longitude,
        timestamp: timestampIndex < 0 ? undefined : timestampIndex,
      };
    }
  }
  return null;
}

function parsePoint(cells: string[], indexes: ColumnIndexes): TrajectoryPoint[] {
  const latitude = cells[indexes.latitude];
  const longitude = cells[indexes.longitude];
  if (!latitude || !longitude || !isLatitude(latitude) || !isLongitude(longitude)) return [];
  const speedMetersPerSecond = indexes.speed === undefined ? undefined : Number(cells[indexes.speed]);
  const speed = speedMetersPerSecond === undefined ? undefined : Number((speedMetersPerSecond * 3.6).toFixed(2));
  const direction = indexes.direction === undefined ? undefined : Number(cells[indexes.direction]);
  return [{
    timestamp: indexes.timestamp === undefined ? "" : cells[indexes.timestamp] ?? "",
    latitude,
    longitude,
    coordinate: [Number(longitude), Number(latitude)],
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(Number.isFinite(direction) ? { direction } : {}),
  }];
}

function isLatitude(value: string) {
  const numeric = Number(value.replace(",", "."));
  return Number.isFinite(numeric) && numeric >= -90 && numeric <= 90;
}

function isLongitude(value: string) {
  const numeric = Number(value.replace(",", "."));
  return Number.isFinite(numeric) && numeric >= -180 && numeric <= 180;
}

export function trajectoryColor(index: number) {
  return TRAJECTORY_COLORS[index % TRAJECTORY_COLORS.length];
}
