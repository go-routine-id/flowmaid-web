// flowedit.js — source-level edits for Mermaid flowcharts.
//
// The playground's visual editor never owns a model of its own: every
// canvas action (add / rename / connect / delete) is a text edit on the
// Mermaid source, which the engine then re-parses. Only the statements
// an action touches are rewritten; every other line stays byte-for-byte
// as the user typed it.
//
// Scope: `flowchart` / `graph` documents. Statements are node chains
// (`A[x] --> B & C -->|y| D`); everything else (subgraph, style, class,
// comments, …) is treated as opaque text, except where a deleted node
// has to be scrubbed from `style` / `class` / `click` lines.

const ID_RE = /[\p{L}\p{N}_]+/uy;
const CLASS_RE = /:::[\w-]+/y;
const AMP_RE = /\s*&\s*/y;
// `label: "…"` inside an `@{ … }` shape block.
const AT_LABEL_RE = /label\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/;
const WS_RE = /[ \t]*/y;
// `A -- text --> B`, `A == text ==> B`, `A -. text .-> B`
const EDGE_TEXT_RE = /[<xo]?(?:--|==|-\.)(?![->=.]|[xo](?![\p{L}\p{N}_]))[ \t]*[^\n]*?[ \t]*(?:-{2,}[>xo]?|={2,}[>xo]?|\.-+[>xo]?)(?=[ \t]|[\p{L}\p{N}_"])/uy;
// `-->`, `---`, `==>`, `-.->`, `~~~`, `<-->`, `--o`, `x--x`, optional `|label|`
const EDGE_PLAIN_RE = /[<xo]?(?:-{2,}|={2,}|-\.+-|~{3,})(?:>|[xo](?![\p{L}\p{N}_]))?(?:[ \t]*\|[^|\n]*\|)?/uy;

// Shape openers, longest first so `((` wins over `(`.
const SHAPES = [
  ["(((", [")))"]], ["([", ["])"]], ["[[", ["]]"]], ["[(", [")]"]], ["((", ["))"]],
  ["{{", ["}}"]], ["[/", ["/]", "\\]"]], ["[\\", ["\\]", "/]"]], [">", ["]"]],
  ["[", ["]"]], ["(", [")"]], ["{", ["}"]],
];

const OPAQUE_HEADS = new Set([
  "subgraph", "end", "direction", "classDef", "class", "style", "linkStyle",
  "click", "flowchart", "graph", "accTitle", "accDescr", "title",
]);

function at(re, s, i) {
  re.lastIndex = i;
  const m = re.exec(s);
  return m && m.index === i ? m[0] : null;
}

// Shape after a node id: `[label]`, `(["label"])`, `@{ ... }`, …
function parseShape(s, i) {
  if (s.startsWith("@{", i)) {
    let depth = 0;
    for (let j = i + 1; j < s.length && s[j] !== "\n"; j++) {
      if (s[j] === '"') { const q = s.indexOf('"', j + 1); if (q < 0) return null; j = q; continue; }
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) {
        return { kind: "at", start: i, innerStart: i + 2, innerEnd: j, end: j + 1 };
      }
    }
    return null;
  }
  for (const [open, closers] of SHAPES) {
    if (!s.startsWith(open, i)) continue;
    let j = i + open.length;
    // Quoted labels may hold the closer characters.
    let from = j;
    const ws = at(WS_RE, s, j) ?? "";
    if (s[j + ws.length] === '"') {
      const q = s.indexOf('"', j + ws.length + 1);
      if (q >= 0) from = q + 1;
    }
    const eol = s.indexOf("\n", from) < 0 ? s.length : s.indexOf("\n", from);
    let best = -1, bestLen = 0;
    for (const c of closers) {
      const k = s.indexOf(c, from);
      if (k >= 0 && k < eol && (best < 0 || k < best)) { best = k; bestLen = c.length; }
    }
    if (best < 0) return null;
    return { kind: "box", open, start: i, innerStart: j, innerEnd: best, end: best + bestLen };
  }
  return null;
}

function parseRef(s, i) {
  const id = at(ID_RE, s, i);
  if (!id) return null;
  const idEnd = i + id.length;
  let end = idEnd;
  const shape = parseShape(s, end);
  if (shape) end = shape.end;
  const cls = at(CLASS_RE, s, end);
  if (cls) end += cls.length;
  return { id, start: i, idEnd, end, shape, cls: !!cls, raw: s.slice(i, end) };
}

function parseGroup(s, i) {
  const refs = [];
  let r = parseRef(s, i);
  if (!r) return null;
  refs.push(r);
  for (;;) {
    const amp = at(AMP_RE, s, r.end);
    if (!amp) break;
    const nx = parseRef(s, r.end + amp.length);
    if (!nx) break;
    refs.push(nx);
    r = nx;
  }
  return { refs, end: r.end };
}

function parseEdge(s, i) {
  const raw = at(EDGE_TEXT_RE, s, i) ?? at(EDGE_PLAIN_RE, s, i);
  return raw ? { raw, start: i, end: i + raw.length } : null;
}

// A chain statement covering exactly s[start, end), or null.
function parseStatement(s, start, end) {
  const sub = s.slice(0, end);
  let i = start + (at(WS_RE, sub, start) ?? "").length;
  const groups = [], ops = [];
  let g = parseGroup(sub, i);
  if (!g) return null;
  groups.push(g);
  i = g.end;
  for (;;) {
    const ws = at(WS_RE, sub, i) ?? "";
    const op = parseEdge(sub, i + ws.length);
    if (!op) break;
    const ws2 = at(WS_RE, sub, op.end) ?? "";
    const g2 = parseGroup(sub, op.end + ws2.length);
    if (!g2) return null;
    ops.push(op);
    groups.push(g2);
    i = g2.end;
  }
  if (sub.slice(i, end).trim() !== "") return null;
  return { groups, ops };
}

// Split one line into `;`-separated segments (outside quotes / brackets).
function splitSegments(s, start, end) {
  const out = [];
  let depth = 0, quote = false, segStart = start;
  for (let i = start; i < end; i++) {
    const c = s[i];
    if (quote) { if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) { out.push([segStart, i]); segStart = i + 1; }
  }
  out.push([segStart, end]);
  return out;
}

/** Parse a flowchart source into lines and segments with offsets. */
export function parseFlow(src) {
  const lines = [];
  let off = 0, front = false, sawHeader = false, depth = 0;
  const raw = src.split("\n");
  for (let n = 0; n < raw.length; n++) {
    const text = raw[n];
    const start = off, end = off + text.length;
    off = end + 1;
    const line = { n, start, end, text, indent: text.match(/^[ \t]*/)[0], segs: [] };
    lines.push(line);
    const t = text.trim();
    if (n === 0 && t === "---") { front = true; continue; }
    if (front) { if (t === "---") front = false; continue; }
    if (t === "" || t.startsWith("%%")) continue;
    const head = t.match(/^[\w-]+/)?.[0];
    let segs = splitSegments(src, start, end);
    if (!sawHeader) {
      if (head !== "flowchart" && head !== "graph") continue;
      // `graph LR; A --> B`: statements may follow the header.
      sawHeader = true;
      segs = segs.slice(1);
    } else
    if (head && OPAQUE_HEADS.has(head) && !/^[\w-]+\s*(?:&|-|=|~|<|[xo]-)/.test(t)) {
      line.head = head;
      if (head === "subgraph") depth++;
      else if (head === "end" && depth) depth--;
      continue;
    }
    for (const [a, b] of segs) {
      if (src.slice(a, b).trim() === "") continue;
      const stmt = parseStatement(src, a, b);
      if (stmt) line.segs.push({ start: a, end: b, stmt, inGroup: depth > 0 });
    }
  }
  return { src, lines };
}

/** The document's first real statement: front matter and comments skipped. */
function firstStatement(src) {
  let front = false;
  const lines = src.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (n === 0 && t === "---") { front = true; continue; }
    if (front) { if (t === "---") front = false; continue; }
    if (t === "" || t.startsWith("%%")) continue;
    return t;
  }
  return "";
}

