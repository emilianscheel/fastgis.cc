import type { Coordinate } from "@/lib/trajectory";

export type ResolvedOsmWay = {
  id: string;
  coordinates: Coordinate[];
};

const LINK_ID_HEADERS = new Set(["linkid", "link", "wayid", "way", "osmwayid", "osmid"]);
const OSM_API_URL = "https://api.openstreetmap.org/api/0.6";
const NODE_BATCH_SIZE = 250;

export function parseLinkIds(content: string): string[] | null {
  const values = content.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (values.length === 0) return null;

  const [first, ...rest] = values;
  const normalizedHeader = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ids = LINK_ID_HEADERS.has(normalizedHeader) ? rest : values;
  return ids.length > 0 && ids.every((id) => /^\d+$/.test(id)) ? ids : null;
}

export async function resolveOsmWays(linkIds: string[]): Promise<ResolvedOsmWay[]> {
  const requestedIds = [...new Set(linkIds)].join(",");
  const wayXml = await fetchXml(`${OSM_API_URL}/ways?ways=${requestedIds}`);
  const ways = parseWayReferences(wayXml);
  const nodeIds = [...new Set(ways.flatMap((way) => way.nodeIds))];
  const coordinates = new Map<string, Coordinate>();

  for (const ids of chunk(nodeIds, NODE_BATCH_SIZE)) {
    parseNodes(await fetchXml(`${OSM_API_URL}/nodes?nodes=${ids.join(",")}`), coordinates);
  }

  return ways.flatMap((way) => {
    const geometry = way.nodeIds.map((nodeId) => coordinates.get(nodeId)).filter((coordinate): coordinate is Coordinate => coordinate !== undefined);
    return geometry.length > 1 ? [{ id: way.id, coordinates: geometry }] : [];
  });
}

async function fetchXml(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenStreetMap way lookup failed (${response.status})`);
  return response.text();
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function parseWayReferences(xml: string) {
  return [...xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)].flatMap((match) => {
    const id = xmlAttribute(match[1], "id");
    const nodeIds = [...match[2].matchAll(/<nd\b([^>]*)\/>/g)]
      .map((node) => xmlAttribute(node[1], "ref"))
      .filter((nodeId): nodeId is string => nodeId !== null);
    return id && nodeIds.length > 1 ? [{ id, nodeIds }] : [];
  });
}

function parseNodes(xml: string, coordinates: Map<string, Coordinate>) {
  for (const match of xml.matchAll(/<node\b([^>]*)\/>/g)) {
    const id = xmlAttribute(match[1], "id");
    const latitude = Number(xmlAttribute(match[1], "lat"));
    const longitude = Number(xmlAttribute(match[1], "lon"));
    if (id && Number.isFinite(latitude) && Number.isFinite(longitude)) coordinates.set(id, [longitude, latitude]);
  }
}

function xmlAttribute(source: string, name: string) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] ?? null;
}
