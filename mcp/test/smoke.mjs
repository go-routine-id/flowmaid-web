// End-to-end: start the server over stdio with the real MCP client, drive
// every tool, and check the live channel (SSE out, POST in) and the file
// binding. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../server.js", import.meta.url).pathname],
  env: { ...process.env, FLOWMAID_PORT: "7999" },
  stderr: "pipe",
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, json: r.content[0]?.type === "text" ? safeJson(r.content[0].text) : null };
};
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(),
  ["edit_diagram", "get_diagram", "list_diagrams", "open_file", "open_live_view", "render_diagram", "set_diagram"]);

// get
let g = (await call("get_diagram")).json;
assert.equal(g.type, "flowchart");
assert.deepEqual(g.nodes.map((n) => n.id), ["A", "B"]);
assert.ok(g.live_url.startsWith("http://127.0.0.1:"));

// edit
let r = await call("edit_diagram", { ops: [
  { op: "rename_node", id: "B", label: "Check input" },
  { op: "set_shape", ids: ["B"], shape: "diamond" },
  { op: "add_node", label: "Save", from: "B", edge_label: "ok", shape: "cylinder" },
  { op: "add_node", label: "Retry", from: "B", edge_label: "no", edge_style: "dotted" },
  { op: "connect", from: "N2", to: "A" },
  { op: "set_color", ids: ["N1"], color: "green" },
  { op: "group", ids: ["N1", "N2"], title: "Outcomes" },
] });
assert.ok(!r.isError, r.content[0].text);
assert.deepEqual(r.json.created, ["N1", "N2", "G1"]);
assert.match(r.json.source, /B\{Check input\}/);
assert.match(r.json.source, /N1\[\(Save\)\]/);
assert.match(r.json.source, /B -\.->\|no\| N2/);
assert.match(r.json.source, /style N1 fill:#e5f5ea,stroke:#2f9e44/);
assert.match(r.json.source, /subgraph G1 \[Outcomes\]/);
assert.equal(r.json.nodes.find((n) => n.id === "N1").group, "G1");
assert.equal(r.json.edges.find((e) => e.to === "N2").style, "dotted");

// errors leave the diagram alone
const before = r.json.source;
r = await call("edit_diagram", { ops: [{ op: "rename_node", id: "A", label: "x" }, { op: "delete_node", id: "ZZ" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /op 2 \(delete_node\): no node with id "ZZ"/);
r = await call("set_diagram", { source: "flowchart TD\n A -->" });
assert.ok(r.isError); assert.match(r.content[0].text, /line 2/);
assert.equal((await call("get_diagram")).json.source, before);

// edge edits
r = await call("edit_diagram", { ops: [{ op: "update_edge", from: "N2", to: "A", label: "again", style: "thick", reverse: true }] });
assert.ok(!r.isError, r.content[0].text);
assert.ok(r.json.edges.some((e) => e.from === "A" && e.to === "N2" && e.label === "again" && e.style === "thick"));

// render
r = await call("render_diagram");
assert.equal(r.content[0].type, "image");
assert.ok(Buffer.from(r.content[0].data, "base64").subarray(1, 4).toString() === "PNG");
r = await call("render_diagram", { format: "svg", source: "erDiagram\n a ||--o{ b : has" });
assert.match(r.content[0].text, /^<svg/);

// other diagram types: set works, edit refuses
r = await call("set_diagram", { doc: "seq", source: "sequenceDiagram\n  A->>B: hi" });
assert.ok(!r.isError); assert.equal(r.json.type, "sequenceDiagram"); assert.equal(r.json.editable, false);
r = await call("edit_diagram", { doc: "seq", ops: [{ op: "delete_node", id: "A" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /flowchart/);

// live channel: SSE gets agent edits, POST brings user edits back
const url = new URL((await call("get_diagram")).json.live_url);
const t = url.searchParams.get("t");
const base = `${url.origin}/__events?doc=default&t=${t}`;
assert.equal((await fetch(`${url.origin}/__events?doc=default&t=wrong`)).status, 403);
const page = await fetch(url);
assert.match(await page.text(), /__live\.js/);
const ac = new AbortController();
const sse = await fetch(base, { signal: ac.signal });
const reader = sse.body.getReader();
const events = [];
(async () => {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ done: true }));
    if (done) return;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
})();
const waitFor = async (pred) => { for (let k = 0; k < 50; k++) { if (pred()) return; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error("timeout"); };
await waitFor(() => events.length >= 1);
await call("edit_diagram", { ops: [{ op: "rename_node", id: "A", label: "Begin" }] });
await waitFor(() => events.some((e) => e.origin === "agent" && e.source.includes("A[Begin]")));
const userSrc = (await call("get_diagram")).json.source.replace("A[Begin]", "A[Typed by user]");
const post = await fetch(`${url.origin}/__source?doc=default&t=${t}`, { method: "POST", body: JSON.stringify({ source: userSrc, client: "test" }) });
assert.equal(post.status, 200);
g = (await call("get_diagram")).json;
assert.equal(g.changed_by, "user (live view)");
assert.match(g.source, /A\[Typed by user\]/);
ac.abort();

// file binding: load, write back, follow outside changes
const dir = mkdtempSync(join(tmpdir(), "flowmaid-mcp-"));
const file = join(dir, "flow.mmd");
writeFileSync(file, "flowchart LR\n    X[From file] --> Y\n");
r = await call("open_file", { path: file, doc: "f" });
assert.ok(!r.isError, r.content[0].text);
assert.deepEqual(r.json.nodes.map((n) => n.id), ["X", "Y"]);
await call("edit_diagram", { doc: "f", ops: [{ op: "add_node", label: "Z", from: "Y" }] });
assert.match(readFileSync(file, "utf8"), /N1\[Z\]/);
writeFileSync(file, "flowchart LR\n    X[Edited outside] --> Y\n");
await waitFor(() => false).catch(() => {});
g = (await call("get_diagram", { doc: "f" })).json;
assert.match(g.source, /Edited outside/);
assert.equal(g.changed_by, "file");

const list = (await call("list_diagrams")).json;
assert.deepEqual(list.diagrams.map((d) => d.doc).sort(), ["default", "f", "seq"]);

await client.close();
console.log("smoke: ALL OK");