/** True for `flowchart …` / `graph …` sources (after comments / front matter). */
export function isFlowchart(src) {
  return /^(?:flowchart|graph)\b/.test(firstStatement(src));
}

// The engine's diagram headers, in its own order so the longer spelling
// wins: `stateDiagram-v2` before `stateDiagram`, `sankey-beta` before
// `sankey`. A header the engine does not recognise leaves the document a
// flowchart, which is how the engine reads it too.
// TODO: copied by hand from the engine's header table, so a new diagram
// type there needs a line here. The type belongs in something the engine
// reports (see the type-aware editing request on its tracker); until then
// this is the only place the web decides a document's type for itself.
const DOC_HEADERS = [
  ["erDiagram", "er"], ["classDiagram", "class"], ["sequenceDiagram", "sequence"],
  ["pie", "pie"], ["stateDiagram-v2", "state"], ["stateDiagram", "state"],
  ["mindmap", "mindmap"], ["journey", "journey"], ["gitGraph", "gitgraph"],
  ["architecture-beta", "architecture"], ["architecture", "architecture"],
  ["timeline", "timeline"], ["sankey-beta", "sankey"], ["sankey", "sankey"],
];

/** The document's diagram type: `flowchart`, `class`, `er`, `state`, … */
export function docKind(src) {
  const line = firstStatement(src);
  for (const [head, kind] of DOC_HEADERS) {
    if (!line.startsWith(head)) continue;
    // A header ends at whitespace or end of line (and `gitGraph:` counts),
    // so `pie` matches but `pieces` does not.
    const next = line[head.length];
    if (next === undefined || /\s/.test(next) || (head === "gitGraph" && next === ":")) return kind;
  }
  return "flowchart";
}

/** What each type is called in the interface. */
export const KIND_LABEL = {
  flowchart: "flowchart", state: "state diagram", class: "class diagram",
  er: "ER diagram", sequence: "sequence diagram", pie: "pie chart",
  mindmap: "mind map", journey: "user journey", gitgraph: "git graph",
  architecture: "architecture diagram", timeline: "timeline", sankey: "sankey diagram",
};

function* allRefs(doc) {
  for (const line of doc.lines) for (const seg of line.segs) for (const g of seg.stmt.groups) for (const r of g.refs) yield r;
}

