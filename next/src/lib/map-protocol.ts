export type InitConfig = {
  tileUrlTemplate: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  cacheSize: number;
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
      payload: {
        lon: number;
        lat: number;
        zoom: number;
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
      type: "HOVER_MARKER";
      payload: {
        x: number;
        y: number;
        requestId: number;
      };
    }
  | {
      type: "FRAME_TICK";
      payload: {
        nowMs: number;
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
      type: "STATUS";
      payload: {
        phase: "loading" | "ready";
      };
    }
  | {
      type: "ERROR";
      payload: {
        code: string;
        message: string;
      };
    };
