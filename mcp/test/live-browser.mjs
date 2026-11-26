// Two-way sync through a real browser (Playwright, optional): agent edits
// show up on the canvas, canvas and code edits come back to the agent,
// and dragged positions survive an agent edit. Run: node test/live-browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bin } from "./bin.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const shots = process.env.SHOTS;
const client = new Client({ name: "live-test", version: "0" });
await client.connect(new StdioClientTransport({
  command: bin, args: [],
  env: { ...process.env, FLOWMAID_PORT: "7990" }, stderr: "pipe",
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
await call("set_diagram", { source: "flowchart TD\n    A[Request] --> B{Valid?}\n    B -->|yes| C[Handle]\n    B -->|no| D[Reject]" });
const { url } = await call("open_live_view", { open: false });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(url);
const until = async (fn, what) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await page.waitForTimeout(100); } throw new Error("timeout: " + what); };
const src = () => page.$eval("#editor", (e) => e.value);
const node = (label) => page.$$eval("#stage svg > g", (gs, l) => { const g = gs.find((x) => x.querySelector("title")?.textContent === l); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, label);

await until(async () => (await src()).includes("A[Request]"), "initial doc in page");
await until(async () => page.$eval("#live-badge", (b) => b.classList.contains("on")), "badge on");
if (shots) await page.screenshot({ path: shots + "/live-1.png" });

// agent → page
await call("edit_diagram", { ops: [{ op: "add_node", label: "Log", from: "D", shape: "cylinder" }, { op: "set_color", ids: ["D"], color: "red" }] });
await until(async () => (await node("Log")) !== null, "agent node on canvas");
assert.match(await src(), /N1\[\(Log\)\]/);
if (shots) await page.screenshot({ path: shots + "/live-2-agent.png" });

// drag a node, then let the agent edit: it must stay where it was put
const c0 = await node("Handle");
await page.mouse.move(c0.x, c0.y); await page.mouse.down(); await page.mouse.move(c0.x - 160, c0.y + 40, { steps: 8 }); await page.mouse.up();
const moved = await node("Handle");
await call("edit_diagram", { ops: [{ op: "rename_node", id: "A", label: "Incoming request" }] });
await until(async () => (await node("Incoming request")) !== null, "rename arrives");
await page.waitForTimeout(300);
const after = await node("Handle");
assert.ok(Math.abs(after.x - moved.x) < 3 && Math.abs(after.y - moved.y) < 3, `drag kept: ${JSON.stringify([moved, after])}`);

// page (canvas toolbar) → agent
const h = await node("Handle");
await page.mouse.move(h.x, h.y);
const add = await page.$eval('#node-tools [data-act="add"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(add.x, add.y, { steps: 5 });
await page.mouse.click(add.x, add.y);
await page.keyboard.type("Respond 200"); await page.keyboard.press("Enter");
let g;
await until(async () => { g = await call("get_diagram"); return g.source.includes("Respond 200"); }, "canvas edit reaches agent");
assert.equal(g.changed_by, "user (live view)");
assert.ok(g.edges.some((e) => e.from === "C" && g.nodes.find((n) => n.id === e.to)?.label === "Respond 200"));

// page (code panel) → agent
await page.click("#editor"); await page.keyboard.press("Control+End"); await page.keyboard.type("\n    C --> A");
await until(async () => (await call("get_diagram")).source.includes("C --> A"), "typing reaches agent");
if (shots) await page.screenshot({ path: shots + "/live-3-user.png" });

// undo in the live view goes back to the agent too
const beforeUndo = (await call("get_diagram")).source;
await page.click("#undo");
await until(async () => (await call("get_diagram")).source !== beforeUndo, "undo reaches agent");
assert.ok(!(await call("get_diagram")).source.includes("C --> A"), "undo removed the typed edge");
await page.click("#redo");
await until(async () => (await call("get_diagram")).source.includes("C --> A"), "redo reaches agent");

// documents the agent creates show up in the switcher, and switching works
await call("set_diagram", { doc: "second", source: "flowchart LR\n    P[Second doc] --> Q" });
await until(async () => (await page.$$eval("#live-badge option", (os) => os.map((o) => o.value))).includes("second"), "doc listed");
await Promise.all([page.waitForNavigation(), page.selectOption("#live-badge select", "second")]);
await until(async () => (await src()).includes("P[Second doc]"), "switched doc loaded");

// the AI dialog knows it is the live view
await page.click("#ai-btn");
assert.match(await page.$eval("#ai-dialog .ai-live", (p) => (p.hidden ? "" : p.textContent)), /"second"/);
if (shots) await page.screenshot({ path: shots + "/live-4-ai.png" });
await page.keyboard.press("Escape");

assert.deepEqual(errs, []);
await browser.close();
await client.close();
console.log("live-browser: ALL OK");
