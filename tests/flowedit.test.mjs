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
// ── Diagram type, read the way the engine reads it ──
{
assert.equal(fe.docKind("flowchart TD\n  A --> B"), "flowchart");
assert.equal(fe.docKind("graph LR\nA-->B"), "flowchart");
assert.equal(fe.docKind("A --> B"), "flowchart");            // no header: a flowchart, as the engine has it
assert.equal(fe.docKind("classDiagram\n  class A"), "class");
assert.equal(fe.docKind("erDiagram\n  A ||--o{ B : x"), "er");
assert.equal(fe.docKind("sequenceDiagram\n  A->>B: x"), "sequence");
assert.equal(fe.docKind("stateDiagram-v2\n  [*] --> A"), "state");
assert.equal(fe.docKind("stateDiagram\n  [*] --> A"), "state");
assert.equal(fe.docKind("pie\n  \"a\" : 1"), "pie");
assert.equal(fe.docKind("pie title X\n  \"a\" : 1"), "pie");
assert.equal(fe.docKind("mindmap\n  root"), "mindmap");
assert.equal(fe.docKind("journey\n  title X"), "journey");
assert.equal(fe.docKind("gitGraph\n  commit"), "gitgraph");
assert.equal(fe.docKind("gitGraph:\n  commit"), "gitgraph");  // the `gitGraph:` spelling
assert.equal(fe.docKind("architecture-beta\n  group a"), "architecture");
assert.equal(fe.docKind("timeline\n  title X"), "timeline");
assert.equal(fe.docKind("sankey-beta\na,b,1"), "sankey");
// Front matter, directives and comments are skipped, as in isFlowchart.
assert.equal(fe.docKind("---\ntitle: x\n---\nclassDiagram\n  class A"), "class");
assert.equal(fe.docKind("%% a note\n\nerDiagram\n  A ||--o{ B : x"), "er");
// A header ends at whitespace or end of line: `pieces` is not `pie`.
assert.equal(fe.docKind("pieces --> B"), "flowchart");
assert.equal(fe.docKind("timelines[x] --> B"), "flowchart");
// isFlowchart keeps its old answers after the refactor.
assert.equal(fe.isFlowchart("---\ntitle: x\n---\ngraph TD\nA-->B"), true);
assert.equal(fe.isFlowchart("classDiagram\n class A"), false);
assert.equal(fe.isFlowchart(""), false);
}

// ── Node shapes: every one parses, and no two draw the same picture ──
{
const draw = (s) => m.render_routed(s, m.auto_positions(s));
assert.equal(fe.NODE_KINDS.flowchart.length, 11);
assert.equal(new Set(fe.NODE_KINDS.flowchart.map((s) => s.key)).size, 11);
const seen = new Map();
for (const s of fe.NODE_KINDS.flowchart) {
  const src = ok(fe.addNode("flowchart TD\n    A[a]", "X", "x", s.key));
  assert.match(src, /\n    X/, s.key);
  assert.ok(m.node_keys(src).split("\n").includes("X"), s.key);
  // The label survives, whatever the brackets around it.
  assert.match(draw(src), />x</, s.key);
  // The measured claim this vocabulary rests on: distinct geometry.
  const art = draw(src).replace(/>x</g, "><");
  const twin = seen.get(art);
  assert.equal(twin, undefined, `${s.key} draws exactly what ${twin} draws`);
  seen.set(art, s.key);
}
// An unknown key falls back to the plain rectangle rather than throwing.
assert.equal(fe.addNode("flowchart TD\n    A[a]", "X", "x", "no-such-shape"),
             fe.addNode("flowchart TD\n    A[a]", "X", "x", "rect"));
// A label with the shape's own delimiter in it gets quoted, not broken.
const sl = ok(fe.addNode("flowchart TD\n    A[a]", "X", "a/b", "lean-r"));
assert.match(sl, /\n    X\[\/"a\/b"\/\]$/, sl);
assert.match(draw(sl), />a\/b</);
assert.match(ok(fe.addNode("flowchart TD\n    A[a]", "X", "c\\d", "lean-l")), /X\[\\"c\\d"\\\]$/);
}

