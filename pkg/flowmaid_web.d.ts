/* tslint:disable */
/* eslint-disable */

/**
 * Automatic-layout centres, flat `[x, y]` pairs.
 */
export function auto_positions(source: string): Float64Array;

/**
 * flowmaid engine version baked into this bundle.
 */
export function engine_version(): string;

/**
 * Identity key per node (flowchart node id / ER entity name),
 * newline-joined, in the same order as every array below. Used to
 * preserve dragged positions across text edits.
 */
export function node_keys(source: string): string;

/**
 * Node box sizes, flat `[w, h]` pairs — position-independent, so
 * the host can hit-test drags with centres + these.
 */
export function node_sizes(source: string): Float64Array;

/**
 * Render with caller-provided centres (flat `[x, y]` pairs, same
 * order as [`node_keys`]) — edges re-route around the dragged
 * positions without re-running layout, exactly like the desktop
 * app's drag path.
 */
export function render_routed(source: string, positions: Float64Array): string;

/**
 * Render Mermaid-syntax text (flowchart / erDiagram) to an SVG
 * string. Errors carry the 1-indexed line number, e.g.
 * `line 3: closing ']' not found`.
 */
export function render_svg(source: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly auto_positions: (a: number, b: number) => [number, number, number, number];
    readonly engine_version: () => [number, number];
    readonly node_keys: (a: number, b: number) => [number, number, number, number];
    readonly node_sizes: (a: number, b: number) => [number, number, number, number];
    readonly render_routed: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly render_svg: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
