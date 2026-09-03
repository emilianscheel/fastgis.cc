export type Coordinate = [longitude: number, latitude: number];

export type TrajectoryPoint = {
  coordinate: Coordinate;
  latitude: string;
  longitude: string;
  timestamp: string;
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

export function parseTrajectoryCsv(csv: string): TrajectoryPoint[] | null {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  if (!header) return null;

  const columns = header.split(",").map((value) => value.trim().toLowerCase());
  const timestampIndex = columns.indexOf("timestamp");
  const latitudeIndex = columns.indexOf("latitude");
  const longitudeIndex = columns.indexOf("longitude");
  if (timestampIndex < 0 || latitudeIndex < 0 || longitudeIndex < 0) return null;

  const points = rows.flatMap((row) => {
    const cells = row.split(",");
    const timestamp = cells[timestampIndex]?.trim();
    const latitude = cells[latitudeIndex]?.trim();
    const longitude = cells[longitudeIndex]?.trim();
    const latitudeValue = Number(latitude);
    const longitudeValue = Number(longitude);
    return timestamp && Number.isFinite(latitudeValue) && Number.isFinite(longitudeValue)
      ? [{ timestamp, latitude, longitude, coordinate: [longitudeValue, latitudeValue] as Coordinate }]
      : [];
  });

  return points.length > 0 ? points : null;
}

export function trajectoryColor(index: number) {
  return TRAJECTORY_COLORS[index % TRAJECTORY_COLORS.length];
}
