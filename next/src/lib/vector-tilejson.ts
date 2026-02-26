export type VectorTileJsonResolution = {
  tileUrlTemplate: string;
  minZoom: number;
  maxZoom: number;
  attribution: string | null;
  layerNames: string[];
};

type TileJsonResponse = {
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
  vector_layers?: Array<{ id?: string }>;
};

const tileJsonCache = new Map<string, Promise<VectorTileJsonResolution>>();

function normalizeTileTemplate(template: string): string {
  return template
    .replace(/%7Bz%7D/gi, "{z}")
    .replace(/%7Bx%7D/gi, "{x}")
    .replace(/%7By%7D/gi, "{y}")
    .replace(/\{y\}/g, "{y}")
    .replace(/\{x\}/g, "{x}")
    .replace(/\{z\}/g, "{z}");
}

function resolveTemplatePreservingPlaceholders(template: string, baseUrl: string): string {
  const placeholderMap = [
    ["{z}", "__FASTGIS_TILE_Z__"],
    ["{x}", "__FASTGIS_TILE_X__"],
    ["{y}", "__FASTGIS_TILE_Y__"]
  ] as const;

  let safeTemplate = template;
  for (const [placeholder, token] of placeholderMap) {
    safeTemplate = safeTemplate.replaceAll(placeholder, token);
  }

  const resolved = new URL(safeTemplate, baseUrl).toString();
  let restored = resolved;
  for (const [placeholder, token] of placeholderMap) {
    restored = restored.replaceAll(token, placeholder);
  }

  return normalizeTileTemplate(restored);
}

function rewriteOsmfVectorTemplateToProxy(template: string): string {
  const normalized = normalizeTileTemplate(template);
  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }

  if (parsed.hostname !== "vector.openstreetmap.org") {
    return normalized;
  }

  const path = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  if (!path.startsWith("shortbread_v1/")) {
    return normalized;
  }

  const query = parsed.search ? parsed.search : "";
  return normalizeTileTemplate(`/api/vector-tiles/osmf/${path}${query}`);
}

export function resolveVectorTileJson(tileJsonUrl: string): Promise<VectorTileJsonResolution> {
  const cached = tileJsonCache.get(tileJsonUrl);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const response = await fetch(tileJsonUrl, {
      credentials: "omit",
      mode: "cors",
      cache: "force-cache"
    });

    if (!response.ok) {
      throw new Error(`TileJSON request failed with status ${response.status}`);
    }

    const json = (await response.json()) as TileJsonResponse;
    const tileUrlTemplate = json.tiles?.[0];

    if (!tileUrlTemplate) {
      throw new Error("TileJSON response did not include a tile URL template.");
    }

    const layerNames = (json.vector_layers ?? [])
      .map((layer) => layer.id)
      .filter((layerId): layerId is string => typeof layerId === "string" && layerId.length > 0);

    const resolvedTileTemplate = resolveTemplatePreservingPlaceholders(tileUrlTemplate, tileJsonUrl);
    const proxiedTileTemplate = rewriteOsmfVectorTemplateToProxy(resolvedTileTemplate);

    return {
      tileUrlTemplate: proxiedTileTemplate,
      minZoom: Number.isFinite(json.minzoom) ? Number(json.minzoom) : 0,
      maxZoom: Number.isFinite(json.maxzoom) ? Number(json.maxzoom) : 14,
      attribution: typeof json.attribution === "string" ? json.attribution : null,
      layerNames
    };
  })();

  tileJsonCache.set(tileJsonUrl, promise);
  return promise;
}
