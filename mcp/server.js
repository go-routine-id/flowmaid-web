#!/usr/bin/env node
// flowmaid MCP server (stdio). Gives an agent tools to read, build, edit
// and render Mermaid-style diagrams with the flowmaid engine, and serves
// the flowmaid playground locally as a live view that stays in sync both
// ways with what the agent sees.
//
// stdout belongs to the MCP protocol: log to stderr only.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describe, engineVersion, parseError, renderPng, renderSvg } from "./src/engine.js";
import { COLORS, SHAPES, STYLES, applyOps } from "./src/ops.js";
import { Store } from "./src/store.js";
import { startLive } from "./src/live.js";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const store = new Store();
let live = null;
try {
  live = await startLive(store);
  console.error(`flowmaid-mcp: live view at ${live.url()}`);
} catch (e) {
  console.error("flowmaid-mcp: live view unavailable:", e.message);
}

const server = new McpServer(
  { name: "flowmaid", version: pkg.version },
  {
    instructions: [
      "flowmaid renders Mermaid-style diagrams (flowchart/graph, erDiagram, classDiagram, sequenceDiagram, stateDiagram, pie, swimlane, …).",
      "Diagrams are named documents (default: \"default\"). Typical loop: get_diagram to learn node/edge ids,",
      "edit_diagram with a list of ops (flowcharts) or set_diagram with full Mermaid source (any type), then render_diagram to look at it.",
      "open_live_view opens the diagram in the user's browser; it stays in sync both ways, so the user may also",
      "edit it there. Call get_diagram again before editing if the user may have changed it (see changed_by / version).",
    ].join(" "),
  },
);

const docArg = z.string().min(1).max(64).regex(/^[\w.-]+$/).optional()
  .describe('Diagram name (default "default"). Each name is a separate document.');

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

function snapshot(d) {
  return {
    doc: d.name,
    version: d.version,
    changed_by: d.origin.startsWith("browser") ? "user (live view)" : d.origin,
    ...(d.file ? { file: d.file } : {}),
    ...(live ? { live_url: live.url(d.name), live_viewers: live.viewers(d.name) } : {}),
    source: d.source,
    ...describe(d.source),
  };
}

server.registerTool("get_diagram", {
  title: "Get diagram",
  description: "Read a diagram: its Mermaid source plus parsed nodes (id, label, shape, fill, group), edges (from, to, nth, label, style) and groups, the live view URL and who changed it last. Use the ids from here in edit_diagram.",
  inputSchema: { doc: docArg },
  annotations: { readOnlyHint: true },
}, async ({ doc }) => text(snapshot(store.get(doc))));

server.registerTool("set_diagram", {
  title: "Set diagram source",
  description: "Replace a diagram's whole Mermaid source (any diagram type). The source is checked with the engine first; on a parse error nothing changes and the line-numbered error is returned. Open live views update immediately.",
  inputSchema: { source: z.string().max(200_000).describe("Full Mermaid source, e.g. \"flowchart TD\\n  A[Start] --> B{OK?}\""), doc: docArg },
}, async ({ source, doc }) => {
  const err = parseError(source);
  if (err) return fail(`Not changed, the source does not parse: ${err}`);
  const d = store.set(doc ?? "default", source, "agent");
  return text(snapshot(d));
});

const ids = z.array(z.string()).min(1).describe("Node ids");
const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), label: z.string(), id: z.string().optional().describe("Defaults to a fresh N1, N2, …"),
    shape: z.enum(SHAPES).optional(), from: z.string().optional().describe("Connect from this node to the new one"),
    edge_label: z.string().optional(), edge_style: z.enum(STYLES).optional() }),
  z.object({ op: z.literal("rename_node"), id: z.string(), label: z.string() }),
  z.object({ op: z.literal("delete_node"), id: z.string().describe("Also removes its edges and style/class lines") }),
  z.object({ op: z.literal("connect"), from: z.string(), to: z.string(), label: z.string().optional(),
    style: z.enum(STYLES).optional(), arrow: z.boolean().optional().describe("false for a line without arrowhead") }),
  z.object({ op: z.literal("update_edge"), from: z.string(), to: z.string(), nth: z.number().int().min(0).optional().describe("Which of several from→to edges, 0-based"),
    label: z.string().optional().describe('"" removes the label'), style: z.enum(STYLES).optional(), reverse: z.boolean().optional() }),
  z.object({ op: z.literal("delete_edge"), from: z.string(), to: z.string(), nth: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("set_shape"), ids, shape: z.enum(SHAPES) }),
  z.object({ op: z.literal("set_color"), ids, color: z.enum([...Object.keys(COLORS), "default"]).optional(),
    fill: z.string().optional().describe("#hex, overrides the named colour"), stroke: z.string().optional() }),
  z.object({ op: z.literal("group"), ids, title: z.string(), id: z.string().optional().describe("Subgraph id, defaults to G1, G2, …") }),
  z.object({ op: z.literal("ungroup"), group: z.string().describe("Subgraph id") }),
]);

