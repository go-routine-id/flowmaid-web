// The flowmaid engine (wasm) and the playground's source-edit helpers,
// loaded once. Everything here is synchronous and pure: a Mermaid source
// string goes in, SVG / facts / a new source string come out.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Published package: web/ next to src/. Checkout: the repository root.
export const WEB = existsSync(join(here, "..", "web", "index.html"))
  ? join(here, "..", "web")
  : join(here, "..", "..");

const wasm = await import(pathToFileURL(join(WEB, "pkg", "flowmaid_web.js")).href);
wasm.initSync({ module: readFileSync(join(WEB, "pkg", "flowmaid_web_bg.wasm")) });
export const fe = await import(pathToFileURL(join(WEB, "flowedit.js")).href);
export const engineVersion = wasm.engine_version();

const isAdvance = (src) => src.trim().startsWith("{");
const isSwimlane = (src) => src.trim().startsWith("swimlane");

/** Render to SVG; throws with a line-numbered message on parse errors. */
export function renderSvg(src) {
  if (isAdvance(src)) return wasm.render_advance_svg(src);
  if (isSwimlane(src)) return wasm.render_advance_text_svg(src);
  return wasm.render_svg(src);
}

/** Node ids in engine order (empty for diagrams without nodes). */
export function nodeIds(src) {
  return wasm.node_keys(src).split("\n").filter(Boolean);
}

/** null when the source parses, else the engine's error message. */
export function parseError(src) {
  try { renderSvg(src); return null; } catch (e) { return String(e?.message ?? e); }
}

/** The diagram type from the first meaningful line ("flowchart", "erDiagram", …). */
export function diagramType(src) {
  if (isAdvance(src)) return "swimlane-json";
  let front = false;
  const lines = src.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (n === 0 && t === "---") { front = true; continue; }
    if (front) { if (t === "---") front = false; continue; }
    if (!t || t.startsWith("%%")) continue;
    const w = t.split(/\s+/)[0];
    return w === "graph" ? "flowchart" : w;
  }
  return "empty";
}

/** Facts an agent needs to edit: nodes, edges and groups with their ids. */
export function describe(src) {
  const type = diagramType(src);
  const error = parseError(src);
  const out = { type, valid: !error, ...(error ? { error } : {}) };
  if (error) return out;
  if (!fe.isFlowchart(src)) {
    let keys = [];
    try { keys = nodeIds(src); } catch { /* swimlane JSON has no keyed nodes here */ }
    return { ...out, editable: false, nodes: keys.map((id) => ({ id })) };
  }
  const keys = wasm.node_keys(src).split("\n").filter(Boolean);
  const { blocks, member } = fe.subgraphs(src);
  const seen = new Map();
  const edges = fe.edgeList(src).map(([from, to]) => {
    const k = from + "\u0000" + to;
    const nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    const op = fe.edgeOp(src, from, to, nth);
    return {
      from, to,
      ...(nth ? { nth } : {}),
      ...(op?.label ? { label: op.label } : {}),
      style: op?.kind ?? "solid",
      ...(op && !op.end ? { arrow: false } : {}),
    };
  });
  return {
    ...out,
    editable: true,
    nodes: keys.map((id) => ({
      id,
      label: fe.nodeLabel(src, id),
      shape: fe.nodeShape(src, id) ?? "custom",
      ...(fe.nodeFill(src, id) ? { fill: fe.nodeFill(src, id) } : {}),
      ...(member.get(id) ? { group: member.get(id) } : {}),
    })),
    edges,
    groups: blocks.map((b) => ({ id: b.id, title: b.title, ...(b.parent ? { parent: b.parent } : {}) })),
  };
}

// PNG needs a rasteriser; @resvg/resvg-js is optional, so SVG still works
// where it could not be installed.
let resvg;
export async function renderPng(svg, scale = 2) {
  resvg ??= await import("@resvg/resvg-js").then((m) => m.Resvg ?? m.default?.Resvg).catch(() => null);
  if (!resvg) return null;
  const r = new resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    background: "#ffffff",
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  });
  return r.render().asPng();
}
