/* tslint:disable */
/* eslint-disable */

export class MapEngine {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    clear_trajectory(): void;
    destroy(): void;
    frame(_now_ms: number): void;
    load_trajectory_csv(bytes: Uint8Array): any;
    pointer_down(x: number, y: number, button: number): void;
    pointer_move(x: number, y: number): void;
    pointer_up(_x: number, _y: number): void;
    resize(width: number, height: number, dpr: number): void;
    set_view(lon: number, lat: number, zoom: number): void;
    wheel(delta_y: number, x: number, y: number, _ctrl_key: boolean): void;
}

export function init_engine(canvas_or_offscreen: any, config: any): MapEngine;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mapengine_free: (a: number, b: number) => void;
    readonly init_engine: (a: any, b: any) => [number, number, number];
    readonly mapengine_clear_trajectory: (a: number) => void;
    readonly mapengine_destroy: (a: number) => void;
    readonly mapengine_frame: (a: number, b: number) => void;
    readonly mapengine_load_trajectory_csv: (a: number, b: number, c: number) => [number, number, number];
    readonly mapengine_pointer_down: (a: number, b: number, c: number, d: number) => void;
    readonly mapengine_pointer_move: (a: number, b: number, c: number) => void;
    readonly mapengine_pointer_up: (a: number, b: number, c: number) => void;
    readonly mapengine_resize: (a: number, b: number, c: number, d: number) => void;
    readonly mapengine_set_view: (a: number, b: number, c: number, d: number) => void;
    readonly mapengine_wheel: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_bindgen__closure__destroy__h83ed2f27720389ea: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf61daddeb0e223da: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
