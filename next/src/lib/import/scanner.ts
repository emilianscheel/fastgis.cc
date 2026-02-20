import type { ImportScanResult } from "@/lib/import/types";

const SAMPLE_BYTE_LIMIT = 64 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/x-csv",
  "application/vnd.ms-excel",
  "text/plain"
]);

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index < 0 || index === fileName.length - 1) {
    return "";
  }
  return fileName.slice(index + 1).toLowerCase();
}

function decodeTextSample(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const sample = bytes.subarray(0, Math.min(bytes.length, SAMPLE_BYTE_LIMIT));
  return decoder.decode(sample);
}

function firstNonEmptyLine(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function detectDelimiter(line: string): "," | ";" {
  const commaMatches = line.match(/,/g);
  const semicolonMatches = line.match(/;/g);
  const commaCount = commaMatches ? commaMatches.length : 0;
  const semicolonCount = semicolonMatches ? semicolonMatches.length : 0;
  return semicolonCount > commaCount ? ";" : ",";
}

function tokenize(line: string, delimiter: "," | ";"): string[] {
  return line.split(delimiter).map((value) => value.trim());
}

function normalizeColumnName(value: string): string {
  return value.trim().toLowerCase();
}

function isLatColumn(value: string): boolean {
  const name = normalizeColumnName(value);
  return name === "lat" || name === "latitude";
}

function isLonColumn(value: string): boolean {
  const name = normalizeColumnName(value);
  return name === "lon" || name === "lng" || name === "longitude";
}

function isTimeColumn(value: string): boolean {
  const name = normalizeColumnName(value);
  return name === "time" || name === "timestamp";
}

function hasTrajectoryHeader(columns: string[]): boolean {
  let hasTime = false;
  let hasLat = false;
  let hasLon = false;

  for (const column of columns) {
    hasTime = hasTime || isTimeColumn(column);
    hasLat = hasLat || isLatColumn(column);
    hasLon = hasLon || isLonColumn(column);
  }

  return hasTime && hasLat && hasLon;
}

function hasMarkerHeader(columns: string[]): boolean {
  let hasLat = false;
  let hasLon = false;

  for (const column of columns) {
    hasLat = hasLat || isLatColumn(column);
    hasLon = hasLon || isLonColumn(column);
  }

  return hasLat && hasLon;
}

function parseCoordinate(value: string): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidLatLon(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function looksLikeTrajectoryRow(columns: string[]): boolean {
  if (columns.length < 3) {
    return false;
  }

  const lat = parseCoordinate(columns[1]);
  const lon = parseCoordinate(columns[2]);
  if (lat === null || lon === null) {
    return false;
  }

  return isValidLatLon(lat, lon);
}

function looksLikeMarkerRow(columns: string[]): boolean {
  if (columns.length >= 3) {
    const lon = parseCoordinate(columns[1]);
    const lat = parseCoordinate(columns[2]);
    if (lon !== null && lat !== null && isValidLatLon(lat, lon)) {
      return true;
    }
  }

  if (columns.length >= 2) {
    const lon = parseCoordinate(columns[0]);
    const lat = parseCoordinate(columns[1]);
    if (lon !== null && lat !== null && isValidLatLon(lat, lon)) {
      return true;
    }
  }

  return false;
}

function looksLikeTextCsv(fileName: string, mimeType: string, line: string): boolean {
  const extension = extensionOf(fileName);
  const normalizedMime = mimeType.trim().toLowerCase();
  if (SUPPORTED_MIME_TYPES.has(normalizedMime)) {
    return true;
  }
  if (extension === "csv" || extension === "txt") {
    return true;
  }
  return line.includes(",") || line.includes(";");
}

export function scanImportFile(params: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): ImportScanResult | null {
  const sampleText = decodeTextSample(params.bytes);
  const line = firstNonEmptyLine(sampleText);
  if (!line) {
    return null;
  }

  if (!looksLikeTextCsv(params.fileName, params.mimeType, line)) {
    return null;
  }

  const delimiter = detectDelimiter(line);
  const columns = tokenize(line, delimiter);

  if (hasTrajectoryHeader(columns)) {
    return {
      format: "trajectory-csv",
      delimiter,
      confidence: "high"
    };
  }

  if (hasMarkerHeader(columns)) {
    return {
      format: "marker-csv",
      delimiter,
      confidence: "high"
    };
  }

  if (delimiter === ",") {
    if (looksLikeMarkerRow(columns)) {
      return {
        format: "marker-csv",
        delimiter,
        confidence: "medium"
      };
    }
    if (looksLikeTrajectoryRow(columns)) {
      return {
        format: "trajectory-csv",
        delimiter,
        confidence: "medium"
      };
    }
  } else {
    if (looksLikeTrajectoryRow(columns)) {
      return {
        format: "trajectory-csv",
        delimiter,
        confidence: "medium"
      };
    }
    if (looksLikeMarkerRow(columns)) {
      return {
        format: "marker-csv",
        delimiter,
        confidence: "medium"
      };
    }
  }

  return null;
}
