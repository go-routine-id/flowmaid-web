// End-to-end: start the server over stdio with the real MCP client, drive
// every tool, and check the live channel (SSE out, POST in) and the file
// binding, against the Rust binary. Run: cargo build -p flowmaid-mcp && npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bin } from "./bin.mjs";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: bin, args: [],
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
  ["edit_diagram", "get_diagram", "get_selection", "list_diagrams", "open_file", "open_live_view", "render_diagram", "reply_chat", "set_diagram"]);

// a Claude Code channel, on the last protocol with an initialize handshake
assert.deepEqual(client.getServerCapabilities().experimental, { "claude/channel": {} });
const channel = [];
client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/claude/channel") channel.push(n.params); };

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

// review fixes ─────────────────────────────────────────────────────────
// an outside revert to text we wrote earlier still flows in
await call("edit_diagram", { doc: "f", ops: [{ op: "rename_node", id: "X", label: "Agent wrote" }] });
const agentText = readFileSync(file, "utf8");
writeFileSync(file, "flowchart LR\n    X[Someone else] --> Y\n");
await waitFor(() => false).catch(() => {});
writeFileSync(file, agentText);
await waitFor(() => false).catch(() => {});
assert.match((await call("get_diagram", { doc: "f" })).json.source, /Agent wrote/, "revert seen");
// editors that save by renaming a temp file over the original
writeFileSync(file + ".swp", "flowchart LR\n    X[Saved by vim] --> Y\n");
renameSync(file + ".swp", file);
await waitFor(() => false).catch(() => {});
assert.match((await call("get_diagram", { doc: "f" })).json.source, /Saved by vim/, "rename-save seen");
// a failed open_file keeps the earlier binding
r = await call("open_file", { path: dir, doc: "f" });
assert.ok(r.isError);
g = (await call("get_diagram", { doc: "f" })).json;
assert.equal(g.file, file);
await call("edit_diagram", { doc: "f", ops: [{ op: "rename_node", id: "X", label: "Still bound" }] });
assert.match(readFileSync(file, "utf8"), /Still bound/);
// a malformed request can't take the server down
await new Promise((ok) => {
  const sock = net.connect(Number(url.port), "127.0.0.1", () => sock.end("GET / HTTP/1.1\r\nHost: [\r\n\r\n"));
  sock.on("data", () => {}); sock.on("close", ok); sock.on("error", ok);
});
assert.equal((await fetch(url)).status, 200, "server alive after bad Host");
// a browser edit built on an old version is refused, not applied
const cur = (await call("get_diagram")).json;
let res = await fetch(`${url.origin}/__source?doc=default&t=${t}`, { method: "POST", body: JSON.stringify({ source: cur.source + "\n    Q", client: "x", base: cur.version - 1 }) });
assert.equal(res.status, 409);
assert.equal((await call("get_diagram")).json.source, cur.source);
res = await fetch(`${url.origin}/__source?doc=default&t=${t}`, { method: "POST", body: JSON.stringify({ source: cur.source + "\n    Q", client: "x", base: cur.version }) });
assert.equal(res.status, 200);
// names the tools would refuse are refused by the live channel too
assert.equal((await fetch(`${url.origin}/__events?doc=${encodeURIComponent("my diagram")}&t=${t}`)).status, 400);
// reading a diagram that doesn't exist doesn't create it
r = await call("get_diagram", { doc: "nope" });
assert.ok(r.isError); assert.match(r.content[0].text, /No diagram named "nope"/);
r = await call("render_diagram", { doc: "nope" });
assert.ok(r.isError);

