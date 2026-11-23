// Source-edit tests for flowedit.js, checked against the real engine.
// Run: node tests/flowedit.test.mjs
import fs from "fs";
import assert from "assert/strict";
import * as m from "../pkg/flowmaid_web.js";
import * as fe from "../flowedit.js";
m.initSync({module: fs.readFileSync(new URL("../pkg/flowmaid_web_bg.wasm", import.meta.url))});
const titles = (src) => [...m.render_routed(src, m.auto_positions(src)).matchAll(/<title>([^<]*) → ([^<:]*)(?::[^<]*)?<\/title>/g)].map(x=>[x[1],x[2]]);
const ok = (src) => { m.node_keys(src); return src; };
const A = `flowchart TD
    A([Start]) --> B[Read input]
    B --> C{Valid?}
    C -->|yes| D[Process data]
    C -->|no| E[Show error]
    E --> B
    D ==> F((Done))`;
const B = `graph LR
A & B --> C & D
C --- E
E -- hi there --> A
A --> B; B -.-> X[(db)]
X["a (b)"] --> Y>asym] -.->|k| Z[(db)]:::store
subgraph S1 [Group]
  P --> Q
end
S1 --> A
Q@{ shape: circle, label: "Qq" }
style A fill:#fff
class A,B store
classDef store fill:#eee`;
for (const s of [A, B]) assert.deepEqual(fe.edgeList(s), titles(s), "edge order");
assert.equal(fe.isFlowchart(A), true); assert.equal(fe.isFlowchart("%% x\nerDiagram"), false);
assert.equal(fe.nodeLabel(A,"C"), "Valid?"); assert.equal(fe.nodeLabel(B,"X"), "a (b)"); assert.equal(fe.nodeLabel(B,"Q"), "Qq"); assert.equal(fe.nodeLabel(B,"E"), "E");
let s;
s = ok(fe.renameNode(A, "C", "Is it (ok)?")); assert.match(s, /C\{"Is it \(ok\)\?"\}/); assert.equal(fe.nodeLabel(s,"C"), "Is it (ok)?");
s = ok(fe.renameNode(B, "E", "Echo")); assert.match(s, /C --- E\[Echo\]/);
s = ok(fe.renameNode(B, "Q", "New Q")); assert.match(s, /label: "New Q"/);
s = ok(fe.addNode(A, fe.freshId(A), "New node")); assert.match(s, /\n    N1\[New node\]$/);
s = ok(fe.addEdge(A, "F", "A")); assert.deepEqual(titles(s).at(-1), ["F","A"]);
const cnt = (src) => titles(src).length;
for (const src of [A,B]) {
  const edges = fe.edgeList(src);
  const seen = new Map();
  edges.forEach(([a,b]) => {
    const k=a+">"+b, n=seen.get(k)??0; seen.set(k,n+1);
    const out = ok(fe.deleteEdge(src,a,b,n));
    assert.equal(cnt(out), cnt(src)-1, `delete ${k}#${n}\n${out}`);
    const keysBefore = m.node_keys(src).split("\n").sort(), keysAfter = m.node_keys(out).split("\n").sort();
    assert.deepEqual(keysAfter, keysBefore, `nodes kept ${k}\n${out}`);
  });
  for (const id of m.node_keys(src).split("\n").filter(Boolean)) {
    const out = ok(fe.deleteNode(src,id));
    const keys = m.node_keys(out).split("\n");
    assert.ok(!keys.includes(id), `deleted ${id}\n${out}`);
    assert.equal(keys.length, m.node_keys(src).split("\n").length - 1, `only ${id}\n${out}`);
    assert.ok(!titles(out).some(([a,b])=>a===id||b===id));
  }
}
// Statements on the header line.
const H = "graph LR; A-->B; B-->C";
assert.deepEqual(fe.edgeList(H), titles(H));
assert.equal(ok(fe.deleteEdge(H, "A", "B")).includes("A-->B"), false);
assert.ok(!m.node_keys(ok(fe.deleteNode(H, "A"))).split("\n").includes("A"));
// `--o` / `--x` arrows are edges, not the start of `-- text -->`.
const O = "graph LR\nA --o B --> C";
assert.deepEqual(fe.edgeList(O), [["A", "B"], ["B", "C"]]);
assert.deepEqual(fe.edgeList(O), titles(O));
// linkStyle indices follow removed edges.
const L = "graph LR\nA-->B\nB-->C\nC-->D\nlinkStyle 0,2 stroke:red\nlinkStyle 1 stroke:blue";
assert.equal(ok(fe.deleteEdge(L, "A", "B")), "graph LR\nA\nB-->C\nC-->D\nlinkStyle 1 stroke:red\nlinkStyle 0 stroke:blue");
assert.equal(ok(fe.deleteNode(L, "B")), "graph LR\nA\nC-->D\nlinkStyle 0 stroke:red");
// Non-ASCII ids get their style lines scrubbed too.
const U = "graph LR\nÄ[x] --> B\nstyle Ä fill:#f00\nstyle B fill:#0f0";
assert.equal(ok(fe.deleteNode(U, "Ä")), "graph LR\nB\nstyle B fill:#0f0");

