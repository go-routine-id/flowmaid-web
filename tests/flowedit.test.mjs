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
console.log("ALL OK");
