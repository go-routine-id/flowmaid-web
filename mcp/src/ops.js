// Structured edits on a flowchart source, the same ones the playground's
// canvas makes. Each op is checked against the current ids first so an
// agent gets a clear error instead of a silently broken diagram.
import { fe, nodeIds, parseError } from "./engine.js";

export const SHAPES = Object.keys(fe.NODE_SHAPES);
export const STYLES = ["solid", "dotted", "thick"];
// Same palette as the playground's colour popover.
export const COLORS = {
  blue: ["#e7f0ff", "#3b6fd8"], green: ["#e5f5ea", "#2f9e44"], yellow: ["#fff3bf", "#f08c00"],
  orange: ["#ffe8cc", "#e8590c"], red: ["#ffe3e3", "#e03131"], pink: ["#ffdeeb", "#d6336c"],
  purple: ["#f3e8ff", "#8839ef"], teal: ["#e3fafc", "#1098ad"], grey: ["#f1f3f5", "#868e96"],
};
const ID = /^[\p{L}\p{N}_]+$/u;
const HEX = /^#[0-9a-f]{3,8}$/i;

function need(cond, msg) { if (!cond) throw new Error(msg); }

/** Apply ops in order; returns { source, created }. Throws "op N (name): reason". */
export function applyOps(source, ops) {
  need(fe.isFlowchart(source), "edit_diagram works on flowchart / graph diagrams; use set_diagram to change other diagram types.");
  const startErr = parseError(source);
  need(!startErr, `The current source does not parse, fix it with set_diagram first: ${startErr}`);
  let src = source;
  const created = [];
  ops.forEach((o, i) => {
    try {
      src = applyOne(src, o, created);
    } catch (e) {
      throw new Error(`op ${i + 1} (${o.op}): ${e.message}`);
    }
  });
  const err = parseError(src);
  need(!err, `the edits produced a source that does not parse (${err}); nothing was changed`);
  return { source: src, created };
}

function applyOne(src, o, created) {
  const ids = new Set(nodeIds(src));
  const has = (id) => need(ids.has(id), `no node with id "${id}" (ids: ${[...ids].join(", ") || "none"})`);
  const edgeExists = (from, to, nth) => need(fe.edgeOp(src, from, to, nth) !== null, `no edge ${from} → ${to}${nth ? ` #${nth}` : ""}`);
  const op = (style, label, arrow = true) => fe.buildOp({ kind: style ?? "solid", end: arrow ? ">" : "", label: label ?? null });

  switch (o.op) {
    case "add_node": {
      const id = o.id ?? fe.freshId(src, [...ids]);
      need(ID.test(id), `id "${id}" must be letters, digits or _`);
      need(!ids.has(id), `id "${id}" is already used`);
      src = fe.addNode(src, id, o.label);
      if (o.shape && o.shape !== "rect") src = fe.setNodeShape(src, [id], o.shape);
      if (o.from) { has(o.from); src = fe.addEdge(src, o.from, id, op(o.edge_style, o.edge_label)); }
      created.push(id);
      return src;
    }
    case "rename_node": has(o.id); return fe.renameNode(src, o.id, o.label);
    case "delete_node": has(o.id); return fe.deleteNode(src, o.id);
    case "connect":
      has(o.from); has(o.to);
      return fe.addEdge(src, o.from, o.to, op(o.style, o.label, o.arrow ?? true));
    case "update_edge": {
      const nth = o.nth ?? 0;
      edgeExists(o.from, o.to, nth);
      if (o.label !== undefined) src = fe.setEdgeLabel(src, o.from, o.to, nth, o.label);
      if (o.style) src = fe.setEdgeKind(src, o.from, o.to, nth, o.style);
      if (o.reverse) src = fe.reverseEdge(src, o.from, o.to, nth);
      return src;
    }
    case "delete_edge": edgeExists(o.from, o.to, o.nth ?? 0); return fe.deleteEdge(src, o.from, o.to, o.nth ?? 0);
    case "set_shape": o.ids.forEach(has); return fe.setNodeShape(src, o.ids, o.shape);
    case "set_color": {
      o.ids.forEach(has);
      if (o.color === "default" && !o.fill && !o.stroke) return fe.setNodeStyle(src, o.ids, null);
      const [fill, stroke] = o.color && o.color !== "default" ? COLORS[o.color] : [o.fill, o.stroke];
      const f = o.fill ?? fill, s = o.stroke ?? stroke;
      need(f || s, "give a color name, or fill / stroke");
      for (const c of [f, s]) need(!c || HEX.test(c), `"${c}" is not a #hex colour`);
      return fe.setNodeStyle(src, o.ids, { ...(f ? { fill: f } : {}), ...(s ? { stroke: s } : {}) });
    }
    case "group": {
      o.ids.forEach(has);
      const gid = o.id ?? fe.freshId(src, [...ids], "G");
      need(ID.test(gid), `group id "${gid}" must be letters, digits or _`);
      need(!fe.subgraphs(src).blocks.some((b) => b.id === gid) && !ids.has(gid), `id "${gid}" is already used`);
      src = fe.groupNodes(src, o.ids, gid, o.title);
      created.push(gid);
      return src;
    }
    case "ungroup":
      need(fe.subgraphs(src).blocks.some((b) => b.id === o.group), `no group "${o.group}"`);
      return fe.ungroup(src, o.group);
    default:
      throw new Error("unknown op");
  }
}
