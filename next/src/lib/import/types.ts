export type ImportFormat = "trajectory-csv" | "marker-csv";

export type ImportScanResult = {
  format: ImportFormat;
  delimiter: "," | ";";
  confidence: "high" | "medium";
};

export type ImportDispatchHandlers = {
  loadTrajectoryCsv: (fileName: string, bytes: Uint8Array) => void;
  loadMarkerCsv: (fileName: string, bytes: Uint8Array) => void;
};

export type ImportDispatchResult = {
  accepted: boolean;
  format?: ImportFormat;
};
