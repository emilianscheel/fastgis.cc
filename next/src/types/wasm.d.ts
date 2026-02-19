declare module "@/wasm/pkg/map_engine_wasm.js" {
  export type CsvLoadResult = {
    valid_rows: number;
    invalid_rows: number;
    bounds: {
      min_lat: number;
      min_lon: number;
      max_lat: number;
      max_lon: number;
    } | null;
  };

  export type MapEngine = {
    resize(width: number, height: number, dpr: number): void;
    pointer_down(x: number, y: number, button: number): void;
    pointer_move(x: number, y: number): void;
    pointer_up(x: number, y: number): void;
    wheel(deltaY: number, x: number, y: number, ctrlKey: boolean): void;
    set_view(lon: number, lat: number, zoom: number): void;
    frame(nowMs: number): void;
    load_trajectory_csv(bytes: Uint8Array): CsvLoadResult;
    clear_trajectory(): void;
    destroy(): void;
  };

  export function init_engine(canvasOrOffscreen: unknown, config: unknown): MapEngine;
  export default function init(): Promise<void>;
}

