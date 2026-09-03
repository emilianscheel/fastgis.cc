export type EngineKind = "raster" | "vector";

export type VectorBackendPreference = "webgl2" | "webgpu";
export type VectorBackendActual = "webgl2" | "webgpu" | "webgpu-fallback-webgl2" | "canvas2d";

type CommonInitConfig = {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  cacheSize: number;
};

export type RasterInitConfig = CommonInitConfig & {
  engineKind: "raster";
  tileUrlTemplate: string;
};

export type VectorSourceConfig = {
  tileJsonUrl: string;
  tileUrlTemplate: string;
  attribution?: string | null;
  sourceMaxZoom?: number | null;
  backendPreference: VectorBackendPreference;
  stylePreset: "osm-vector-minimal";
  layerNames?: string[] | null;
};

export type VectorInitConfig = CommonInitConfig & {
  engineKind: "vector";
  vectorSource: VectorSourceConfig;
};

export type InitConfig = RasterInitConfig | VectorInitConfig;

export type ViewState = {
  lon: number;
  lat: number;
  zoom: number;
};

export type PerfTimingSeries = {
  samples: number;
  lastMs: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type VectorPerfZoomBytes = {
  z: number;
  avgTileBytes: number;
  tiles: number;
};

export type VectorPerfStats = {
  enabled: boolean;
  frames: number;
  fullRedrawFrames: number;
  snapshotSurrogateFrames: number;
  snapshotRatio: number;
  staleResultDrops: number;
  canceledRequests: number;
  fetchErrors: number;
  decodeErrors: number;
  decodeQueueDrops: number;
  bytesFetchedTotal: number;
  tilesFetchedTotal: number;
  recentFetchBytesPerSec: number;
  frame: PerfTimingSeries;
  fullDraw: PerfTimingSeries;
  snapshotDraw: PerfTimingSeries;
  fetch: PerfTimingSeries;
  decode: PerfTimingSeries;
  prepare: PerfTimingSeries;
  glUpload: PerfTimingSeries;
  visibleTileCount: number;
  targetDrawCommands: number;
  fallbackDrawCommands: number;
  waterVerticesDrawn: number;
  lineVerticesDrawn: number;
  queueHigh: number;
  queueMedium: number;
  queueLow: number;
  pending: number;
  inFlight: number;
  decodeBacklog: number;
  fetchZoom: number;
  snapshotActive: boolean;
  aggressiveQualityActive: boolean;
  coarseWaterUsed: boolean;
  zoomByteSamples: VectorPerfZoomBytes[];
};

export type CsvBounds = {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

export type CsvLoadResult = {
  valid_rows: number;
  invalid_rows: number;
  bounds: CsvBounds | null;
};

export type MarkerHover = {
  lon: number;
  lat: number;
  screenX: number;
  screenY: number;
};

export type PlacedMarker = {
  lon: number;
  lat: number;
  tipScreenX: number;
  tipScreenY: number;
};

export type ProjectedPoint = {
  screenX: number;
  screenY: number;
};

export type WorkerInMessage =
  | {
      type: "INIT";
    payload: {
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
      origin: string;
      config: InitConfig;
    };
  }
  | {
      type: "RESIZE";
      payload: {
        width: number;
        height: number;
        dpr: number;
      };
    }
  | {
      type: "POINTER_DOWN" | "POINTER_MOVE" | "POINTER_UP";
      payload: {
        x: number;
        y: number;
        button?: number;
      };
    }
  | {
      type: "WHEEL";
      payload: {
        deltaY: number;
        x: number;
        y: number;
        ctrlKey: boolean;
      };
    }
  | {
      type: "SET_VIEW";
      payload: ViewState;
    }
  | {
      type: "GET_VIEW";
      payload: {
        requestId: number;
      };
    }
  | {
      type: "ZOOM_TO_BOX";
      payload: {
        startX: number;
        startY: number;
        endX: number;
        endY: number;
      };
    }
  | {
      type: "PLACE_MARKER";
      payload: {
        x: number;
        y: number;
      };
    }
  | {
      type: "PLACE_MARKER_WITH_INFO";
      payload: {
        x: number;
        y: number;
        requestId: number;
      };
    }
  | {
      type: "HOVER_MARKER";
      payload: {
        x: number;
        y: number;
        requestId: number;
      };
    }
  | {
      type: "PROJECT_LON_LAT";
      payload: {
        lon: number;
        lat: number;
        requestId: number;
      };
    }
  | {
      type: "ADD_MARKER_LON_LAT";
      payload: {
        lon: number;
        lat: number;
      };
    }
  | {
      type: "REMOVE_MARKER_LON_LAT";
      payload: {
        lon: number;
        lat: number;
      };
    }
  | {
      type: "REMOVE_RECENT_MARKERS";
      payload: {
        count: number;
      };
    }
  | {
      type: "FRAME_TICK";
      payload: {
        nowMs: number;
      };
    }
  | {
      type: "SET_DEBUG_OPTIONS";
      payload: {
        perfOverlayEnabled?: boolean;
      };
    }
  | {
      type: "LOAD_TRAJECTORY_CSV";
      payload: {
        name: string;
        bytes: Uint8Array;
      };
    }
  | {
      type: "LOAD_MARKER_CSV";
      payload: {
        name: string;
        bytes: Uint8Array;
      };
    }
  | {
      type: "CLEAR_TRAJECTORY";
      payload: Record<string, never>;
    }
  | {
      type: "SET_TILE_URL_TEMPLATE";
      payload: {
        tileUrlTemplate: string;
      };
    };

export type WorkerOutMessage =
  | {
      type: "READY";
      payload: {
        mode: "worker";
        engineKind: EngineKind;
        backend: VectorBackendActual | "canvas2d";
      };
    }
  | {
      type: "VIEW_STATE";
      payload: {
        requestId: number;
        view: ViewState | null;
      };
    }
  | {
      type: "CSV_LOADED";
      payload: CsvLoadResult;
    }
  | {
      type: "MARKER_HOVER";
      payload: {
        marker: MarkerHover | null;
        requestId: number;
      };
    }
  | {
      type: "MARKER_PLACED";
      payload: {
        marker: PlacedMarker | null;
        requestId: number;
      };
    }
  | {
      type: "LON_LAT_PROJECTED";
      payload: {
        point: ProjectedPoint | null;
        requestId: number;
      };
    }
  | {
      type: "STATUS";
      payload: {
        phase: "loading" | "ready";
      };
    }
  | {
      type: "PERF_STATS";
      payload: {
        stats: VectorPerfStats | null;
      };
    }
  | {
      type: "ERROR";
      payload: {
        code: string;
        message: string;
      };
    };
