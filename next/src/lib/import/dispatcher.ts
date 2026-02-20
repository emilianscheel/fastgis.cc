import type { ImportDispatchHandlers, ImportDispatchResult, ImportScanResult } from "@/lib/import/types";

export function dispatchScannedImport(
  scanResult: ImportScanResult,
  fileName: string,
  bytes: Uint8Array,
  handlers: ImportDispatchHandlers
): ImportDispatchResult {
  if (scanResult.format === "trajectory-csv") {
    handlers.loadTrajectoryCsv(fileName, bytes);
    return {
      accepted: true,
      format: "trajectory-csv"
    };
  }

  if (scanResult.format === "marker-csv") {
    handlers.loadMarkerCsv(fileName, bytes);
    return {
      accepted: true,
      format: "marker-csv"
    };
  }

  return { accepted: false };
}
