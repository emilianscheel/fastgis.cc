export type Coordinate = [longitude: number, latitude: number];

export type Trajectory = {
  id: string;
  name: string;
  coordinates: Coordinate[];
  visible: boolean;
  color: string;
};

const TRAJECTORY_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];

export function parseTrajectoryCsv(csv: string): Coordinate[] | null {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  if (!header) return null;

  const columns = header.split(",").map((value) => value.trim().toLowerCase());
  const latitudeIndex = columns.indexOf("latitude");
  const longitudeIndex = columns.indexOf("longitude");
  if (latitudeIndex < 0 || longitudeIndex < 0) return null;

  const coordinates = rows.flatMap((row) => {
    const cells = row.split(",");
    const latitude = Number(cells[latitudeIndex]?.trim());
    const longitude = Number(cells[longitudeIndex]?.trim());
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? [[longitude, latitude] as Coordinate] : [];
  });

  return coordinates.length > 0 ? coordinates : null;
}

export function trajectoryColor(index: number) {
  return TRAJECTORY_COLORS[index % TRAJECTORY_COLORS.length];
}