// ── Edges, colours, groups ──
{
const svg = (s) => m.render_routed(s, m.auto_positions(s));
const titles = (s) => [...svg(s).matchAll(/<title>([^<]*→[^<]*)<\/title>/g)].map(x => x[1]);
// ops
for (const [raw, exp] of [["-->", {start:"",kind:"solid",end:">",label:null}], ["-->|yes|", {start:"",kind:"solid",end:">",label:"yes"}],
  ["-- hi there -->", {start:"",kind:"solid",end:">",label:"hi there"}], ["-.->", {start:"",kind:"dotted",end:">",label:null}],
  ["==>", {start:"",kind:"thick",end:">",label:null}], ["---", {start:"",kind:"solid",end:"",label:null}], ["<-->", {start:"<",kind:"solid",end:">",label:null}],
  ["--o", {start:"",kind:"solid",end:"o",label:null}], ["x--x", {start:"x",kind:"solid",end:"x",label:null}], ["-. t .->", {start:"",kind:"dotted",end:">",label:"t"}]]) {
  assert.deepEqual(fe.parseOp(raw), exp, raw);
}
assert.equal(fe.buildOp({kind:"dotted", end:">", label:"a"}), "-.->|a|");
assert.equal(fe.buildOp({kind:"thick", end:""}), "===");
const S = "flowchart TD\n    A[Start] --> B[Read]\n    B -->|yes| C{OK?}\n    C & D --> E\n    X --> Y --> Z";
let s;
s = fe.setEdgeLabel(S, "A", "B", 0, "go"); assert.match(s, /A\[Start\] -->\|go\| B\[Read\]/); assert.ok(titles(s).includes("A → B: go"));
s = fe.setEdgeLabel(S, "B", "C", 0, ""); assert.match(s, /B --> C\{OK\?\}/);
s = fe.setEdgeKind(S, "B", "C", 0, "dotted"); assert.match(s, /B -\.->\|yes\| C/); assert.match(svg(s), /stroke-dasharray="2 3"/);
s = fe.setEdgeKind(S, "A", "B", 0, "thick"); assert.match(s, /A\[Start\] ==> B\[Read\]/);
s = fe.reverseEdge(S, "A", "B", 0); assert.match(s, /B\[Read\] --> A\[Start\]/); assert.ok(titles(s).includes("B → A"));
s = fe.reverseEdge(S, "C", "E", 0); assert.ok(titles(s).includes("E → C") && titles(s).includes("D → E") && !titles(s).includes("C → E"), s);
s = fe.reverseEdge(S, "Y", "Z", 0); assert.ok(titles(s).includes("Z → Y") && titles(s).includes("X → Y"), s);
s = fe.setEdgeLabel(S, "X", "Y", 0, "a|b"); assert.ok(titles(s).some(t => t.startsWith("X → Y: ")), s); m.node_keys(s);
assert.equal(fe.edgeOp(S, "B", "C", 0).label, "yes");
// style
s = fe.setNodeStyle(S, ["A", "B"], { fill: "#ffe3e3", stroke: "#e03131" });
assert.match(s, /style A fill:#ffe3e3,stroke:#e03131\n    style B fill:#ffe3e3,stroke:#e03131$/);
assert.match(svg(s), /fill="#ffe3e3" stroke="#e03131"/);
assert.equal(fe.nodeFill(s, "A"), "#ffe3e3");
let s2 = fe.setNodeStyle(s + "\n    style A stroke-width:3px", ["A"], { fill: "#e5f5ea", stroke: "#33a35c" });
assert.equal((s2.match(/style A /g) || []).length, 1); assert.match(s2, /style A fill:#e5f5ea,stroke:#33a35c,stroke-width:3px/);
s2 = fe.setNodeStyle(s2, ["A"], null); assert.match(s2, /style A stroke-width:3px/);
s2 = fe.setNodeStyle(s, ["A"], null); assert.ok(!/style A/.test(s2));
// groups
s = fe.groupNodes(S, ["A", "B"], "G1", "Input");
assert.match(s, /\n    subgraph G1 \[Input\]\n        A\n        B\n    end$/, s);
assert.match(svg(s), />Input</);
assert.equal(fe.subgraphs(s).member.get("A"), "G1");
const s3 = fe.groupNodes(s, ["A"], "G2", "Inner");
assert.equal(fe.subgraphs(s3).member.get("A"), "G2"); assert.match(svg(s3), />Inner</); assert.throws(() => fe.groupNodes(s, ["A", "X"], "G2", "x"), /different groups/);
assert.equal(fe.ungroup(s, "G1"), S);
assert.equal(fe.deleteNode(fe.deleteNode(s, "A"), "B").includes("subgraph"), false);
assert.equal(fe.renameGroup(s, "G1", "In put (x)").includes('subgraph G1 ["In put (x)"]'), true);
}
// ── Shapes ──
{
  const S = 'flowchart TD\n    A[Start] --> B\n    B --> C(["a (b)"])\n    D{{Hex}} --> E[/In/]\n    F@{ shape: circle, label: "Qq" }';
  const shapeOf = (src, label) => { const s = m.render_svg(src); const g = s.match(new RegExp(`<g><title>${label.replace(/[()]/g, "\\$&")}</title>\\s*<(\\w+)([^>]*)>`)); return g && (g[1] + (g[1] === "rect" ? ":" + g[2].match(/rx="([\d.]+)"/)[1] : "")); };
  assert.equal(fe.nodeShape(S, "A"), "rect"); assert.equal(fe.nodeShape(S, "B"), "rect");
  assert.equal(fe.nodeShape(S, "C"), "stadium"); assert.equal(fe.nodeShape(S, "D"), "hexagon"); assert.equal(fe.nodeShape(S, "E"), "parallelogram");
  for (const k of Object.keys(fe.NODE_SHAPES)) {
    for (const id of ["A", "B", "C", "D", "F"]) {
      const out = fe.setNodeShape(S, [id], k);
      m.node_keys(out);
      assert.equal(fe.nodeShape(out, id), k, `${id} -> ${k}\n${out}`);
      assert.equal(fe.nodeLabel(out, id), fe.nodeLabel(S, id), `${id} label kept -> ${k}\n${out}`);
    }
  }
  assert.match(fe.setNodeShape(S, ["A"], "diamond"), /A\{Start\} --> B/);
  assert.match(fe.setNodeShape(S, ["B"], "circle"), /A\[Start\] --> B\(\(B\)\)/);
  assert.match(fe.setNodeShape(S, ["C"], "cylinder"), /C\[\("a \(b\)"\)\]/);
  assert.equal(shapeOf(fe.setNodeShape(S, ["A"], "circle"), "Start"), "circle");
  assert.equal(shapeOf(fe.setNodeShape(S, ["A"], "diamond"), "Start"), "polygon");
  const two = fe.setNodeShape(S, ["A", "D"], "rounded");
  assert.equal(fe.nodeShape(two, "A"), "rounded"); assert.equal(fe.nodeShape(two, "D"), "rounded");
}
console.log("ALL OK");
