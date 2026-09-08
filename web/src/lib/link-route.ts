import type { Coordinate } from "@/lib/trajectory";

export type ResolvedOsmWay = {
  id: string;
  coordinates: Coordinate[];
};

const LINK_ID_HEADERS = new Set(["linkid", "link", "wayid", "way", "osmwayid", "osmid"]);
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const WAY_BATCH_SIZE = 50;

export function parseLinkIds(content: string): string[] | null {
  const values = content.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (values.length === 0) return null;

  const [first, ...rest] = values;
  const normalizedHeader = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ids = LINK_ID_HEADERS.has(normalizedHeader) ? rest : values;
  return ids.length > 0 && ids.every((id) => /^\d+$/.test(id)) ? ids : null;
}

export async function resolveOsmWays(linkIds: string[]): Promise<ResolvedOsmWay[]> {
  const requestedIds = [...new Set(linkIds)];
  const ways: ResolvedOsmWay[] = [];
  for (const ids of chunk(requestedIds, WAY_BATCH_SIZE)) ways.push(...await fetchWayBatch(ids));
  return ways;
}

async function fetchWayBatch(ids: string[]): Promise<ResolvedOsmWay[]> {
  const query = `[out:json][timeout:60];way(id:${ids.join(",")});out geom;`;
  let failure: Error | null = null;
  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = await response.json() as OverpassResponse;
      return payload.elements.flatMap((way) => {
        const coordinates = way.geometry.map((point) => [point.lon, point.lat] as Coordinate);
        return coordinates.length > 1 ? [{ id: String(way.id), coordinates }] : [];
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Unknown request failure");
    }
  }
  throw new Error(`OpenStreetMap way lookup failed: ${failure?.message ?? "no available endpoint"}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

type OverpassResponse = {
  elements: Array<{
    id: number;
    geometry: Array<{ lat: number; lon: number }>;
  }>;
};