// ── A node vocabulary per diagram type ──────────────────────────────
// Every entry the picker offers must be something the engine really
// draws, and something it draws differently from the type's other
// entries. A menu whose items produce the same picture is not a choice.
{
  // `ok()` above only asks for the keys; a new statement has to render.
  const must = (src, why) => {
    try { return m.render_routed(src, m.auto_positions(src)); }
    catch (e) { assert.fail(`${why}: the engine refused\n${src}\n${e}`); }
  };
  const BASE = {
    class: "classDiagram\n  Base <|-- Leaf",
    er: "erDiagram\n  BASE ||--o{ LEAF : has",
    state: "stateDiagram-v2\n  [*] --> Base\n  Base --> Leaf",
  };
  const FROM = { class: "Base", er: "BASE", state: "Base" };

  assert.deepEqual(Object.keys(fe.NODE_KINDS).sort(), ["class", "er", "flowchart", "state"]);
  assert.equal(fe.NODE_KINDS.flowchart.length, 11);
  assert.equal(fe.NODE_KINDS.class.length, 5);
  assert.equal(fe.NODE_KINDS.er.length, 3);
  // Three, not four: the engine draws `<<join>>` exactly as `<<fork>>`.
  assert.equal(fe.NODE_KINDS.state.length, 3);

  for (const [kind, base] of Object.entries(BASE)) {
    const seen = new Map();
    for (const e of fe.NODE_KINDS[kind]) {
      const why = `${kind}/${e.key}`;
      // One id for all of them, so the fingerprints below compare the
      // drawing and not the name that happens to sit in it.
      const src = fe.addNode(base, "X", "New node", e.key);
      const svg = must(src, why);
      assert.ok(m.node_keys(src).split("\n").includes("X"), `${why}: no key X`);
      // Appended at the document's own indent, in its own grammar.
      assert.match(src, /\n  \S/, why);
      assert.doesNotMatch(src, /\n\s+X\[New node\]/, `${why}: wrote flowchart brackets`);
      const art = svg.replace(/[-\d.]+/g, "#");
      const twin = seen.get(art);
      assert.equal(twin, undefined, `${why} draws exactly what ${kind}/${twin} draws`);
      seen.set(art, e.key);
      // The id a new node of this kind gets is named after what it is.
      assert.ok(fe.newNodeId(base, [], e.key).startsWith(e.prefix), `${why}: prefix`);
      // And it can be wired to what it came from, in this type's own
      // relation, straight away.
      must(fe.addEdge(src, FROM[kind], "X"), `${why}: edge`);
    }
  }

  // The annotations are not decoration: the engine writes them out.
  for (const [key, word] of [["interface", "interface"], ["abstract", "abstract"], ["enum", "enumeration"]]) {
    const svg = must(fe.addNode(BASE.class, "X", "x", key), `class/${key}`);
    assert.match(svg, new RegExp(word), `class/${key}: annotation missing`);
  }
  // An ER relation is not an arrow: the default carries cardinality.
  assert.equal(fe.EDGE_OP.er, "||--o{");
  assert.match(fe.addEdge(BASE.er, "BASE", "LEAF2"), /BASE \|\|--o\{ LEAF2$/);
  assert.match(fe.addEdge(BASE.class, "Base", "Leaf2"), /Base --> Leaf2$/);
  // An unknown key falls back to the type's first entry, not a throw.
  assert.equal(fe.addNode(BASE.class, "X", "x", "no-such"), fe.addNode(BASE.class, "X", "x", "class"));

  // Keys the engine invents for what the source never named must stay
  // out of any statement we write.
  const st = fe.addNode(BASE.state, "X", "x", "state");
  const keys = m.node_keys(st).split("\n");
  assert.ok(keys.includes("__start_root"), "the start marker is still a key");
  for (const k of keys) {
    assert.equal(fe.isWritableKey(k), !k.startsWith("__"), `writable? ${k}`);
  }
  assert.equal(fe.isWritableKey("note-0"), false);
  assert.equal(fe.isWritableKey(""), false);
  assert.equal(fe.isWritableKey("Base"), true);
  assert.equal(fe.isWritableKey("_x2"), true);

  // A flowchart may name its nodes with digits and the engine hands
  // those keys back: rejecting them killed link and add on diagrams
  // that had worked all along.
  const num = "flowchart TD\n    1[Start] --> 2[End]\n    2 --> 3B[Done]";
  for (const k of m.node_keys(num).split("\n").filter(Boolean)) {
    assert.equal(fe.isWritableKey(k), true, `a digit-led key is writable: ${k}`);
    assert.equal(fe.canWriteKey("flowchart", k), true, `and nameable: ${k}`);
  }
  must(fe.addEdge(num, "2", "3B"), "an edge between digit-led keys");
  assert.match(fe.addEdge(num, "2", "1"), /\n    2 --> 1$/);

  // An ER entity may be named with spaces. Only ER takes the quoted id
  // back, so only there does such a key become writable at all.
  const sp = 'erDiagram\n  "ORDER ITEM" ||--o{ LINE : has';
  assert.ok(m.node_keys(sp).split("\n").includes("ORDER ITEM"), "the spaced key is real");
  assert.equal(fe.isWritableKey("ORDER ITEM"), false, "not bare");
  assert.equal(fe.idText("er", "ORDER ITEM"), '"ORDER ITEM"');
  assert.equal(fe.idText("flowchart", "ORDER ITEM"), null, "a flowchart rejects a quoted id");
  assert.equal(fe.idText("class", "ORDER ITEM"), null, "so does a class relation");
  assert.equal(fe.idText("er", "__x"), null, "and a synthetic key has no spelling");
  assert.equal(fe.canWriteKey("er", "ORDER ITEM"), true);
  must(fe.addEdge(sp, "ORDER ITEM", "NEW1"), "an edge from a spaced ER entity");
  assert.match(fe.addEdge(sp, "ORDER ITEM", "NEW1"), /\n  "ORDER ITEM" \|\|--o\{ NEW1$/);
}

console.log("ALL OK");
