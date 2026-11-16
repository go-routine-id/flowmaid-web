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
  let off = 0, front = false, sawHeader = false;
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
      continue;
    }
    for (const [a, b] of segs) {
      if (src.slice(a, b).trim() === "") continue;
      const stmt = parseStatement(src, a, b);
      if (stmt) line.segs.push({ start: a, end: b, stmt });
    }
  }
  return { src, lines };
}

/** True for `flowchart …` / `graph …` sources (after comments / front matter). */
export function isFlowchart(src) {
  let front = false;
  const lines = src.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (n === 0 && t === "---") { front = true; continue; }
    if (front) { if (t === "---") front = false; continue; }
    if (t === "" || t.startsWith("%%")) continue;
    return /^(?:flowchart|graph)\b/.test(t);
  }
  return false;
}

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

/** An id not used anywhere in the source (`N1`, `N2`, …). */
export function freshId(src, taken = []) {
  const used = new Set(taken);
  for (const m of src.matchAll(/[\p{L}\p{N}_]+/gu)) used.add(m[0]);
  for (let n = 1; ; n++) if (!used.has("N" + n)) return "N" + n;
}

export function addNode(src, id, label) {
  return appendLines(src, parseFlow(src), [id + "[" + formatLabel(label) + "]"]);
}

export function addEdge(src, from, to, op = "-->") {
  return appendLines(src, parseFlow(src), [`${from} ${op} ${to}`]);
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
  const outside = idsOutside(doc, seg);
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
  return out.replace(/^\u0000(?:\n|$)/gm, "").replace(/\n\u0000$/, "");
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