server.registerTool("edit_diagram", {
  title: "Edit flowchart",
  description: "Apply a list of edits to a flowchart, in order and all-or-nothing: add_node, rename_node, delete_node, connect, update_edge, delete_edge, set_shape, set_color, group, ungroup. Only the touched lines of the Mermaid source are rewritten. Returns the new state, including ids created by add_node / group. Open live views update immediately.",
  inputSchema: { ops: z.array(Op).min(1).max(200), doc: docArg },
}, async ({ ops, doc }) => {
  const d = store.get(doc);
  let r;
  try { r = applyOps(d.source, ops); } catch (e) { return fail(`Nothing changed: ${e.message}`); }
  store.set(d.name, r.source, "agent");
  return text({ created: r.created, ...snapshot(d) });
});

server.registerTool("render_diagram", {
  title: "Render diagram",
  description: "Render a diagram to look at it: PNG (default) or SVG markup. Renders the named document, or `source` if given (without storing it).",
  inputSchema: {
    doc: docArg,
    source: z.string().max(200_000).optional().describe("Render this source instead of a stored document"),
    format: z.enum(["png", "svg"]).optional(),
    scale: z.number().min(0.5).max(4).optional().describe("PNG scale, default 2"),
  },
  annotations: { readOnlyHint: true },
}, async ({ doc, source, format = "png", scale = 2 }) => {
  const src = source ?? store.get(doc).source;
  let svg;
  try { svg = renderSvg(src); } catch (e) { return fail(String(e?.message ?? e)); }
  if (format === "png") {
    const png = await renderPng(svg, scale);
    if (png) return { content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }] };
    return text(`PNG is unavailable here (optional @resvg/resvg-js is not installed); SVG instead:\n${svg}`);
  }
  return text(svg);
});

server.registerTool("open_live_view", {
  title: "Open live view",
  description: "Open the diagram in the flowmaid playground in the user's browser. The page stays in sync both ways: your edits show up there at once, and the user's edits on the canvas or in the code panel come back (check get_diagram). Returns the URL so you can share it.",
  inputSchema: { doc: docArg, open: z.boolean().optional().describe("Launch the browser (default true); false just returns the URL") },
}, async ({ doc, open = true }) => {
  if (!live) return fail("The live view server could not start (see the server's stderr).");
  const d = store.get(doc);
  const url = live.url(d.name);
  if (open) openBrowser(url);
  return text({ url, doc: d.name, opened: open });
});

server.registerTool("open_file", {
  title: "Bind diagram to a file",
  description: "Bind a diagram to a .mmd file on disk: its content is loaded (or the file is created), every later edit is written back, and changes made to the file by others flow in (and on to live views).",
  inputSchema: {
    path: z.string().describe("Path of the .mmd file (absolute, or relative to the server's working directory)"),
    doc: docArg,
    create_with: z.string().optional().describe("Initial source when the file does not exist yet"),
  },
}, async ({ path, doc, create_with }) => {
  if (create_with !== undefined) {
    const err = parseError(create_with);
    if (err) return fail(`create_with does not parse: ${err}`);
  }
  try {
    return text(snapshot(store.bind(doc ?? "default", path, create_with)));
  } catch (e) {
    return fail(`Could not open ${path}: ${e.message}`);
  }
});

server.registerTool("list_diagrams", {
  title: "List diagrams",
  description: "List the diagram documents in this session with their type, version, bound file and live URL.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => text({
  engine: engineVersion,
  diagrams: store.list().map((d) => ({
    doc: d.name, version: d.version, ...(d.file ? { file: d.file } : {}),
    ...(live ? { live_url: live.url(d.name) } : {}),
    type: describe(d.source).type,
  })),
}));

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch { /* the URL is returned anyway */ }
}

await server.connect(new StdioServerTransport());
// The live view's HTTP server would keep the process alive after the
// client goes away; an MCP stdio server ends with its stdin.
const quit = () => process.exit(0);
process.stdin.on("end", quit);
process.stdin.on("close", quit);
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
