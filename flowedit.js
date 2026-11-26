// flowedit.js — source-level edits for Mermaid flowcharts.
//
// The logic lives in Rust (src/edit.rs) so the playground, the MCP
// server and anything else share one implementation; this module is
// the JS face of its wasm build, keeping the API the page was written
// against. Initialise the wasm module (pkg/flowmaid_web.js) before
// calling anything here. (parseFlow, which exposed the JS parser's
// internal line/segment structure, is gone with that parser.)
import * as w from "./pkg/flowmaid_web.js";

const ids = (list) => list.join("\n");

/** True for `flowchart …` / `graph …` sources (after comments / front matter). */
export const isFlowchart = (src) => w.fe_is_flowchart(src);

/** Every edge [from, to] in source order, as the engine expands them. */
export const edgeList = (src) => JSON.parse(w.fe_edge_list(src));

/** The label a node currently shows (falls back to its id). */
export const nodeLabel = (src, id) => w.fe_node_label(src, id);

/** Format a label for a `[…]` box: bare when safe, quoted otherwise. */
export const formatLabel = (label) => w.fe_format_label(label);

/** Rename a node's label, keeping its shape. Adds `[label]` when it has none. */
export const renameNode = (src, id, label) => w.fe_rename_node(src, id, label);

/** An id not used anywhere in the source (`N1`, `N2`, …). */
export const freshId = (src, taken = [], prefix = "N") => w.fe_fresh_id(src, ids(taken), prefix);

export const addNode = (src, id, label) => w.fe_add_node(src, id, label);
export const addEdge = (src, from, to, op = "-->") => w.fe_add_edge(src, from, to, op);

/** Delete a node, every edge touching it, and its style/class/click lines. */
export const deleteNode = (src, id) => w.fe_delete_node(src, id);

/** Delete the `nth` (0-based) edge from → to, in source order. */
export const deleteEdge = (src, from, to, nth = 0) => w.fe_delete_edge(src, from, to, nth);

/** Split an edge operator: { start, kind, end, label }. */
export const parseOp = (raw) => JSON.parse(w.fe_parse_op(raw));

/** Inverse of parseOp. */
export const buildOp = ({ start = "", kind = "solid", end = ">", label = null }) =>
  w.fe_build_op(start, kind, end, label ?? undefined);

/** The parsed operator of the nth from → to edge, or null. */
export function edgeOp(src, from, to, nth = 0) {
  const j = w.fe_edge_op(src, from, to, nth);
  return j === undefined ? null : JSON.parse(j);
}

export const setEdgeLabel = (src, from, to, nth, label) => w.fe_set_edge_label(src, from, to, nth, label);
/** kind: "solid" | "dotted" | "thick". */
export const setEdgeKind = (src, from, to, nth, kind) => w.fe_set_edge_kind(src, from, to, nth, kind);
export const reverseEdge = (src, from, to, nth) => w.fe_reverse_edge(src, from, to, nth);

/**
 * Set (merge) style props on nodes: `props` like { fill, stroke, color }.
 * A prop set to null is removed; `props` null clears fill/stroke/color.
 */
export function setNodeStyle(src, list, props) {
  if (!props) return w.fe_set_node_style(src, ids(list), "", true);
  const enc = Object.entries(props).map(([k, v]) => `${k}\x1f${v == null ? "\0" : v}`).join("\x1e");
  return w.fe_set_node_style(src, ids(list), enc, false);
}

/** Current fill of a node from its `style` lines (last one wins), or null. */
export const nodeFill = (src, id) => w.fe_node_fill(src, id) ?? null;

/** Subgraph blocks ({ id, title, line, endLine, depth, parent }) and node membership (Map). */
export function subgraphs(src) {
  const { blocks, member } = JSON.parse(w.fe_subgraphs(src));
  return { blocks, member: new Map(member) };
}

/** Wrap nodes in a new `subgraph gid [title]`; throws if they sit in different groups. */
export const groupNodes = (src, list, gid, title) => w.fe_group_nodes(src, ids(list), gid, title);

export const renameGroup = (src, gid, title) => w.fe_rename_group(src, gid, title);

/** Remove a subgraph wrapper, keeping its contents. */
export const ungroup = (src, gid) => w.fe_ungroup(src, gid);

/** Shapes the engine draws distinctly: { key: [open, close] }. */
export const nodeShapes = () => JSON.parse(w.fe_node_shapes());

// Kept for pages that imported the constant: available before the wasm
// is initialised, and checked against nodeShapes() by the tests.
export const NODE_SHAPES = Object.freeze({
  rect: ["[", "]"], rounded: ["(", ")"], stadium: ["([", "])"], subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"], circle: ["((", "))"], doublecircle: ["(((", ")))"],
  diamond: ["{", "}"], hexagon: ["{{", "}}"], parallelogram: ["[/", "/]"], parallelogramalt: ["[\\", "\\]"],
});

/** Current shape key of a node ("rect" when it has no brackets), or null. */
export const nodeShape = (src, id) => w.fe_node_shape(src, id) ?? null;

/** Give nodes another shape, keeping their labels. */
export const setNodeShape = (src, list, key) => w.fe_set_node_shape(src, ids(list), key);

// ── Saved layout (`%% flowmaid:pos` lines) ──

/** Saved node positions: Map id → [x, y]. */
export const readPositions = (src) => new Map(JSON.parse(w.fe_read_positions(src)).map(([id, x, y]) => [id, [x, y]]));

/** Replace the saved positions (Map or [id, [x, y]] entries); empty removes them. */
export function writePositions(src, pos) {
  const enc = [...pos].map(([id, [x, y]]) => `${id}\x1f${x}\x1f${y}`).join("\x1e");
  return w.fe_write_positions(src, enc);
}

// ── Copy / paste ──

/** Mermaid lines for these nodes, the edges among them and their style lines. */
export const extractNodes = (src, list) => w.fe_extract_nodes(src, ids(list));

/** Append a snippet, renaming taken ids: { src, map: Map snippet id → new id }. */
export function pasteNodes(src, snippet) {
  const r = JSON.parse(w.fe_paste_nodes(src, snippet));
  return { src: r.src, map: new Map(r.map) };
}
