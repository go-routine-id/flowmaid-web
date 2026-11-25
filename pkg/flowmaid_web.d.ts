/* tslint:disable */
/* eslint-disable */

/**
 * Automatic-layout centres, flat `[x, y]` pairs.
 */
export function auto_positions(source: string): Float64Array;

/**
 * flowmaid engine version baked into this bundle — derived from
 * Cargo.lock by build.rs, so it can never drift from the crate that
 * was actually compiled in (the old hand-maintained literal sat at
 * "0.4.0" through four engine releases).
 */
export function engine_version(): string;

export function fe_add_edge(src: string, from: string, to: string, op: string): string;

export function fe_add_node(src: string, id: string, label: string): string;

export function fe_build_op(start: string, kind: string, end: string, label?: string | null): string;

export function fe_delete_edge(src: string, from: string, to: string, nth: number): string;

export function fe_delete_node(src: string, id: string): string;

export function fe_edge_list(src: string): string;

export function fe_edge_op(src: string, from: string, to: string, nth: number): string | undefined;

export function fe_format_label(label: string): string;

export function fe_fresh_id(src: string, taken: string, prefix: string): string;

export function fe_group_nodes(src: string, ids_joined: string, gid: string, title: string): string;

export function fe_is_flowchart(src: string): boolean;

export function fe_node_fill(src: string, id: string): string | undefined;

export function fe_node_label(src: string, id: string): string;

export function fe_node_shape(src: string, id: string): string | undefined;

export function fe_node_shapes(): string;

export function fe_parse_op(raw: string): string;

export function fe_rename_group(src: string, gid: string, title: string): string;

export function fe_rename_node(src: string, id: string, label: string): string;

export function fe_reverse_edge(src: string, from: string, to: string, nth: number): string;

export function fe_set_edge_kind(src: string, from: string, to: string, nth: number, kind: string): string;

export function fe_set_edge_label(src: string, from: string, to: string, nth: number, label: string): string;

export function fe_set_node_shape(src: string, ids_joined: string, key: string): string;

/**
 * `props`: entries `key\x1fvalue` joined by `\x1e`; a value of `\0`
 * removes the key. `clear` (props ignored) removes fill/stroke/color.
 */
export function fe_set_node_style(src: string, ids_joined: string, props: string, clear: boolean): string;

export function fe_subgraphs(src: string): string;

export function fe_ungroup(src: string, gid: string): string;

/**
 * Layout an advance / swimlane diagram from JSON and return its
 * geometry as a JSON string: width, height, lanes, nodes, and edges
 * with orthogonal routing points. Serialised by hand so no serde
 * dependency is added to the wasm bundle.
 */
export function layout_advance_json(source: string): string;

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
 * Render an advance / swimlane diagram from JSON with caller-provided
 * node centre positions (flat `[x, y]` pairs in the same order as
 * [`layout_advance_json`]'s `nodes` array). Edges are re-routed and
 * lane boxes are recomputed around the dragged nodes.
 */
export function render_advance_routed(source: string, positions: Float64Array): string;

/**
 * Render an advance / swimlane diagram from JSON with caller-provided
 * node centre positions and explicit lane widths (in the same order as
 * the `lanes` array). Margin and gap are also supplied by the host so
 * the lane background resizes with dragged column borders.
 */
export function render_advance_routed_with_lanes(source: string, positions: Float64Array, lane_widths: Float64Array, margin: number, gap: number): string;

/**
 * Render an advance / swimlane diagram from JSON to an SVG string.
 */
export function render_advance_svg(source: string): string;

/**
 * Render a text-syntax swimlane diagram (`swimlane` header) to an SVG string.
 */
export function render_advance_text_svg(source: string): string;

/**
 * Render with caller-provided centres (flat `[x, y]` pairs, same
 * order as [`node_keys`]) — edges re-route around the dragged
 * positions without re-running layout, exactly like the desktop
 * app's drag path.
 */
export function render_routed(source: string, positions: Float64Array): string;

/**
 * Render Mermaid-syntax text (flowchart / erDiagram / classDiagram /
 * sequenceDiagram / pie)
 * to an SVG string. Errors carry the 1-indexed line number, e.g.
 * `line 3: closing ']' not found`.
 */
export function render_svg(source: string): string;

/**
 * [`render_svg`] without the white canvas `<rect>`, so the SVG sits on
 * the host page's own background (e.g. a dark theme). Text and edge
 * colours are unchanged.
 */
export function render_svg_transparent(source: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly auto_positions: (a: number, b: number) => [number, number, number, number];
    readonly engine_version: () => [number, number];
    readonly layout_advance_json: (a: number, b: number) => [number, number, number, number];
    readonly node_keys: (a: number, b: number) => [number, number, number, number];
    readonly node_sizes: (a: number, b: number) => [number, number, number, number];
    readonly render_advance_routed: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly render_advance_routed_with_lanes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly render_advance_svg: (a: number, b: number) => [number, number, number, number];
    readonly render_advance_text_svg: (a: number, b: number) => [number, number, number, number];
    readonly render_routed: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly render_svg: (a: number, b: number) => [number, number, number, number];
    readonly render_svg_transparent: (a: number, b: number) => [number, number, number, number];
    readonly fe_add_edge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly fe_add_node: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fe_build_op: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly fe_delete_edge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly fe_delete_node: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fe_edge_list: (a: number, b: number) => [number, number];
    readonly fe_edge_op: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly fe_format_label: (a: number, b: number) => [number, number];
    readonly fe_fresh_id: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fe_group_nodes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly fe_is_flowchart: (a: number, b: number) => number;
    readonly fe_node_fill: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fe_node_label: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fe_node_shape: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fe_node_shapes: () => [number, number];
    readonly fe_parse_op: (a: number, b: number) => [number, number];
    readonly fe_rename_group: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fe_rename_node: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fe_reverse_edge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly fe_set_edge_kind: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly fe_set_edge_label: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly fe_set_node_shape: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fe_set_node_style: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly fe_subgraphs: (a: number, b: number) => [number, number];
    readonly fe_ungroup: (a: number, b: number, c: number, d: number) => [number, number];
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
