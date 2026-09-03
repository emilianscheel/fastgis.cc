import type { NextRequest } from "next/server";

const OSMF_VECTOR_HOST = "https://vector.openstreetmap.org";

function badRequest(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> | { path: string[] } }
): Promise<Response> {
  const routeStartedAt = performance.now();
  const resolvedParams = await Promise.resolve(context.params);
  const pathParts = resolvedParams.path ?? [];

  if (pathParts.length === 0) {
    return badRequest("Missing tile path.");
  }

  const joinedPath = pathParts.join("/");
  if (!joinedPath.startsWith("shortbread_v1/")) {
    return badRequest("Unsupported OSMF vector tile path.");
  }
  if (!joinedPath.endsWith(".mvt")) {
    return badRequest("Expected .mvt tile path.");
  }

  const upstreamUrl = new URL(`${OSMF_VECTOR_HOST}/${joinedPath}`);
  upstreamUrl.search = request.nextUrl.search;

  let upstream: Response;
  let upstreamFetchMs = 0;
  try {
    const upstreamFetchStartedAt = performance.now();
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/x-protobuf, application/vnd.mapbox-vector-tile, */*"
      },
      cache: "force-cache"
    });
    upstreamFetchMs = performance.now() - upstreamFetchStartedAt;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream fetch failed.";
    return badRequest(message, 502);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  } else {
    headers.set("content-type", "application/x-protobuf");
  }

  const cacheControl = upstream.headers.get("cache-control");
  headers.set("cache-control", cacheControl ?? "public, max-age=300, s-maxage=300");
  const etag = upstream.headers.get("etag");
  if (etag) {
    headers.set("etag", etag);
  }
  const lastModified = upstream.headers.get("last-modified");
  if (lastModified) {
    headers.set("last-modified", lastModified);
  }
  headers.set("x-proxy-cache", "pass");
  const totalMs = performance.now() - routeStartedAt;
  headers.set(
    "server-timing",
    `proxy_upstream;dur=${upstreamFetchMs.toFixed(1)}, proxy_total;dur=${totalMs.toFixed(1)}`
  );

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}
