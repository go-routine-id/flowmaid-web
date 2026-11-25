// Is the committed pkg/ a build of the current src/edit.rs? Runs the
// same randomised calls through the committed wasm and a fresh build
// (path to its flowmaid_web.js as the argument) and compares results.
// CI: catches a Rust change that was not followed by scripts/build-wasm.sh.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const load = async (js) => {
  const m = await import(pathToFileURL(js).href);
  m.initSync({ module: fs.readFileSync(js.replace(/\.js$/, "_bg.wasm")) });
  return m;
};
const committed = await load(new URL("../pkg/flowmaid_web.js", import.meta.url).pathname);
const fresh = await load(process.argv[2]);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const IDS = ["A", "B", "C", "D", "Ä", "x"];
const SH = ["", "[L]", "(R)", "([S])", "{D}", "{{H}}", "[/P/]", '["q (x)"]', "((C))"];
const OPS = ["-->", "---", "-.->", "==>", "-->|yes|", "-- t -->", "--o", "<-->"];
const ref = () => pick(IDS) + (rnd() < 0.4 ? pick(SH) : "");
const stmt = () => { let s = rnd() < 0.2 ? `${ref()} & ${ref()}` : ref(); for (let i = Math.floor(rnd() * 3); i > 0; i--) s += ` ${pick(OPS)} ${ref()}`; return s; };
const doc = () => {
  const out = [pick(["flowchart TD", "graph LR"])];
  for (let i = 2 + Math.floor(rnd() * 6); i > 0; i--) {
    const r = rnd();
    out.push(r < 0.7 ? "    " + stmt() : r < 0.8 ? `    subgraph G${i} [T]\n        ${stmt()}\n    end` : r < 0.9 ? `    style ${pick(IDS)} fill:#fff` : "    linkStyle 0 stroke:red");
  }
  return out.join("\n");
};

let n = 0;
const same = (name, f) => {
  n++;
  const run = (m) => { try { return JSON.stringify(f(m)); } catch (e) { return "throws " + e.message; } };
  const a = run(committed), b = run(fresh);
  if (a !== b) { console.error(`pkg/ is stale: ${name}\n committed: ${a}\n fresh:     ${b}\nRebuild with scripts/build-wasm.sh.`); process.exit(1); }
};
for (let t = 0; t < 1500; t++) {
  const s = doc(), id = pick(IDS), [f, to] = JSON.parse(committed.fe_edge_list(s))[0] ?? ["A", "B"];
  same(`edge_list ${s}`, (m) => m.fe_edge_list(s));
  same(`subgraphs ${s}`, (m) => m.fe_subgraphs(s));
  same(`node_label/shape/fill ${id}`, (m) => [m.fe_node_label(s, id), m.fe_node_shape(s, id), m.fe_node_fill(s, id)]);
  same(`rename ${id}`, (m) => m.fe_rename_node(s, id, "New (x)"));
  same(`delete_node ${id}`, (m) => m.fe_delete_node(s, id));
  same(`add`, (m) => m.fe_add_edge(m.fe_add_node(s, "N9", "n"), id, "N9", "-.->"));
  same(`delete_edge`, (m) => m.fe_delete_edge(s, f, to, 0));
  same(`edge edits`, (m) => [m.fe_edge_op(s, f, to, 0), m.fe_set_edge_label(s, f, to, 0, "go"), m.fe_set_edge_kind(s, f, to, 0, "thick"), m.fe_reverse_edge(s, f, to, 0)]);
  const shape = pick(["circle", "diamond", "cylinder"]); // picked once: both builds get the same call
  same(`shape/style`, (m) => [m.fe_set_node_shape(s, `${id}\nB`, shape), m.fe_set_node_style(s, id, "fill\x1f#e7f0ff", false)]);
  same(`group`, (m) => { const g = m.fe_group_nodes(s, `${id}\nB`, "G9", "T"); return [g, m.fe_ungroup(g, "G9"), m.fe_rename_group(g, "G9", "U")]; });
}
console.log(`pkg/ matches src/edit.rs (${n} calls compared)`);