// second review ──────────────────────────────────────────────────────
// deleting a node whose lines end the source (no trailing newline) works
r = await call("set_diagram", { doc: "del", source: "flowchart TD\n    A --> B\n    A --> B" });
r = await call("edit_diagram", { doc: "del", ops: [{ op: "delete_node", id: "B" }] });
assert.ok(!r.isError, r.content[0].text);
assert.deepEqual(r.json.nodes.map((n) => n.id), ["A"]); // A survives (it was only in the dropped lines)
// keyword ids are refused, and existing keyword nodes say why ops can't touch them
r = await call("edit_diagram", { doc: "del", ops: [{ op: "add_node", id: "end", label: "Finish" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /Mermaid keyword/);
await call("set_diagram", { doc: "del", source: "flowchart TD\n    A --> end[Finish]" });
r = await call("edit_diagram", { doc: "del", ops: [{ op: "rename_node", id: "end", label: "Done" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /keyword as its id/);
// a mistyped doc name is an error, not a new diagram
r = await call("edit_diagram", { doc: "defualt", ops: [{ op: "add_node", label: "X" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /No diagram named "defualt"/);
// "default" colour resets before an explicit fill
await call("set_diagram", { doc: "del", source: "flowchart TD\n    A --> B\n    style A fill:#e5f5ea,stroke:#2f9e44" });
r = await call("edit_diagram", { doc: "del", ops: [{ op: "set_color", ids: ["A"], color: "default", fill: "#ffffff" }] });
assert.match(r.json.source, /style A fill:#ffffff$/m);
// only real CSS hex lengths
r = await call("edit_diagram", { doc: "del", ops: [{ op: "set_color", ids: ["A"], fill: "#12345" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /not a #hex/);
// the size limit holds for edits and live POSTs too
const near = "flowchart TD\n    A[" + "x".repeat(195_000) + "] --> B";
await call("set_diagram", { doc: "del", source: near });
r = await call("edit_diagram", { doc: "del", ops: [{ op: "add_node", label: "y".repeat(10_000) }] });
assert.ok(r.isError); assert.match(r.content[0].text, /200 kB/);
res = await fetch(`${url.origin}/__source?doc=del&t=${t}`, { method: "POST", body: JSON.stringify({ source: near + "x".repeat(10_000), client: "x" }) });
assert.equal(res.status, 413);
// a bound file that can't be written: the edit is refused, nothing changes
const dir2 = mkdtempSync(join(tmpdir(), "flowmaid-mcp-"));
const file2 = join(dir2, "w.mmd");
await call("open_file", { path: file2, doc: "w", create_with: "flowchart TD\n    A --> B\n" });
rmSync(dir2, { recursive: true });
r = await call("edit_diagram", { doc: "w", ops: [{ op: "rename_node", id: "A", label: "Lost?" }] });
assert.ok(r.isError); assert.match(r.content[0].text, /could not write/);
await waitFor(() => false).catch(() => {});
g = (await call("get_diagram", { doc: "w" })).json;
assert.equal(g.source, "flowchart TD\n    A --> B\n");

const list = (await call("list_diagrams")).json;
assert.deepEqual(list.diagrams.map((d) => d.doc).sort(), ["default", "del", "f", "seq", "w"]);

// chat: page → channel notification (with the selection), reply_chat → page
{
  const u = new URL((await call("open_live_view", { open: false })).json.url);
  const t = u.searchParams.get("t");
  const post = (path, body, tok = t) => fetch(`${u.origin}${path}?doc=default&t=${tok}`, { method: "POST", body: JSON.stringify(body) });
  await post("/__selection", { selection: { type: "node", id: "A" }, version: 1 });
  assert.equal((await post("/__chat", { text: "  make this red  " })).status, 202);
  for (let i = 0; i < 50 && !channel.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(channel[0], { content: "make this red", meta: { doc: "default", selection: '{"type":"node","id":"A"}' } });
  assert.equal((await post("/__chat", { text: "x" }, "bad")).status, 403);
  assert.equal((await post("/__chat", { text: "   " })).status, 400);
  assert.equal((await post("/__chat", { text: "x".repeat(4001) })).status, 413);
  assert.equal(channel.length, 1);
  // replies reach a page listening on that doc
  const ctl = new AbortController();
  const res = await fetch(`${u.origin}/__chat_events?doc=default&t=${t}`, { signal: ctl.signal });
  const reader = res.body.getReader();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!(await call("reply_chat", { doc: "default", text: "Done: A is red." })).isError);
  let got = "";
  while (!got.includes("Done: A is red.")) got += new TextDecoder().decode((await reader.read()).value);
  assert.match(got, /event: reply\ndata: \{"text":"Done: A is red."\}/);
  ctl.abort();
}

await client.close();
// FLOWMAID_PORT=0 lets the OS pick a port
const c2 = new Client({ name: "smoke2", version: "0" });
await c2.connect(new StdioClientTransport({ command: bin, args: [], env: { ...process.env, FLOWMAID_PORT: "0" }, stderr: "pipe" }));
const u2 = JSON.parse((await c2.callTool({ name: "open_live_view", arguments: { open: false } })).content[0].text).url;
assert.ok(!u2.includes(":7878/") && !u2.includes(":7999/"), u2);
assert.equal((await fetch(u2)).status, 200);
await c2.close();

console.log("smoke: ALL OK");