/** Every edge in source order, as the engine expands them. */
export function edgeList(src) {
  const doc = parseFlow(src);
  const out = [];
  for (const line of doc.lines) for (const seg of line.segs) {
    const { groups, ops } = seg.stmt;
    for (let k = 0; k < ops.length; k++) {
      for (const a of groups[k].refs) for (const b of groups[k + 1].refs) out.push([a.id, b.id]);
    }
  }
  return out;
}

function unquote(t) {
  t = t.trim();
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') t = t.slice(1, -1);
  return t.replace(/#quot;/g, '"').replace(/<br\s*\/?>/gi, " ");
}

/** The label a node currently shows (falls back to its id). */
export function nodeLabel(src, id) {
  const doc = parseFlow(src);
  // Mermaid lets a later definition override an earlier one.
  for (const r of [...allRefs(doc)].reverse()) {
    if (r.id !== id || !r.shape) continue;
    const inner = src.slice(r.shape.innerStart, r.shape.innerEnd);
    if (r.shape.kind === "at") {
      const m = inner.match(AT_LABEL_RE);
      if (m) return unquote(m[1]);
      continue;
    }
    return unquote(inner);
  }
  return id;
}

/** Format a label for a `[…]` box: bare when safe, quoted otherwise. */
export function formatLabel(label) {
  const s = label.replace(/\s*\n\s*/g, " ").trim();
  if (s && /^[\p{L}\p{N} _.,!?'+*/-]*$/u.test(s) && !/^[/\\]|[/\\]$/.test(s)) return s;
  return '"' + s.replace(/"/g, "#quot;") + '"';
}

function splice(src, edits) {
  // edits: [start, end, text], applied right-to-left.
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [a, b, t] of edits) out = out.slice(0, a) + t + out.slice(b);
  return out;
}

/** Rename a node's label, keeping its shape. Adds `[label]` when it has none. */
export function renameNode(src, id, label) {
  const doc = parseFlow(src);
  const refs = [...allRefs(doc)].filter((r) => r.id === id);
  const first = refs[0];
  for (const r of refs.reverse()) {
    if (!r.shape) continue;
    if (r.shape.kind === "at") {
      const inner = src.slice(r.shape.innerStart, r.shape.innerEnd);
      const q = '"' + label.trim().replace(/"/g, "#quot;") + '"';
      const m = inner.match(AT_LABEL_RE);
      const next = m
        ? inner.slice(0, m.index) + "label: " + q + inner.slice(m.index + m[0].length)
        : inner.trimEnd() + ", label: " + q + " ";
      return splice(src, [[r.shape.innerStart, r.shape.innerEnd, next]]);
    }
    return splice(src, [[r.shape.innerStart, r.shape.innerEnd, formatLabel(label)]]);
  }
  if (!first) return src;
  return splice(src, [[first.idEnd, first.idEnd, "[" + formatLabel(label) + "]"]]);
}

function stmtIndent(doc) {
  for (const line of doc.lines) if (line.segs.length) return line.indent || "    ";
  return "    ";
}

/** Append statement lines at the end of the source. */
function appendLines(src, doc, stmts) {
  const indent = stmtIndent(doc);
  const body = src.replace(/\s+$/, "");
  const trail = src.slice(body.length);
  return body + stmts.map((s) => "\n" + indent + s).join("") + (trail.includes("\n") ? trail.slice(trail.indexOf("\n")) : "");
}

/**
 * Append statement lines to a document that is not a flowchart, indented
 * like its own body. `appendLines` reaches its indent through `parseFlow`,
 * which only ever sees a flowchart's statements.
 */
function appendPlain(src, stmts) {
  let indent = "    ";
  const raw = src.split("\n");
  let front = false, sawHeader = false;
  for (let n = 0; n < raw.length; n++) {
    const t = raw[n].trim();
    if (n === 0 && t === "---") { front = true; continue; }
    if (front) { if (t === "---") front = false; continue; }
    if (t === "" || t.startsWith("%%")) continue;
    if (!sawHeader) { sawHeader = true; continue; }
    // The first statement under the header sets the body's indent.
    indent = raw[n].match(/^[ \t]*/)[0];
    break;
  }
  const body = src.replace(/\s+$/, "");
  const trail = src.slice(body.length);
  return body + stmts.map((s) => "\n" + indent + s).join("") + (trail.includes("\n") ? trail.slice(trail.indexOf("\n")) : "");
}

/** An id not used anywhere in the source (`N1`, `N2`, …). */
export function freshId(src, taken = [], prefix = "N") {
  const used = new Set(taken);
  for (const m of src.matchAll(/[\p{L}\p{N}_]+/gu)) used.add(m[0]);
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

// The node shapes the engine draws differently from one another —
// measured through the wasm bundle, not read off the grammar: `>x]` comes
// out byte-identical to `[x]`, `[/x\]` to `[/x/]` and `[\x/]` to `[\x\]`,
// so only one of each pair is offered. Two menu entries that draw the
// same picture are not a choice.
// TODO: this is the web's own copy of the vocabulary. The catalogue
// belongs to the engine (see the type-aware editing request on its
// tracker); until it reports one, a shape added there needs a line here.
// Each list holds what the engine draws differently from the others in
// a document of that type — measured through the wasm bundle, not read
// off the grammar. A state diagram's `<<join>>` comes out byte-identical
// to its `<<fork>>`, so the pair is offered once; `namespace` (class) and
// a state diagram's `--` are left out because the parser rejects them.
export const NODE_KINDS = {
  flowchart: [
    { key: "rect", name: "Rectangle", prefix: "N", open: "[", close: "]" },
    { key: "rounded", name: "Rounded", prefix: "N", open: "(", close: ")" },
    { key: "stadium", name: "Stadium", prefix: "N", open: "([", close: "])" },
    { key: "subroutine", name: "Subroutine", prefix: "N", open: "[[", close: "]]" },
    { key: "cylinder", name: "Database", prefix: "N", open: "[(", close: ")]" },
    { key: "circle", name: "Circle", prefix: "N", open: "((", close: "))" },
    { key: "double", name: "Double circle", prefix: "N", open: "(((", close: ")))" },
    { key: "diamond", name: "Decision", prefix: "N", open: "{", close: "}" },
    { key: "hexagon", name: "Hexagon", prefix: "N", open: "{{", close: "}}" },
    { key: "lean-r", name: "Parallelogram", prefix: "N", open: "[/", close: "/]" },
    { key: "lean-l", name: "Parallelogram, mirrored", prefix: "N", open: "[\\", close: "\\]" },
  ],
  class: [
    { key: "class", name: "Class", prefix: "Class" },
    { key: "members", name: "Class with members", prefix: "Class" },
    { key: "interface", name: "Interface", prefix: "Interface" },
    { key: "abstract", name: "Abstract class", prefix: "Abstract" },
    { key: "enum", name: "Enumeration", prefix: "Enum" },
  ],
  er: [
    { key: "entity", name: "Entity", prefix: "ENTITY" },
    { key: "attr", name: "Entity with an attribute", prefix: "ENTITY" },
    { key: "key", name: "Entity with a key", prefix: "ENTITY" },
  ],
  state: [
    { key: "state", name: "State", prefix: "State" },
    { key: "choice", name: "Choice", prefix: "Choice" },
    { key: "fork", name: "Fork / join", prefix: "Fork" },
  ],
};

/** The entry `key` names in a `kind` document, or that type's first. */
export function nodeKind(kind, key) {
  const all = NODE_KINDS[kind] ?? [];
  return all.find((x) => x.key === key) ?? all[0] ?? null;
}

/**
 * True for a node key a statement can carry bare. Digits may lead one:
 * `1[Start] --> 2[End]` is a flowchart the engine accepts, and it hands
 * `1` and `2` back as keys. What must stay out are the keys the engine
 * reports for things the source never named — a state diagram's
 * `__start_root`, a class note's `note-0` — because writing one of
 * those into a statement would invent a node beside the drawn one.
 */
export function isWritableKey(key) {
  return /^[\p{L}\p{N}_]+$/u.test(key) && !key.startsWith("__");
}

/**
 * The key as a statement of a `kind` document would spell it, or null
 * when that grammar has no way to name it at all. Only ER takes a
 * quoted id back (`"ORDER ITEM" ||--o{ X` parses); a flowchart rejects
 * one outright, and `class "My Class"` makes a key that carries its own
 * quotes, so there the quoted form is no way out either.
 */
export function idText(kind, key) {
  if (isWritableKey(key)) return key;
  // A key the source never named has no spelling at all: quoting it
  // would write `"__start_root"` and invent a node beside the drawn one.
  if (key.startsWith("__")) return null;
  return kind === "er" && /^[^"\\\n]+$/.test(key) ? `"${key}"` : null;
}

/** True when a statement in a `kind` document can name this key. */
export function canWriteKey(kind, key) {
  return idText(kind, key) !== null;
}

/** A fresh id for a new node, prefixed to suit what it is. */
export function newNodeId(src, taken, key) {
  return freshId(src, taken, nodeKind(docKind(src), key)?.prefix ?? "N");
}

/** The lines a new node is written as, per diagram type. */
const NEW_NODE = {
  flowchart: (id, label, key) => [shapeText(id, label, key)],
  class: (id, _label, key) => ({
    members: [`class ${id} {`, "    +int id", "    +save() bool", "}"],
    interface: [`class ${id} {`, "    <<interface>>", "}"],
    abstract: [`class ${id} {`, "    <<abstract>>", "}"],
    enum: [`class ${id} {`, "    <<enumeration>>", "}"],
  })[key] ?? [`class ${id}`],
  er: (id, _label, key) => ({
    attr: [`${id} {`, "    string name", "}"],
    key: [`${id} {`, "    string id PK", "}"],
  })[key] ?? [id],
  state: (id, _label, key) => ({
    choice: [`state ${id} <<choice>>`],
    fork: [`state ${id} <<fork>>`],
  })[key] ?? [`state ${id}`],
};

/** How a new node is wired to the one it came from, per diagram type. */
export const EDGE_OP = { flowchart: "-->", class: "-->", state: "-->", er: "||--o{" };

/** A node statement: `id` wrapped in `shape`, label quoted where needed. */
function shapeText(id, label, shape) {
  const s = nodeKind("flowchart", shape);
  let text = formatLabel(label);
  // `[/a/b/]` would end at the label's own slash, so quote it instead.
  if (text[0] !== '"' && /[/\\]/.test(s.open + s.close) && /[/\\]/.test(text)) {
    text = '"' + text.replace(/"/g, "#quot;") + '"';
  }
  return id + s.open + text + s.close;
}

/**
 * Append a new node, written in the grammar of the document it joins:
 * `N1[New node]` on a flowchart, `class Foo` on a class diagram, a bare
 * `FOO` on an ER one. `key` picks from that type's `NODE_KINDS`.
 */
export function addNode(src, id, label, key = "rect") {
  const kind = docKind(src);
  const lines = (NEW_NODE[kind] ?? NEW_NODE.flowchart)(id, label, key);
  return kind === "flowchart" ? appendLines(src, parseFlow(src), lines) : appendPlain(src, lines);
}

/** Wire `from` to `to`. Without `op`, the document's own default. */
export function addEdge(src, from, to, op = null) {
  const kind = docKind(src);
  // An ER entity may be named `"ORDER ITEM"`: spell each end the way its
  // own grammar takes it back. A key with no spelling at all is left as
  // it came and the rebuild refuses the edit, rather than guessing here.
  const a = idText(kind, from) ?? from, b = idText(kind, to) ?? to;
  const lines = [`${a} ${op ?? EDGE_OP[kind] ?? "-->"} ${b}`];
  return kind === "flowchart" ? appendLines(src, parseFlow(src), lines) : appendPlain(src, lines);
}

// ── Rewriting chains ──
function pieceText(piece) {
  let out = piece.groups[0].map((r) => r.raw).join(" & ");
  for (let k = 0; k < piece.ops.length; k++) {
    out += " " + piece.ops[k].raw.trim() + " " + piece.groups[k + 1].map((r) => r.raw).join(" & ");
  }
  return out;
}

// Ids that appear in any statement other than `except`.
function idsOutside(doc, except) {
  const ids = new Set();
  for (const line of doc.lines) for (const seg of line.segs) {
    if (seg === except) continue;
    for (const g of seg.stmt.groups) for (const r of g.refs) ids.add(r.id);
  }
  // Subgraph ids are declared by their `subgraph` line.
  for (const line of doc.lines) {
    if (line.head === "subgraph") ids.add(line.text.trim().split(/[\s[]/)[1]);
  }
  return ids;
}

// A lone `A` (or `A & B`) adds nothing when every id in it is declared
// elsewhere and carries no shape or class.
function isRedundant(piece, outside, emitted) {
  if (piece.ops.length) return false;
  return piece.groups[0].every((r) => !r.shape && !r.cls && (outside.has(r.id) || emitted.has(r.id)));
}

// Replace each changed segment with its new pieces (array of text).
function rewrite(doc, changes /* Map seg -> string[] */) {
  const edits = [];
  for (const line of doc.lines) {
    const touched = line.segs.filter((s) => changes.has(s));
    if (!touched.length) continue;
    const allSegs = splitSegments(doc.src, line.start, line.end).filter(([a, b]) => doc.src.slice(a, b).trim());
    if (allSegs.length <= 1 && touched.length === 1) {
      const seg = touched[0];
      const pieces = changes.get(seg);
      if (!pieces.length) {
        // Drop the whole line, including its newline.
        const a = line.start, b = Math.min(doc.src.length, line.end + 1);
        edits.push(line.end < doc.src.length ? [a, b, ""] : [Math.max(0, a - 1), line.end, ""]);
      } else {
        edits.push([line.start, line.end, pieces.map((p) => line.indent + p).join("\n")]);
      }
      continue;
    }
    // Several `;` statements on one line: rebuild the line in place.
    const parts = [];
    for (const [a, b] of allSegs) {
      const seg = line.segs.find((s) => s.start === a);
      if (seg && changes.has(seg)) parts.push(...changes.get(seg));
      else parts.push(doc.src.slice(a, b).trim());
    }
    const text = parts.length ? line.indent + parts.join("; ") : "";
    if (!text) {
      const b = Math.min(doc.src.length, line.end + 1);
      edits.push(line.end < doc.src.length ? [line.start, b, ""] : [Math.max(0, line.start - 1), line.end, ""]);
    } else edits.push([line.start, line.end, text]);
  }
  return splice(doc.src, edits);
}

function finishPieces(doc, seg, pieces) {
  // Inside a subgraph a lone `A` is what puts A in the group: keep it.
  const outside = seg.inGroup ? new Set() : idsOutside(doc, seg);
  const emitted = new Set();
  const kept = [];
  for (const p of pieces) {
    if (isRedundant(p, outside, emitted)) continue;
    for (const g of p.groups) for (const r of g) emitted.add(r.id);
    kept.push(typeof p.text === "string" ? p.text : pieceText(p));
  }
  return kept;
}

// `linkStyle` addresses edges by their index in source order; after
// edges are removed, drop the ones that went and shift the rest down.
function renumberLinkStyles(src, removed /* sorted edge indices */) {
  if (!removed.length) return src;
  const gone = new Set(removed);
  return src.replace(/^([ \t]*linkStyle[ \t]+)([\d,]+)([^\n]*)(\n|$)/gm, (all, pre, list, rest, nl) => {
    const ids = list.split(",").filter(Boolean).map(Number).filter((n) => !gone.has(n))
      .map((n) => n - removed.filter((r) => r < n).length);
    return ids.length ? pre + ids.join(",") + rest + nl : "";
  }).replace(/\n$/, src.endsWith("\n") ? "\n" : "");
}

/** Delete a node, every edge touching it, and its style/class/click lines. */
export function deleteNode(src, id) {
  const doc = parseFlow(src);
  const changes = new Map();
  for (const line of doc.lines) for (const seg of line.segs) {
    const { groups, ops } = seg.stmt;
    if (!groups.some((g) => g.refs.some((r) => r.id === id))) continue;
    const gs = groups.map((g) => g.refs.filter((r) => r.id !== id));
    const pieces = [];
    let cur = null;
    for (let i = 0; i < gs.length; i++) {
      if (!gs[i].length) { if (cur) pieces.push(cur); cur = null; continue; }
      if (!cur) cur = { groups: [gs[i]], ops: [] };
      else { cur.ops.push(ops[i - 1]); cur.groups.push(gs[i]); }
    }
    if (cur) pieces.push(cur);
    changes.set(seg, finishPieces(doc, seg, pieces));
  }
  const removed = [];
  edgeList(src).forEach(([a, b], i) => { if (a === id || b === id) removed.push(i); });
  let out = renumberLinkStyles(rewrite(doc, changes), removed);
  // Scrub style / class / click lines that name the node.
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(new RegExp(`^[ \\t]*(?:style|click)[ \\t]+${esc}(?![\\p{L}\\p{N}_])[^\\n]*(?:\\n|$)`, "gmu"), "");
  out = out.replace(/^([ \t]*class[ \t]+)([^\s]+)([ \t]+[^\n]*)$/gmu, (all, pre, list, rest) => {
    const ids = list.split(",").filter((x) => x !== id);
    if (ids.length === list.split(",").length) return all;
    return ids.length ? pre + ids.join(",") + rest : "\u0000";
  });
  out = out.replace(/^\u0000(?:\n|$)/gm, "").replace(/\n\u0000$/, "");
  return dropEmptyGroups(out);
}

// Remove subgraph blocks left with nothing inside (innermost first).
function dropEmptyGroups(src) {
  for (;;) {
    const { blocks } = subgraphs(src);
    const lines = src.split("\n");
    // A group that edges point at is a node of its own: keep that.
    const used = new Set([...allRefs(parseFlow(src))].map((r) => r.id));
    const empty = blocks.find((b) => b.endLine > b.line && !used.has(b.id) &&
      lines.slice(b.line + 1, b.endLine).every((l) => !l.trim() || l.trim().startsWith("%%")));
    if (!empty) return src;
    lines.splice(empty.line, empty.endLine - empty.line + 1);
    src = lines.join("\n");
  }
}

/** Delete the `nth` (0-based) edge from → to, in source order. */
export function deleteEdge(src, from, to, nth = 0) {
  const doc = parseFlow(src);
  let count = 0, index = -1;
  for (const line of doc.lines) for (const seg of line.segs) {
    const { groups, ops } = seg.stmt;
    for (let k = 0; k < ops.length; k++) {
      for (const a of groups[k].refs) for (const b of groups[k + 1].refs) {
        index++;
        if (a.id !== from || b.id !== to) continue;
        if (count++ !== nth) continue;
        const gs = groups.map((g) => g.refs);
        const left = { groups: gs.slice(0, k + 1), ops: ops.slice(0, k) };
        const right = { groups: gs.slice(k + 1), ops: ops.slice(k + 1) };
        const extras = [];
        for (const x of gs[k]) for (const y of gs[k + 1]) {
          if (x === a && y === b) continue;
          extras.push({ groups: [[x], [y]], ops: [ops[k]], text: `${x.id} ${ops[k].raw.trim()} ${y.id}` });
        }
        const pieces = finishPieces(doc, seg, [left, ...extras, right]);
        return renumberLinkStyles(rewrite(doc, new Map([[seg, pieces]])), [index]);
      }
    }
  }
  return src;
}

// ── Edges: label, line style, direction ──

/** Split an edge operator (`-->|x|`, `-- x -->`, `-.->`, `<==>`, …). */
export function parseOp(raw) {
  raw = raw.trim();
  let arrow = raw, label = null;
  const pipe = raw.match(/^(.*?)\s*\|([^|]*)\|$/);
  if (pipe) { arrow = pipe[1]; label = pipe[2]; }
  else {
    const t = raw.match(/^([<xo]?)(--|==|-\.)\s+(.*?)\s+(-{2,}[>xo]?|={2,}[>xo]?|\.-+[>xo]?)$/);
    if (t) { arrow = t[1] + t[2] + t[4]; label = t[3]; }
  }
  const kind = arrow.includes("~") ? "invisible" : arrow.includes("=") ? "thick" : arrow.includes(".") ? "dotted" : "solid";
  const start = /^[<xo](?=[-=.~])/.test(arrow) ? arrow[0] : "";
  const end = /[>xo]$/.test(arrow) && arrow.length > 1 ? arrow.at(-1) : "";
  if (label !== null) label = unquote(label);
  return { start: start === "<" ? "<" : start, kind, end, label };
}

/** Inverse of parseOp. */
export function buildOp({ start = "", kind = "solid", end = ">", label = null }) {
  const body = kind === "invisible" ? "~~~"
    : kind === "thick" ? (end ? "==" + end : "===")
    : kind === "dotted" ? (end ? "-.-" + end : "-.-")
    : (end ? "--" + end : "---");
  const arrow = kind === "invisible" ? body : (end ? start : "") + body;
  if (label === null || label.trim() === "") return arrow;
  const l = label.trim().replace(/\s*\n\s*/g, " ");
  return arrow + "|" + (/[|"]/.test(l) ? '"' + l.replace(/"/g, "#quot;").replace(/\|/g, "/") + '"' : l) + "|";
}

// Locate the nth from → to edge: its statement and position.
function findEdge(doc, from, to, nth) {
  let count = 0, index = -1;
  for (const line of doc.lines) for (const seg of line.segs) {
    const { groups, ops } = seg.stmt;
    for (let k = 0; k < ops.length; k++) {
      for (const a of groups[k].refs) for (const b of groups[k + 1].refs) {
        index++;
        if (a.id === from && b.id === to && count++ === nth) return { seg, k, a, b, index };
      }
    }
  }
  return null;
}

/** The parsed operator of the nth from → to edge, or null. */
export function edgeOp(src, from, to, nth = 0) {
  const hit = findEdge(parseFlow(src), from, to, nth);
  return hit ? parseOp(hit.seg.stmt.ops[hit.k].raw) : null;
}

// Rewrite one edge. `mutate(op)` returns the new parsed op; `swap`
// reverses it. A plain `A --> B` statement is edited in place; an edge
// that shares its operator with others (chains, `&`) is split out.
function editEdge(src, from, to, nth, mutate, swap = false) {
  const doc = parseFlow(src);
  const hit = findEdge(doc, from, to, nth);
  if (!hit) return src;
  const { seg, k, a, b } = hit;
  const { groups, ops } = seg.stmt;
  const op = ops[k];
  const next = buildOp(mutate(parseOp(op.raw)));
  const single = groups[k].refs.length === 1 && groups[k + 1].refs.length === 1;
  if (single && (!swap || ops.length === 1)) {
    const edits = [[op.start, op.end, next]];
    if (swap) {
      edits.push([a.start, a.end, b.raw], [b.start, b.end, a.raw]);
      // Keep the spacing that sat around the operator.
    }
    return splice(src, edits);
  }
  const gs = groups.map((g) => g.refs);
  const left = { groups: gs.slice(0, k + 1), ops: ops.slice(0, k) };
  const right = { groups: gs.slice(k + 1), ops: ops.slice(k + 1) };
  const pieces = [left];
  for (const x of gs[k]) for (const y of gs[k + 1]) {
    if (x === a && y === b) {
      const [p, q] = swap ? [y, x] : [x, y];
      pieces.push({ groups: [[p], [q]], ops: [op], text: `${p.id} ${next} ${q.id}` });
    } else {
      pieces.push({ groups: [[x], [y]], ops: [op], text: `${x.id} ${op.raw.trim()} ${y.id}` });
    }
  }
  pieces.push(right);
  return rewrite(doc, new Map([[seg, finishPieces(doc, seg, pieces)]]));
}

export function setEdgeLabel(src, from, to, nth, label) {
  return editEdge(src, from, to, nth, (o) => ({ ...o, label }));
}

/** kind: "solid" | "dotted" | "thick". */
export function setEdgeKind(src, from, to, nth, kind) {
  return editEdge(src, from, to, nth, (o) => ({ ...o, kind }));
}

export function reverseEdge(src, from, to, nth) {
  return editEdge(src, from, to, nth, (o) => o, true);
}

// ── Node colours (`style` lines) ──

/**
 * Set (merge) style props on nodes: `props` like { fill, stroke, color }.
 * A prop set to null is removed; `props` null clears fill/stroke/color.
 * Each node ends with at most one `style` line, where its first was.
 */
export function setNodeStyle(src, ids, props) {
  let lines = src.split("\n");
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^([ \\t]*)style[ \\t]+${esc}[ \\t]+(.*)$`, "u");
    const map = new Map();
    let at = -1, indent = null;
    lines = lines.filter((l, n) => {
      const m = l.match(re);
      if (!m) return true;
      if (at < 0) { at = n; indent = m[1]; }
      for (const kv of m[2].replace(/;\s*$/, "").split(",")) {
        const i = kv.indexOf(":");
        if (i > 0) map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
      return false;
    });
    const set = props ?? { fill: null, stroke: null, color: null };
    for (const [k, v] of Object.entries(set)) {
      if (v === null || v === undefined) map.delete(k); else map.set(k, v);
    }
    if (!map.size) continue;
    const doc = parseFlow(lines.join("\n"));
    const line = `style ${id} ` + [...map].map(([k, v]) => `${k}:${v}`).join(",");
    if (at >= 0) lines.splice(Math.min(at, lines.length), 0, indent + line);
    else lines = appendLines(lines.join("\n"), doc, [line]).split("\n");
  }
  return lines.join("\n");
}

/** Current fill of a node from its `style` lines (last one wins), or null. */
export function nodeFill(src, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let fill = null;
  for (const m of src.matchAll(new RegExp(`^[ \\t]*style[ \\t]+${esc}[ \\t]+(.*)$`, "gmu"))) {
    const f = m[1].match(/(?:^|,)\s*fill\s*:\s*([^,;]+)/);
    if (f) fill = f[1].trim();
  }
  return fill;
}

// ── Subgraphs ──

/** Subgraph blocks ({ id, title, line, endLine, depth, parent }) and node membership. */
export function subgraphs(src) {
  const doc = parseFlow(src);
  const blocks = [], stack = [], member = new Map();
  for (const line of doc.lines) {
    if (line.head === "subgraph") {
      const rest = line.text.trim().slice("subgraph".length).trim();
      const id = rest.match(/^[\p{L}\p{N}_]+/u)?.[0] ?? `#${line.n}`;
      const title = rest.match(/\[(.*)\]\s*$/)?.[1] ?? rest;
      const b = { id, title: unquote(title), line: line.n, endLine: -1, depth: stack.length, parent: stack.at(-1)?.id ?? null };
      blocks.push(b);
      stack.push(b);
      continue;
    }
    if (line.head === "end" && stack.length) { stack.pop().endLine = line.n; continue; }
    if (!stack.length) continue;
    // The engine keeps a node in the first subgraph that mentions it.
    for (const seg of line.segs) for (const g of seg.stmt.groups) for (const r of g.refs) {
      if (!member.has(r.id)) member.set(r.id, stack.at(-1).id);
    }
  }
  return { blocks, member };
}

/**
 * Wrap nodes in a new `subgraph gid [title]`. Nodes already in one
 * subgraph get a nested group inside it; nodes spread over different
 * subgraphs throw, since the engine would keep them where they are.
 */
export function groupNodes(src, ids, gid, title) {
  const { blocks, member } = subgraphs(src);
  const homes = new Set(ids.map((id) => member.get(id) ?? null));
  if (homes.size > 1) throw new Error("These nodes are in different groups — ungroup them first.");
  const home = [...homes][0];
  const lines = src.split("\n");
  const doc = parseFlow(src);
  const base = stmtIndent(doc);
  const t = formatLabel(title);
  if (home === null) {
    const block = [`subgraph ${gid} [${t}]`, ...ids.map((id) => base + id), "end"];
    return appendLines(src, doc, block);
  }
  const b = blocks.find((x) => x.id === home);
  const ind = lines[b.endLine].match(/^[ \t]*/)[0] + base;
  const block = [`${ind}subgraph ${gid} [${t}]`, ...ids.map((id) => ind + base + id), `${ind}end`];
  // Bare `A` lines of the moved nodes in the outer block are dropped;
  // the new block goes first in it, since the first subgraph to mention
  // a node keeps it.
  const moved = new Set(ids);
  for (let n = b.endLine - 1; n > b.line; n--) {
    if (moved.has(lines[n].trim())) lines.splice(n, 1);
  }
  lines.splice(b.line + 1, 0, ...block);
  return lines.join("\n");
}

/** Rename a subgraph's title. */
export function renameGroup(src, gid, title) {
  const { blocks } = subgraphs(src);
  const b = blocks.find((x) => x.id === gid);
  if (!b) return src;
  const lines = src.split("\n");
  const ind = lines[b.line].match(/^[ \t]*/)[0];
  lines[b.line] = `${ind}subgraph ${gid} [${formatLabel(title)}]`;
  return lines.join("\n");
}

/** Remove a subgraph wrapper, keeping its contents (dedented one step). */
export function ungroup(src, gid) {
  const { blocks } = subgraphs(src);
  const b = blocks.find((x) => x.id === gid);
  if (!b || b.endLine < 0) return src;
  const lines = src.split("\n");
  const ind = lines[b.line].match(/^[ \t]*/)[0];
  const inner = lines.slice(b.line + 1, b.endLine);
  // Dedent by the step the block's first line used.
  const firstInd = inner.find((l) => l.trim())?.match(/^[ \t]*/)[0] ?? ind;
  const step = Math.max(0, firstInd.length - ind.length);
  const outside = lines.filter((_, n) => n < b.line || n > b.endLine).join("\n");
  const out = inner
    .map((l) => {
      const lead = l.match(/^[ \t]*/)[0].length;
      return l.slice(Math.min(step, Math.max(0, lead - ind.length)));
    })
    // Bare `A` lines only placed a node in the group; drop them when the
    // node is declared elsewhere anyway.
    .filter((l) => {
      const id = l.trim();
      if (!/^[\p{L}\p{N}_]+$/u.test(id)) return true;
      return !new RegExp(`(^|[^\\p{L}\\p{N}_])${id}(?![\\p{L}\\p{N}_])`, "u").test(outside);
    });
  lines.splice(b.line, b.endLine - b.line + 1, ...out);
  return lines.join("\n");
}
