//! Source-level edits for Mermaid flowcharts.
//!
//! The playground's visual editor and the MCP server never own a model
//! of their own: every action (add / rename / connect / delete / shape /
//! colour / group) is a text edit on the Mermaid source, which the
//! engine then re-parses. Only the statements an action touches are
//! rewritten; every other line stays byte-for-byte as it was typed.
//!
//! Scope: `flowchart` / `graph` documents. Statements are node chains
//! (`A[x] --> B & C -->|y| D`); everything else (subgraph, style, class,
//! comments, …) is opaque text, except where a deleted node has to be
//! scrubbed from `style` / `class` / `click` lines.
//!
//! Hand-written scanners instead of a regex crate: the same code runs
//! in the browser as wasm, where a regex engine would double the size.
//! All offsets are byte offsets into the source.

use std::collections::{HashMap, HashSet};

// ── Character classes ──

/// `[\p{L}\p{N}_]`: what a node id is made of.
fn is_id_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_'
}

/// ASCII `\w`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|t| t.chars().next())
}

fn byte_at(s: &str, i: usize) -> Option<u8> {
    s.as_bytes().get(i).copied()
}

/// Length of `[ \t]*` at `i`.
fn ws_len(s: &str, i: usize) -> usize {
    s.as_bytes()
        .get(i..)
        .map_or(0, |b| b.iter().take_while(|&&c| c == b' ' || c == b'\t').count())
}

/// Length of `\s*` (Unicode whitespace) at `i`.
fn space_len(s: &str, i: usize) -> usize {
    s.get(i..).map_or(0, |t| {
        t.char_indices()
            .find(|&(_, c)| !c.is_whitespace())
            .map_or(t.len(), |(k, _)| k)
    })
}

/// Length of `[\p{L}\p{N}_]+` at `i` (0 when none).
fn id_len(s: &str, i: usize) -> usize {
    s.get(i..).map_or(0, |t| {
        t.char_indices()
            .find(|&(_, c)| !is_id_char(c))
            .map_or(t.len(), |(k, _)| k)
    })
}

fn find_from(s: &str, pat: &str, from: usize) -> Option<usize> {
    s.get(from..).and_then(|t| t.find(pat)).map(|k| k + from)
}

fn leading_ws(s: &str) -> &str {
    &s[..ws_len(s, 0)]
}

// ── Parsed structure ──

#[derive(Clone, Debug, PartialEq)]
enum ShapeKind {
    Box(&'static str),
    At,
}

#[derive(Clone, Debug)]
struct Shape {
    kind: ShapeKind,
    start: usize,
    inner_start: usize,
    inner_end: usize,
    end: usize,
}

#[derive(Clone, Debug)]
struct Ref {
    id: String,
    start: usize,
    id_end: usize,
    end: usize,
    shape: Option<Shape>,
    cls: bool,
    raw: String,
}

#[derive(Clone, Debug)]
struct Op {
    raw: String,
    start: usize,
    end: usize,
}

#[derive(Clone, Debug)]
struct Stmt {
    groups: Vec<Vec<Ref>>,
    ops: Vec<Op>,
}

#[derive(Clone, Debug)]
struct Seg {
    start: usize,
    stmt: Stmt,
    in_group: bool,
}

#[derive(Clone, Debug)]
struct Line {
    n: usize,
    start: usize,
    end: usize,
    text: String,
    indent: String,
    segs: Vec<Seg>,
    head: Option<String>,
}

struct Doc<'a> {
    src: &'a str,
    lines: Vec<Line>,
}

impl Doc<'_> {
    fn refs(&self) -> impl Iterator<Item = &Ref> {
        self.lines
            .iter()
            .flat_map(|l| &l.segs)
            .flat_map(|s| &s.stmt.groups)
            .flatten()
    }
}

/// A position in a document: (line index, segment index).
type SegKey = (usize, usize);

// Shape openers, longest first so `((` wins over `(`.
const SHAPES: &[(&str, &[&str])] = &[
    ("(((", &[")))"]),
    ("([", &["])"]),
    ("[[", &["]]"]),
    ("[(", &[")]"]),
    ("((", &["))"]),
    ("{{", &["}}"]),
    ("[/", &["/]", "\\]"]),
    ("[\\", &["\\]", "/]"]),
    (">", &["]"]),
    ("[", &["]"]),
    ("(", &[")"]),
    ("{", &["}"]),
];

const OPAQUE_HEADS: &[&str] = &[
    "subgraph", "end", "direction", "classDef", "class", "style", "linkStyle", "click", "flowchart",
    "graph", "accTitle", "accDescr", "title",
];

// ── Scanners ──

/// Shape after a node id: `[label]`, `(["label"])`, `@{ ... }`, …
fn parse_shape(s: &str, i: usize) -> Option<Shape> {
    let b = s.as_bytes();
    if s[i..].starts_with("@{") {
        let mut depth = 0i32;
        let mut j = i + 1;
        while j < b.len() && b[j] != b'\n' {
            if b[j] == b'"' {
                j = find_from(s, "\"", j + 1)?;
            } else if b[j] == b'{' {
                depth += 1;
            } else if b[j] == b'}' {
                depth -= 1;
                if depth == 0 {
                    return Some(Shape { kind: ShapeKind::At, start: i, inner_start: i + 2, inner_end: j, end: j + 1 });
                }
            }
            j += 1;
        }
        return None;
    }
    for &(open, closers) in SHAPES {
        if !s[i..].starts_with(open) {
            continue;
        }
        let j = i + open.len();
        // Quoted labels may hold the closer characters.
        let mut from = j;
        let ws = ws_len(s, j);
        if byte_at(s, j + ws) == Some(b'"') {
            if let Some(q) = find_from(s, "\"", j + ws + 1) {
                from = q + 1;
            }
        }
        let eol = find_from(s, "\n", from).unwrap_or(s.len());
        let mut best: Option<(usize, usize)> = None;
        for c in closers {
            if let Some(k) = find_from(s, c, from) {
                if k < eol && best.is_none_or(|(b, _)| k < b) {
                    best = Some((k, c.len()));
                }
            }
        }
        let (k, len) = best?;
        return Some(Shape { kind: ShapeKind::Box(open), start: i, inner_start: j, inner_end: k, end: k + len });
    }
    None
}

fn parse_ref(s: &str, i: usize) -> Option<Ref> {
    let n = id_len(s, i);
    if n == 0 {
        return None;
    }
    let id_end = i + n;
    let mut end = id_end;
    let shape = parse_shape(s, end);
    if let Some(sh) = &shape {
        end = sh.end;
    }
    // `:::className`
    let mut cls = false;
    if s[end..].starts_with(":::") {
        let k = s[end + 3..]
            .bytes()
            .take_while(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            .count();
        if k > 0 {
            end += 3 + k;
            cls = true;
        }
    }
    Some(Ref { id: s[i..id_end].to_string(), start: i, id_end, end, shape, cls, raw: s[i..end].to_string() })
}

fn parse_group(s: &str, i: usize) -> Option<(Vec<Ref>, usize)> {
    let mut r = parse_ref(s, i)?;
    let mut refs = vec![r.clone()];
    loop {
        // `\s*&\s*`
        let a = r.end + space_len(s, r.end);
        if byte_at(s, a) != Some(b'&') {
            break;
        }
        let next = a + 1 + space_len(s, a + 1);
        match parse_ref(s, next) {
            Some(nx) => {
                refs.push(nx.clone());
                r = nx;
            }
            None => break,
        }
    }
    Some((refs, r.end))
}

fn is_xo(b: Option<u8>) -> bool {
    matches!(b, Some(b'x' | b'o'))
}

/// `-{2,}[>xo]?` / `={2,}[>xo]?` / `\.-+[>xo]?` at `c`: every length it
/// can match, in the order a backtracking regex would try them.
fn closer_ends(s: &str, c: usize) -> Vec<usize> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let run = |from: usize, ch: u8| b.get(from..).map_or(0, |t| t.iter().take_while(|&&x| x == ch).count());
    let mut push_with_tail = |end: usize| {
        if matches!(b.get(end), Some(b'>' | b'x' | b'o')) {
            out.push(end + 1);
        }
        out.push(end);
    };
    let d = run(c, b'-');
    for n in (2..=d).rev() {
        push_with_tail(c + n);
    }
    let e = run(c, b'=');
    for n in (2..=e).rev() {
        push_with_tail(c + n);
    }
    if b.get(c) == Some(&b'.') {
        let d = run(c + 1, b'-');
        for n in (1..=d).rev() {
            push_with_tail(c + 1 + n);
        }
    }
    out
}

/// `A -- text --> B`, `A == text ==> B`, `A -. text .-> B`.
fn edge_text(s: &str, i: usize) -> Option<usize> {
    let b = s.as_bytes();
    let starts: Vec<usize> = if matches!(b.get(i), Some(b'<' | b'x' | b'o')) { vec![i + 1, i] } else { vec![i] };
    for p in starts {
        let opener = matches!(
            (b.get(p), b.get(p + 1)),
            (Some(b'-'), Some(b'-')) | (Some(b'='), Some(b'=')) | (Some(b'-'), Some(b'.'))
        );
        if !opener {
            continue;
        }
        let q = p + 2;
        // (?![->=.]|[xo](?![\p{L}\p{N}_]))
        match b.get(q) {
            Some(b'-' | b'>' | b'=' | b'.') => continue,
            Some(b'x' | b'o') if !char_at(s, q + 1).is_some_and(is_id_char) => continue,
            _ => {}
        }
        let eol = find_from(s, "\n", q).unwrap_or(s.len());
        let w1 = ws_len(s, q);
        for ws1 in (0..=w1).rev() {
            let m0 = q + ws1;
            let mut mid_end = m0;
            loop {
                let w2 = ws_len(s, mid_end);
                for ws2 in (0..=w2).rev() {
                    for end in closer_ends(s, mid_end + ws2) {
                        // (?=[ \t]|[\p{L}\p{N}_"])
                        if char_at(s, end).is_some_and(|c| c == ' ' || c == '\t' || c == '"' || is_id_char(c)) {
                            return Some(end);
                        }
                    }
                }
                if mid_end >= eol {
                    break;
                }
                mid_end += char_at(s, mid_end).map_or(1, char::len_utf8);
            }
        }
    }
    None
}

/// `-->`, `---`, `==>`, `-.->`, `~~~`, `<-->`, `--o`, `x--x`, optional `|label|`.
fn edge_plain(s: &str, i: usize) -> Option<usize> {
    let b = s.as_bytes();
    let run = |from: usize, ch: u8| b.get(from..).map_or(0, |t| t.iter().take_while(|&&x| x == ch).count());
    let body = |p: usize| -> Option<usize> {
        let d = run(p, b'-');
        if d >= 2 {
            return Some(p + d);
        }
        let e = run(p, b'=');
        if e >= 2 {
            return Some(p + e);
        }
        if b.get(p) == Some(&b'-') {
            let dots = run(p + 1, b'.');
            if dots >= 1 && b.get(p + 1 + dots) == Some(&b'-') {
                return Some(p + 2 + dots);
            }
        }
        let t = run(p, b'~');
        if t >= 3 {
            return Some(p + t);
        }
        None
    };
    let mut end = if matches!(b.get(i), Some(b'<' | b'x' | b'o')) {
        body(i + 1).or_else(|| body(i))?
    } else {
        body(i)?
    };
    // (?:>|[xo](?![\p{L}\p{N}_]))?
    if b.get(end) == Some(&b'>') || (is_xo(b.get(end).copied()) && !char_at(s, end + 1).is_some_and(is_id_char)) {
        end += 1;
    }
    // (?:[ \t]*\|[^|\n]*\|)?
    let p = end + ws_len(s, end);
    if b.get(p) == Some(&b'|') {
        if let Some(k) = b[p + 1..].iter().position(|&c| c == b'|' || c == b'\n') {
            if b[p + 1 + k] == b'|' {
                end = p + 1 + k + 1;
            }
        }
    }
    Some(end)
}

fn parse_edge(s: &str, i: usize) -> Option<Op> {
    let end = edge_text(s, i).or_else(|| edge_plain(s, i))?;
    Some(Op { raw: s[i..end].to_string(), start: i, end })
}

/// A chain statement covering exactly `s[start..end]`, or None.
fn parse_statement(s: &str, start: usize, end: usize) -> Option<Stmt> {
    let sub = &s[..end];
    let mut i = start + ws_len(sub, start);
    let (g, gend) = parse_group(sub, i)?;
    let mut groups = vec![g];
    let mut ops = Vec::new();
    i = gend;
    loop {
        let ws = ws_len(sub, i);
        let Some(op) = parse_edge(sub, i + ws) else { break };
        let ws2 = ws_len(sub, op.end);
        let (g2, g2end) = parse_group(sub, op.end + ws2)?;
        ops.push(op);
        groups.push(g2);
        i = g2end;
    }
    if !sub[i..end].trim().is_empty() {
        return None;
    }
    Some(Stmt { groups, ops })
}

/// Split one line into `;`-separated segments (outside quotes / brackets).
fn split_segments(s: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let (mut depth, mut quote, mut seg_start) = (0i32, false, start);
    for (i, &c) in b.iter().enumerate().take(end).skip(start) {
        if quote {
            if c == b'"' {
                quote = false;
            }
            continue;
        }
        match c {
            b'"' => quote = true,
            b'[' | b'(' | b'{' => depth += 1,
            b']' | b')' | b'}' => depth = (depth - 1).max(0),
            b';' if depth == 0 => {
                out.push((seg_start, i));
                seg_start = i + 1;
            }
            _ => {}
        }
    }
    out.push((seg_start, end));
    out
}

/// `^[\w-]+` of a trimmed line.
fn head_word(t: &str) -> &str {
    let n = t.bytes().take_while(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-').count();
    &t[..n]
}

fn parse_flow(src: &str) -> Doc<'_> {
    let mut lines = Vec::new();
    let (mut off, mut front, mut saw_header, mut depth) = (0usize, false, false, 0i32);
    for (n, text) in src.split('\n').enumerate() {
        let (start, end) = (off, off + text.len());
        off = end + 1;
        let mut line = Line {
            n,
            start,
            end,
            text: text.to_string(),
            indent: leading_ws(text).to_string(),
            segs: Vec::new(),
            head: None,
        };
        let t = text.trim();
        if n == 0 && t == "---" {
            front = true;
            lines.push(line);
            continue;
        }
        if front {
            if t == "---" {
                front = false;
            }
            lines.push(line);
            continue;
        }
        if t.is_empty() || t.starts_with("%%") {
            lines.push(line);
            continue;
        }
        let head = head_word(t);
        let mut segs = split_segments(src, start, end);
        if !saw_header {
            if head != "flowchart" && head != "graph" {
                lines.push(line);
                continue;
            }
            // `graph LR; A --> B`: statements may follow the header.
            saw_header = true;
            segs.remove(0);
        } else if !head.is_empty() && OPAQUE_HEADS.contains(&head) && !head_then_edge(t, head.len()) {
            if head == "subgraph" {
                depth += 1;
            } else if head == "end" && depth > 0 {
                depth -= 1;
            }
            line.head = Some(head.to_string());
            lines.push(line);
            continue;
        }
        for (a, b) in segs {
            if src[a..b].trim().is_empty() {
                continue;
            }
            if let Some(stmt) = parse_statement(src, a, b) {
                line.segs.push(Seg { start: a, stmt, in_group: depth > 0 });
            }
        }
        lines.push(line);
    }
    Doc { src, lines }
}

/// `^[\w-]+\s*(?:&|-|=|~|<|[xo]-)`: a keyword used as a node id (`end --> x`).
fn head_then_edge(t: &str, head_len: usize) -> bool {
    let p = head_len + space_len(t, head_len);
    let b = t.as_bytes();
    match b.get(p) {
        Some(b'&' | b'-' | b'=' | b'~' | b'<') => true,
        Some(b'x' | b'o') => b.get(p + 1) == Some(&b'-'),
        _ => false,
    }
}

// ── Public reads ──

/// True for `flowchart …` / `graph …` sources (after comments / front matter).
pub fn is_flowchart(src: &str) -> bool {
    let mut front = false;
    for (n, l) in src.split('\n').enumerate() {
        let t = l.trim();
        if n == 0 && t == "---" {
            front = true;
            continue;
        }
        if front {
            if t == "---" {
                front = false;
            }
            continue;
        }
        if t.is_empty() || t.starts_with("%%") {
            continue;
        }
        for kw in ["flowchart", "graph"] {
            if let Some(rest) = t.strip_prefix(kw) {
                if !rest.chars().next().is_some_and(is_word) {
                    return true;
                }
            }
        }
        return false;
    }
    false
}

/// Every edge `(from, to)` in source order, as the engine expands them.
pub fn edge_list(src: &str) -> Vec<(String, String)> {
    let doc = parse_flow(src);
    let mut out = Vec::new();
    for seg in doc.lines.iter().flat_map(|l| &l.segs) {
        let st = &seg.stmt;
        for k in 0..st.ops.len() {
            for a in &st.groups[k] {
                for b in &st.groups[k + 1] {
                    out.push((a.id.clone(), b.id.clone()));
                }
            }
        }
    }
    out
}

fn unquote(t: &str) -> String {
    let mut t = t.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t = &t[1..t.len() - 1];
    }
    replace_br(&t.replace("#quot;", "\""))
}

/// `<br>`, `<br/>`, `<br />` (any case) → a space.
fn replace_br(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let lower = s.to_ascii_lowercase();
    while i < s.len() {
        if lower[i..].starts_with("<br") {
            let mut j = i + 3;
            j += space_len(s, j);
            if byte_at(s, j) == Some(b'/') {
                j += 1;
            }
            if byte_at(s, j) == Some(b'>') {
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        let c = char_at(s, i).unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// `label\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)` searched in `inner`:
/// (match start, match end, captured value).
fn at_label(inner: &str) -> Option<(usize, usize, String)> {
    let b = inner.as_bytes();
    let mut from = 0;
    while let Some(p) = find_from(inner, "label", from) {
        from = p + 1;
        let mut j = p + 5;
        j += space_len(inner, j);
        if byte_at(inner, j) != Some(b':') {
            continue;
        }
        j += 1;
        j += space_len(inner, j);
        let v = j;
        if b.get(v) == Some(&b'"') {
            let mut k = v + 1;
            let mut closed = None;
            while k < b.len() {
                match b[k] {
                    b'\\' => k += 2,
                    b'"' => {
                        closed = Some(k);
                        break;
                    }
                    _ => k += 1,
                }
            }
            if let Some(k) = closed {
                return Some((p, k + 1, inner[v..=k].to_string()));
            }
        }
        let n = inner[v..].find([',', '}']).unwrap_or(inner.len() - v);
        if n > 0 {
            return Some((p, v + n, inner[v..v + n].to_string()));
        }
    }
    None
}

/// The label a node currently shows (falls back to its id).
pub fn node_label(src: &str, id: &str) -> String {
    let doc = parse_flow(src);
    // Mermaid lets a later definition override an earlier one.
    let refs: Vec<&Ref> = doc.refs().collect();
    for r in refs.into_iter().rev() {
        let Some(sh) = r.shape.as_ref().filter(|_| r.id == id) else { continue };
        let inner = &src[sh.inner_start..sh.inner_end];
        if sh.kind == ShapeKind::At {
            if let Some((_, _, v)) = at_label(inner) {
                return unquote(&v);
            }
            continue;
        }
        return unquote(inner);
    }
    id.to_string()
}

/// `s.replace(/\s*\n\s*/g, " ")`: each newline with its surrounding whitespace → one space.
fn collapse_newlines(s: &str) -> String {
    if !s.contains('\n') {
        return s.to_string();
    }
    let mut out = String::new();
    for (k, part) in s.split('\n').enumerate() {
        if k > 0 {
            while out.ends_with(char::is_whitespace) {
                out.pop();
            }
            out.push(' ');
            out.push_str(part.trim_start());
        } else {
            out.push_str(part);
        }
    }
    out
}

/// Format a label for a `[…]` box: bare when safe, quoted otherwise.
pub fn format_label(label: &str) -> String {
    let s = collapse_newlines(label);
    let s = s.trim();
    let safe = s.chars().all(|c| c.is_alphabetic() || c.is_numeric() || " _.,!?'+*/-".contains(c));
    let edge_slash = s.starts_with(['/', '\\']) || s.ends_with(['/', '\\']);
    if !s.is_empty() && safe && !edge_slash {
        return s.to_string();
    }
    format!("\"{}\"", s.replace('"', "#quot;"))
}

/// Apply non-overlapping `(start, end, text)` edits.
fn splice(src: &str, mut edits: Vec<(usize, usize, String)>) -> String {
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = src.to_string();
    for (a, b, t) in edits {
        out.replace_range(a..b, &t);
    }
    out
}

/// Rename a node's label, keeping its shape. Adds `[label]` when it has none.
pub fn rename_node(src: &str, id: &str, label: &str) -> String {
    let doc = parse_flow(src);
    let refs: Vec<&Ref> = doc.refs().filter(|r| r.id == id).collect();
    for r in refs.iter().rev() {
        let Some(sh) = &r.shape else { continue };
        if sh.kind == ShapeKind::At {
            let inner = &src[sh.inner_start..sh.inner_end];
            let q = format!("\"{}\"", label.trim().replace('"', "#quot;"));
            let next = match at_label(inner) {
                Some((a, b, _)) => format!("{}label: {}{}", &inner[..a], q, &inner[b..]),
                None => format!("{}, label: {} ", inner.trim_end(), q),
            };
            return splice(src, vec![(sh.inner_start, sh.inner_end, next)]);
        }
        return splice(src, vec![(sh.inner_start, sh.inner_end, format_label(label))]);
    }
    match refs.first() {
        Some(first) => splice(src, vec![(first.id_end, first.id_end, format!("[{}]", format_label(label)))]),
        None => src.to_string(),
    }
}

fn stmt_indent(doc: &Doc) -> String {
    for l in &doc.lines {
        if !l.segs.is_empty() {
            return if l.indent.is_empty() { "    ".into() } else { l.indent.clone() };
        }
    }
    "    ".into()
}

/// Append statement lines at the end of the source.
fn append_lines(src: &str, doc: &Doc, stmts: &[String]) -> String {
    let indent = stmt_indent(doc);
    let body = src.trim_end();
    let trail = &src[body.len()..];
    let mut out = body.to_string();
    for s in stmts {
        out.push('\n');
        out.push_str(&indent);
        out.push_str(s);
    }
    if let Some(k) = trail.find('\n') {
        out.push_str(&trail[k..]);
    }
    out
}

/// An id not used anywhere in the source (`N1`, `N2`, … for prefix "N").
pub fn fresh_id(src: &str, taken: &[String], prefix: &str) -> String {
    let mut used: HashSet<&str> = taken.iter().map(String::as_str).collect();
    let mut i = 0;
    while i < src.len() {
        let n = id_len(src, i);
        if n > 0 {
            used.insert(&src[i..i + n]);
            i += n;
        } else {
            i += char_at(src, i).map_or(1, char::len_utf8);
        }
    }
    (1..).map(|n| format!("{prefix}{n}")).find(|c| !used.contains(c.as_str())).unwrap()
}

pub fn add_node(src: &str, id: &str, label: &str) -> String {
    append_lines(src, &parse_flow(src), &[format!("{id}[{}]", format_label(label))])
}

pub fn add_edge(src: &str, from: &str, to: &str, op: &str) -> String {
    append_lines(src, &parse_flow(src), &[format!("{from} {op} {to}")])
}

// ── Rewriting chains ──

struct Piece {
    groups: Vec<Vec<Ref>>,
    ops: Vec<Op>,
    text: Option<String>,
}

fn join_refs(g: &[Ref]) -> String {
    g.iter().map(|r| r.raw.as_str()).collect::<Vec<_>>().join(" & ")
}

fn piece_text(p: &Piece) -> String {
    let mut out = join_refs(&p.groups[0]);
    for k in 0..p.ops.len() {
        out.push(' ');
        out.push_str(p.ops[k].raw.trim());
        out.push(' ');
        out.push_str(&join_refs(&p.groups[k + 1]));
    }
    out
}

// Ids that appear in any statement other than `except`.
fn ids_outside(doc: &Doc, except: SegKey) -> HashSet<String> {
    let mut ids = HashSet::new();
    for (li, l) in doc.lines.iter().enumerate() {
        for (si, s) in l.segs.iter().enumerate() {
            if (li, si) == except {
                continue;
            }
            for r in s.stmt.groups.iter().flatten() {
                ids.insert(r.id.clone());
            }
        }
    }
    // Subgraph ids are declared by their `subgraph` line.
    for l in &doc.lines {
        if l.head.as_deref() == Some("subgraph") {
            if let Some(id) = l.text.trim().split(|c: char| c.is_whitespace() || c == '[').nth(1) {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

// A lone `A` (or `A & B`) adds nothing when every id in it is declared
// elsewhere and carries no shape or class.
fn is_redundant(p: &Piece, outside: &HashSet<String>, emitted: &HashSet<String>) -> bool {
    p.ops.is_empty()
        && p.groups[0]
            .iter()
            .all(|r| r.shape.is_none() && !r.cls && (outside.contains(&r.id) || emitted.contains(&r.id)))
}

fn finish_pieces(doc: &Doc, key: SegKey, pieces: Vec<Piece>) -> Vec<String> {
    let seg = &doc.lines[key.0].segs[key.1];
    // Inside a subgraph a lone `A` is what puts A in the group: keep it.
    let outside = if seg.in_group { HashSet::new() } else { ids_outside(doc, key) };
    let mut emitted = HashSet::new();
    let mut kept = Vec::new();
    for p in pieces {
        if is_redundant(&p, &outside, &emitted) {
            continue;
        }
        for r in p.groups.iter().flatten() {
            emitted.insert(r.id.clone());
        }
        kept.push(p.text.clone().unwrap_or_else(|| piece_text(&p)));
    }
    kept
}

/// Drop line `l` (with its newline) from the source.
fn drop_line_edit(doc: &Doc, l: &Line) -> (usize, usize, String) {
    if l.end < doc.src.len() {
        (l.start, (l.end + 1).min(doc.src.len()), String::new())
    } else {
        (l.start.saturating_sub(1), l.end, String::new())
    }
}

// Replace each changed segment with its new pieces.
fn rewrite(doc: &Doc, changes: &HashMap<SegKey, Vec<String>>) -> String {
    let mut edits = Vec::new();
    for (li, line) in doc.lines.iter().enumerate() {
        let touched: Vec<usize> = (0..line.segs.len()).filter(|si| changes.contains_key(&(li, *si))).collect();
        if touched.is_empty() {
            continue;
        }
        let all: Vec<(usize, usize)> = split_segments(doc.src, line.start, line.end)
            .into_iter()
            .filter(|&(a, b)| !doc.src[a..b].trim().is_empty())
            .collect();
        if all.len() <= 1 && touched.len() == 1 {
            let pieces = &changes[&(li, touched[0])];
            if pieces.is_empty() {
                edits.push(drop_line_edit(doc, line));
            } else {
                let text = pieces.iter().map(|p| format!("{}{p}", line.indent)).collect::<Vec<_>>().join("\n");
                edits.push((line.start, line.end, text));
            }
            continue;
        }
        // Several `;` statements on one line: rebuild the line in place.
        let mut parts: Vec<String> = Vec::new();
        for (a, b) in all {
            match line.segs.iter().position(|s| s.start == a).filter(|si| changes.contains_key(&(li, *si))) {
                Some(si) => parts.extend(changes[&(li, si)].iter().cloned()),
                None => parts.push(doc.src[a..b].trim().to_string()),
            }
        }
        if parts.is_empty() {
            edits.push(drop_line_edit(doc, line));
        } else {
            edits.push((line.start, line.end, format!("{}{}", line.indent, parts.join("; "))));
        }
    }
    splice(doc.src, edits)
}

/// Rewrite whole lines: `f` returns None to drop a line (with its
/// newline; the last line becomes empty), or its new text.
fn map_lines(src: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let lines: Vec<&str> = src.split('\n').collect();
    let last = lines.len() - 1;
    let mut out: Vec<String> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        match f(l) {
            Some(t) => out.push(t),
            None if i == last => out.push(String::new()),
            None => {}
        }
    }
    out.join("\n")
}

// `linkStyle` addresses edges by their index in source order; after
// edges are removed, drop the ones that went and shift the rest down.
fn renumber_link_styles(src: &str, removed: &[usize]) -> String {
    if removed.is_empty() {
        return src.to_string();
    }
    let out = map_lines(src, |l| {
        let ind = ws_len(l, 0);
        let Some(after) = l[ind..].strip_prefix("linkStyle") else { return Some(l.to_string()) };
        let gap = ws_len(after, 0);
        if gap == 0 {
            return Some(l.to_string());
        }
        let list_len = after[gap..].bytes().take_while(|&c| c.is_ascii_digit() || c == b',').count();
        if list_len == 0 {
            return Some(l.to_string());
        }
        let pre = &l[..ind + 9 + gap];
        let list = &after[gap..gap + list_len];
        let rest = &after[gap + list_len..];
        let ids: Vec<String> = list
            .split(',')
            .filter(|x| !x.is_empty())
            .filter_map(|x| x.parse::<usize>().ok())
            .filter(|n| !removed.contains(n))
            .map(|n| (n - removed.iter().filter(|&&r| r < n).count()).to_string())
            .collect();
        if ids.is_empty() { None } else { Some(format!("{pre}{}{rest}", ids.join(","))) }
    });
    if out.ends_with('\n') && !src.ends_with('\n') {
        out[..out.len() - 1].to_string()
    } else {
        out
    }
}

/// `^[ \t]*KW[ \t]+ID` followed by a non-id char (or end): the line names the node.
fn names_node(l: &str, kw: &str, id: &str) -> bool {
    let ind = ws_len(l, 0);
    let Some(after) = l[ind..].strip_prefix(kw) else { return false };
    let gap = ws_len(after, 0);
    gap > 0 && after[gap..].starts_with(id) && !char_at(after, gap + id.len()).is_some_and(is_id_char)
}

/// Delete a node, every edge touching it, and its style/class/click lines.
pub fn delete_node(src: &str, id: &str) -> String {
    let doc = parse_flow(src);
    let mut changes = HashMap::new();
    for (li, line) in doc.lines.iter().enumerate() {
        for (si, seg) in line.segs.iter().enumerate() {
            let st = &seg.stmt;
            if !st.groups.iter().flatten().any(|r| r.id == id) {
                continue;
            }
            let gs: Vec<Vec<Ref>> = st.groups.iter().map(|g| g.iter().filter(|r| r.id != id).cloned().collect()).collect();
            let mut pieces = Vec::new();
            let mut cur: Option<Piece> = None;
            for (i, g) in gs.iter().enumerate() {
                if g.is_empty() {
                    if let Some(c) = cur.take() {
                        pieces.push(c);
                    }
                    continue;
                }
                match cur.as_mut() {
                    None => cur = Some(Piece { groups: vec![g.clone()], ops: vec![], text: None }),
                    Some(c) => {
                        c.ops.push(st.ops[i - 1].clone());
                        c.groups.push(g.clone());
                    }
                }
            }
            if let Some(c) = cur {
                pieces.push(c);
            }
            changes.insert((li, si), finish_pieces(&doc, (li, si), pieces));
        }
    }
    let removed: Vec<usize> = edge_list(src)
        .iter()
        .enumerate()
        .filter(|(_, (a, b))| a == id || b == id)
        .map(|(i, _)| i)
        .collect();
    let out = renumber_link_styles(&rewrite(&doc, &changes), &removed);
    // Scrub style / click lines that name the node, and drop it from class lists.
    let out = map_lines(&out, |l| {
        if names_node(l, "style", id) || names_node(l, "click", id) {
            return None;
        }
        // ^([ \t]*class[ \t]+)(\S+)([ \t]+[^\n]*)$
        let ind = ws_len(l, 0);
        if let Some(after) = l[ind..].strip_prefix("class") {
            let gap = ws_len(after, 0);
            let list_len = after[gap..].find(char::is_whitespace).unwrap_or(after.len() - gap);
            let rest = &after[gap + list_len..];
            if gap > 0 && list_len > 0 && ws_len(rest, 0) > 0 {
                let list: Vec<&str> = after[gap..gap + list_len].split(',').collect();
                let kept: Vec<&str> = list.iter().copied().filter(|x| *x != id).collect();
                if kept.len() != list.len() {
                    if kept.is_empty() {
                        return None;
                    }
                    return Some(format!("{}{}{rest}", &l[..ind + 5 + gap], kept.join(",")));
                }
            }
        }
        Some(l.to_string())
    });
    drop_empty_groups(&out)
}

// Remove subgraph blocks left with nothing inside (innermost first).
fn drop_empty_groups(src: &str) -> String {
    let mut src = src.to_string();
    loop {
        let (blocks, _) = subgraphs(&src);
        let lines: Vec<&str> = src.split('\n').collect();
        // A group that edges point at is a node of its own: keep that.
        let used: HashSet<String> = parse_flow(&src).refs().map(|r| r.id.clone()).collect();
        let empty = blocks.iter().find(|b| {
            b.end_line.is_some_and(|e| e > b.line)
                && !used.contains(&b.id)
                && lines[b.line + 1..b.end_line.unwrap()]
                    .iter()
                    .all(|l| l.trim().is_empty() || l.trim().starts_with("%%"))
        });
        let Some(e) = empty else { return src };
        let (a, z) = (e.line, e.end_line.unwrap());
        let mut v: Vec<&str> = lines.clone();
        v.drain(a..=z);
        src = v.join("\n");
    }
}

struct EdgeHit {
    key: SegKey,
    k: usize,
    a: usize,
    b: usize,
    index: usize,
}

// Locate the nth from → to edge: its statement and position.
fn find_edge(doc: &Doc, from: &str, to: &str, nth: usize) -> Option<EdgeHit> {
    let (mut count, mut index) = (0usize, 0usize);
    for (li, line) in doc.lines.iter().enumerate() {
        for (si, seg) in line.segs.iter().enumerate() {
            let st = &seg.stmt;
            for k in 0..st.ops.len() {
                for (ai, a) in st.groups[k].iter().enumerate() {
                    for (bi, b) in st.groups[k + 1].iter().enumerate() {
                        if a.id == from && b.id == to {
                            if count == nth {
                                return Some(EdgeHit { key: (li, si), k, a: ai, b: bi, index });
                            }
                            count += 1;
                        }
                        index += 1;
                    }
                }
            }
        }
    }
    None
}

/// Delete the `nth` (0-based) edge from → to, in source order.
pub fn delete_edge(src: &str, from: &str, to: &str, nth: usize) -> String {
    let doc = parse_flow(src);
    let Some(h) = find_edge(&doc, from, to, nth) else { return src.to_string() };
    let st = &doc.lines[h.key.0].segs[h.key.1].stmt;
    let gs = &st.groups;
    let mut pieces = vec![Piece { groups: gs[..=h.k].to_vec(), ops: st.ops[..h.k].to_vec(), text: None }];
    for (xi, x) in gs[h.k].iter().enumerate() {
        for (yi, y) in gs[h.k + 1].iter().enumerate() {
            if (xi, yi) == (h.a, h.b) {
                continue;
            }
            let op = &st.ops[h.k];
            pieces.push(Piece {
                groups: vec![vec![x.clone()], vec![y.clone()]],
                ops: vec![op.clone()],
                text: Some(format!("{} {} {}", x.id, op.raw.trim(), y.id)),
            });
        }
    }
    pieces.push(Piece { groups: gs[h.k + 1..].to_vec(), ops: st.ops[h.k + 1..].to_vec(), text: None });
    let kept = finish_pieces(&doc, h.key, pieces);
    let out = rewrite(&doc, &HashMap::from([(h.key, kept)]));
    renumber_link_styles(&out, &[h.index])
}

// ── Edges: label, line style, direction ──

/// An edge operator, split up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeOp {
    /// `<`, `x`, `o` or "".
    pub start: String,
    /// "solid" | "dotted" | "thick" | "invisible".
    pub kind: String,
    /// `>`, `x`, `o` or "" (no arrowhead).
    pub end: String,
    pub label: Option<String>,
}

/// Split an edge operator (`-->|x|`, `-- x -->`, `-.->`, `<==>`, …).
pub fn parse_op(raw: &str) -> EdgeOp {
    let raw = raw.trim();
    let mut arrow = raw.to_string();
    let mut label: Option<String> = None;
    // ^(.*?)\s*\|([^|]*)\|$
    let pipe = raw.ends_with('|') && raw.len() >= 2;
    let prev = if pipe { raw[..raw.len() - 1].rfind('|') } else { None };
    if let (true, Some(p)) = (pipe, prev) {
        arrow = raw[..p].trim_end().to_string();
        label = Some(raw[p + 1..raw.len() - 1].to_string());
    } else if let Some((a, l)) = text_op(raw) {
        arrow = a;
        label = Some(l);
    }
    let kind = if arrow.contains('~') {
        "invisible"
    } else if arrow.contains('=') {
        "thick"
    } else if arrow.contains('.') {
        "dotted"
    } else {
        "solid"
    };
    let ab = arrow.as_bytes();
    let start = if matches!(ab.first(), Some(b'<' | b'x' | b'o')) && matches!(ab.get(1), Some(b'-' | b'=' | b'.' | b'~')) {
        (ab[0] as char).to_string()
    } else {
        String::new()
    };
    let end = if arrow.len() > 1 && matches!(ab.last(), Some(b'>' | b'x' | b'o')) {
        (*ab.last().unwrap() as char).to_string()
    } else {
        String::new()
    };
    EdgeOp { start, kind: kind.into(), end, label: label.map(|l| unquote(&l)) }
}

/// `^([<xo]?)(--|==|-\.)\s+(.*?)\s+(-{2,}[>xo]?|={2,}[>xo]?|\.-+[>xo]?)$`
/// → (arrow without the text, text).
fn text_op(raw: &str) -> Option<(String, String)> {
    let b = raw.as_bytes();
    let starts: Vec<usize> = if matches!(b.first(), Some(b'<' | b'x' | b'o')) { vec![1, 0] } else { vec![0] };
    let full_closer = |c: usize| -> bool { closer_ends(raw, c).contains(&raw.len()) };
    for p in starts {
        let open = match (b.get(p), b.get(p + 1)) {
            (Some(b'-'), Some(b'-')) => "--",
            (Some(b'='), Some(b'=')) => "==",
            (Some(b'-'), Some(b'.')) => "-.",
            _ => continue,
        };
        let q = p + 2;
        let w1 = space_len(raw, q);
        for ws1 in (1..=w1).rev() {
            let m0 = q + ws1;
            let mut mid_end = m0;
            while mid_end <= raw.len() {
                let w2 = space_len(raw, mid_end);
                for ws2 in (1..=w2).rev() {
                    if full_closer(mid_end + ws2) {
                        let closer = &raw[mid_end + ws2..];
                        return Some((format!("{}{open}{closer}", &raw[..p]), raw[m0..mid_end].to_string()));
                    }
                }
                if mid_end == raw.len() {
                    break;
                }
                mid_end += char_at(raw, mid_end).map_or(1, char::len_utf8);
            }
        }
    }
    None
}

/// Inverse of [`parse_op`].
pub fn build_op(op: &EdgeOp) -> String {
    let end = op.end.as_str();
    let body = match op.kind.as_str() {
        "invisible" => "~~~".to_string(),
        "thick" => if end.is_empty() { "===".into() } else { format!("=={end}") },
        "dotted" => if end.is_empty() { "-.-".into() } else { format!("-.-{end}") },
        _ => if end.is_empty() { "---".into() } else { format!("--{end}") },
    };
    let arrow = if op.kind == "invisible" || end.is_empty() { body } else { format!("{}{body}", op.start) };
    match &op.label {
        Some(l) if !l.trim().is_empty() => {
            let l = collapse_newlines(l.trim());
            if l.contains(['|', '"']) {
                format!("{arrow}|\"{}\"|", l.replace('"', "#quot;").replace('|', "/"))
            } else {
                format!("{arrow}|{l}|")
            }
        }
        _ => arrow,
    }
}

/// The parsed operator of the nth from → to edge, or None.
pub fn edge_op(src: &str, from: &str, to: &str, nth: usize) -> Option<EdgeOp> {
    let doc = parse_flow(src);
    let h = find_edge(&doc, from, to, nth)?;
    Some(parse_op(&doc.lines[h.key.0].segs[h.key.1].stmt.ops[h.k].raw))
}

// Rewrite one edge. `mutate` returns the new operator; `swap` reverses
// it. A plain `A --> B` statement is edited in place; an edge that
// shares its operator with others (chains, `&`) is split out.
fn edit_edge(src: &str, from: &str, to: &str, nth: usize, mutate: impl Fn(EdgeOp) -> EdgeOp, swap: bool) -> String {
    let doc = parse_flow(src);
    let Some(h) = find_edge(&doc, from, to, nth) else { return src.to_string() };
    let st = &doc.lines[h.key.0].segs[h.key.1].stmt;
    let op = &st.ops[h.k];
    let next = build_op(&mutate(parse_op(&op.raw)));
    let (a, b) = (&st.groups[h.k][h.a], &st.groups[h.k + 1][h.b]);
    let single = st.groups[h.k].len() == 1 && st.groups[h.k + 1].len() == 1;
    if single && (!swap || st.ops.len() == 1) {
        let mut edits = vec![(op.start, op.end, next)];
        if swap {
            edits.push((a.start, a.end, b.raw.clone()));
            edits.push((b.start, b.end, a.raw.clone()));
        }
        return splice(src, edits);
    }
    let gs = &st.groups;
    let mut pieces = vec![Piece { groups: gs[..=h.k].to_vec(), ops: st.ops[..h.k].to_vec(), text: None }];
    for (xi, x) in gs[h.k].iter().enumerate() {
        for (yi, y) in gs[h.k + 1].iter().enumerate() {
            let text = if (xi, yi) == (h.a, h.b) {
                let (p, q) = if swap { (y, x) } else { (x, y) };
                format!("{} {next} {}", p.id, q.id)
            } else {
                format!("{} {} {}", x.id, op.raw.trim(), y.id)
            };
            let (p, q) = if swap && (xi, yi) == (h.a, h.b) { (y, x) } else { (x, y) };
            pieces.push(Piece { groups: vec![vec![p.clone()], vec![q.clone()]], ops: vec![op.clone()], text: Some(text) });
        }
    }
    pieces.push(Piece { groups: gs[h.k + 1..].to_vec(), ops: st.ops[h.k + 1..].to_vec(), text: None });
    let kept = finish_pieces(&doc, h.key, pieces);
    rewrite(&doc, &HashMap::from([(h.key, kept)]))
}

/// Set (or with "" remove) the label of the nth from → to edge.
pub fn set_edge_label(src: &str, from: &str, to: &str, nth: usize, label: &str) -> String {
    let label = label.to_string();
    edit_edge(src, from, to, nth, move |o| EdgeOp { label: Some(label.clone()), ..o }, false)
}

/// kind: "solid" | "dotted" | "thick".
pub fn set_edge_kind(src: &str, from: &str, to: &str, nth: usize, kind: &str) -> String {
    let kind = kind.to_string();
    edit_edge(src, from, to, nth, move |o| EdgeOp { kind: kind.clone(), ..o }, false)
}

pub fn reverse_edge(src: &str, from: &str, to: &str, nth: usize) -> String {
    edit_edge(src, from, to, nth, |o| o, true)
}

// ── Node colours (`style` lines) ──

/// `^([ \t]*)style[ \t]+ID[ \t]+(.*)$` → (indent, props text).
fn style_line<'a>(l: &'a str, id: &str) -> Option<(&'a str, &'a str)> {
    let ind = ws_len(l, 0);
    let after = l[ind..].strip_prefix("style")?;
    let gap = ws_len(after, 0);
    if gap == 0 || !after[gap..].starts_with(id) {
        return None;
    }
    let rest = &after[gap + id.len()..];
    let g2 = ws_len(rest, 0);
    if g2 == 0 {
        return None;
    }
    Some((&l[..ind], &rest[g2..]))
}

/// Set (merge) style props on nodes, e.g. `[("fill", Some("#fff"))]`; a
/// prop set to None is removed, and `props` None clears fill / stroke /
/// color. Each node ends with at most one `style` line, where its first was.
pub fn set_node_style(src: &str, ids: &[String], props: Option<&[(String, Option<String>)]>) -> String {
    let mut lines: Vec<String> = src.split('\n').map(String::from).collect();
    for id in ids {
        let mut map: Vec<(String, String)> = Vec::new();
        let mut at: Option<usize> = None;
        let mut indent = String::new();
        let mut kept = Vec::new();
        for (n, l) in lines.iter().enumerate() {
            let Some((ind, body)) = style_line(l, id) else {
                kept.push(l.clone());
                continue;
            };
            if at.is_none() {
                at = Some(n);
                indent = ind.to_string();
            }
            let body = body.trim_end();
            let body = body.strip_suffix(';').unwrap_or(body);
            for kv in body.split(',') {
                if let Some(i) = kv.find(':').filter(|&i| i > 0) {
                    let (k, v) = (kv[..i].trim().to_string(), kv[i + 1..].trim().to_string());
                    match map.iter_mut().find(|(mk, _)| *mk == k) {
                        Some(e) => e.1 = v,
                        None => map.push((k, v)),
                    }
                }
            }
        }
        lines = kept;
        let clear: Vec<(String, Option<String>)> =
            ["fill", "stroke", "color"].iter().map(|k| (k.to_string(), None)).collect();
        for (k, v) in props.unwrap_or(&clear) {
            match v {
                None => map.retain(|(mk, _)| mk != k),
                Some(v) => match map.iter_mut().find(|(mk, _)| mk == k) {
                    Some(e) => e.1 = v.clone(),
                    None => map.push((k.clone(), v.clone())),
                },
            }
        }
        if map.is_empty() {
            continue;
        }
        let line = format!(
            "style {id} {}",
            map.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(",")
        );
        match at {
            Some(a) => lines.insert(a.min(lines.len()), format!("{indent}{line}")),
            None => {
                let joined = lines.join("\n");
                let doc = parse_flow(&joined);
                lines = append_lines(&joined, &doc, &[line]).split('\n').map(String::from).collect();
            }
        }
    }
    lines.join("\n")
}

/// Current fill of a node from its `style` lines (last one wins), or None.
pub fn node_fill(src: &str, id: &str) -> Option<String> {
    let mut fill = None;
    for l in src.split('\n') {
        let Some((_, body)) = style_line(l, id) else { continue };
        // (?:^|,)\s*fill\s*:\s*([^,;]+)
        for part in body.split(',') {
            let t = part.trim_start();
            let Some(r) = t.strip_prefix("fill") else { continue };
            let r = r.trim_start();
            let Some(v) = r.strip_prefix(':') else { continue };
            let v = v.trim_start();
            let n = v.find(';').unwrap_or(v.len());
            if n > 0 {
                fill = Some(v[..n].trim().to_string());
                break;
            }
        }
    }
    fill
}

// ── Subgraphs ──

/// A `subgraph … end` block. Lines are 0-based line numbers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub id: String,
    pub title: String,
    pub line: usize,
    pub end_line: Option<usize>,
    pub depth: usize,
    pub parent: Option<String>,
}

/// Subgraph blocks, and the group each node belongs to (the engine keeps
/// a node in the first subgraph that mentions it), in mention order.
pub fn subgraphs(src: &str) -> (Vec<Block>, Vec<(String, String)>) {
    let doc = parse_flow(src);
    let mut blocks: Vec<Block> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut member: Vec<(String, String)> = Vec::new();
    for line in &doc.lines {
        if line.head.as_deref() == Some("subgraph") {
            let rest = line.text.trim()["subgraph".len()..].trim();
            let n = id_len(rest, 0);
            let id = if n > 0 { rest[..n].to_string() } else { format!("#{}", line.n) };
            let title = bracket_title(rest).unwrap_or(rest);
            blocks.push(Block {
                id,
                title: unquote(title),
                line: line.n,
                end_line: None,
                depth: stack.len(),
                parent: stack.last().map(|&i| blocks[i].id.clone()),
            });
            stack.push(blocks.len() - 1);
            continue;
        }
        if line.head.as_deref() == Some("end") {
            if let Some(i) = stack.pop() {
                blocks[i].end_line = Some(line.n);
                continue;
            }
        }
        let Some(&top) = stack.last() else { continue };
        for r in line.segs.iter().flat_map(|s| s.stmt.groups.iter().flatten()) {
            if !member.iter().any(|(m, _)| *m == r.id) {
                member.push((r.id.clone(), blocks[top].id.clone()));
            }
        }
    }
    (blocks, member)
}

/// `\[(.*)\]\s*$` → the text between the first `[` and a final `]`.
fn bracket_title(rest: &str) -> Option<&str> {
    let t = rest.trim_end();
    if !t.ends_with(']') {
        return None;
    }
    let open = rest.find('[')?;
    let close = t.len() - 1;
    (open < close).then(|| &rest[open + 1..close])
}

fn member_of<'a>(member: &'a [(String, String)], id: &str) -> Option<&'a str> {
    member.iter().find(|(m, _)| m == id).map(|(_, g)| g.as_str())
}

/// Wrap nodes in a new `subgraph gid [title]`. Nodes already in one
/// subgraph get a nested group inside it; nodes spread over different
/// subgraphs are refused, since the engine would keep them where they are.
pub fn group_nodes(src: &str, ids: &[String], gid: &str, title: &str) -> Result<String, String> {
    let (blocks, member) = subgraphs(src);
    let mut homes: Vec<Option<&str>> = ids.iter().map(|id| member_of(&member, id)).collect();
    homes.dedup();
    homes.sort();
    homes.dedup();
    if homes.len() > 1 {
        return Err("These nodes are in different groups — ungroup them first.".into());
    }
    let home = homes.first().copied().flatten();
    let doc = parse_flow(src);
    let base = stmt_indent(&doc);
    let t = format_label(title);
    let Some(home) = home else {
        let mut block = vec![format!("subgraph {gid} [{t}]")];
        block.extend(ids.iter().map(|id| format!("{base}{id}")));
        block.push("end".into());
        return Ok(append_lines(src, &doc, &block));
    };
    let b = blocks.iter().find(|x| x.id == home).expect("home block");
    let mut lines: Vec<String> = src.split('\n').map(String::from).collect();
    let end_line = b.end_line.unwrap_or(lines.len() - 1);
    let ind = format!("{}{base}", leading_ws(&lines[end_line]));
    let mut block = vec![format!("{ind}subgraph {gid} [{t}]")];
    block.extend(ids.iter().map(|id| format!("{ind}{base}{id}")));
    block.push(format!("{ind}end"));
    // Bare `A` lines of the moved nodes in the outer block are dropped;
    // the new block goes first in it, since the first subgraph to mention
    // a node keeps it.
    for n in (b.line + 1..end_line).rev() {
        if ids.iter().any(|id| lines[n].trim() == id) {
            lines.remove(n);
        }
    }
    lines.splice(b.line + 1..b.line + 1, block);
    Ok(lines.join("\n"))
}

/// Rename a subgraph's title.
pub fn rename_group(src: &str, gid: &str, title: &str) -> String {
    let (blocks, _) = subgraphs(src);
    let Some(b) = blocks.iter().find(|x| x.id == gid) else { return src.to_string() };
    let mut lines: Vec<String> = src.split('\n').map(String::from).collect();
    let ind = leading_ws(&lines[b.line]).to_string();
    lines[b.line] = format!("{ind}subgraph {gid} [{}]", format_label(title));
    lines.join("\n")
}

/// Remove a subgraph wrapper, keeping its contents (dedented one step).
pub fn ungroup(src: &str, gid: &str) -> String {
    let (blocks, _) = subgraphs(src);
    let Some(b) = blocks.iter().find(|x| x.id == gid) else { return src.to_string() };
    let Some(end_line) = b.end_line else { return src.to_string() };
    let lines: Vec<&str> = src.split('\n').collect();
    let ind = ws_len(lines[b.line], 0);
    let inner = &lines[b.line + 1..end_line];
    // Dedent by the step the block's first line used.
    let first_ind = inner.iter().find(|l| !l.trim().is_empty()).map_or(ind, |l| ws_len(l, 0));
    let step = first_ind.saturating_sub(ind);
    let outside: String = lines
        .iter()
        .enumerate()
        .filter(|(n, _)| *n < b.line || *n > end_line)
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join("\n");
    let out: Vec<String> = inner
        .iter()
        .map(|l| {
            let lead = ws_len(l, 0);
            l[step.min(lead.saturating_sub(ind))..].to_string()
        })
        // Bare `A` lines only placed a node in the group; drop them when
        // the node is declared elsewhere anyway.
        .filter(|l| {
            let id = l.trim();
            if id.is_empty() || !id.chars().all(is_id_char) {
                return true;
            }
            !mentions(&outside, id)
        })
        .collect();
    let mut v: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    v.splice(b.line..=end_line, out);
    v.join("\n")
}

/// `(^|[^\p{L}\p{N}_])ID(?![\p{L}\p{N}_])` anywhere in `hay`.
fn mentions(hay: &str, id: &str) -> bool {
    let mut from = 0;
    while let Some(p) = find_from(hay, id, from) {
        let before_ok = p == 0 || !hay[..p].chars().next_back().is_some_and(is_id_char);
        let after_ok = !char_at(hay, p + id.len()).is_some_and(is_id_char);
        if before_ok && after_ok {
            return true;
        }
        from = p + id.len().max(1);
    }
    false
}

// ── Node shapes ──

/// Shapes the engine draws distinctly, with their Mermaid brackets.
pub const NODE_SHAPES: &[(&str, &str, &str)] = &[
    ("rect", "[", "]"),
    ("rounded", "(", ")"),
    ("stadium", "([", "])"),
    ("subroutine", "[[", "]]"),
    ("cylinder", "[(", ")]"),
    ("circle", "((", "))"),
    ("doublecircle", "(((", ")))"),
    ("diamond", "{", "}"),
    ("hexagon", "{{", "}}"),
    ("parallelogram", "[/", "/]"),
    ("parallelogramalt", "[\\", "\\]"),
];

// The ref whose shape Mermaid uses (the last one that has one).
fn shape_ref<'a>(doc: &'a Doc, id: &str) -> Option<&'a Ref> {
    let refs: Vec<&Ref> = doc.refs().filter(|r| r.id == id).collect();
    refs.iter().rev().find(|r| r.shape.is_some()).or(refs.first()).copied()
}

/// Current shape key of a node ("rect" when it has no brackets), or None
/// for an unknown node or an `@{ … }` shape.
pub fn node_shape(src: &str, id: &str) -> Option<&'static str> {
    let doc = parse_flow(src);
    let r = shape_ref(&doc, id)?;
    let Some(sh) = &r.shape else { return Some("rect") };
    let ShapeKind::Box(open) = sh.kind else { return None };
    let close = &src[sh.inner_end..sh.end];
    // Trapezoids draw as parallelograms; `>x]` draws as a rectangle.
    match open {
        "[/" => return Some("parallelogram"),
        "[\\" => return Some("parallelogramalt"),
        ">" => return Some("rect"),
        _ => {}
    }
    NODE_SHAPES.iter().find(|(_, o, c)| *o == open && *c == close).map(|(k, _, _)| *k)
}

/// Give nodes another shape, keeping their labels.
pub fn set_node_shape(src: &str, ids: &[String], key: &str) -> String {
    let (_, open, close) = NODE_SHAPES.iter().find(|(k, _, _)| *k == key).copied().unwrap_or(NODE_SHAPES[0]);
    let mut src = src.to_string();
    for id in ids {
        let doc = parse_flow(&src);
        let Some(r) = shape_ref(&doc, id) else { continue };
        let label = node_label(&src, id);
        let edit = match &r.shape {
            None => (r.id_end, r.id_end, format!("{open}{}{close}", format_label(&label))),
            Some(sh) => {
                let inner = &src[sh.inner_start..sh.inner_end];
                // Keep the text as typed when it is quoted or plain;
                // anything with brackets or slashes could close the new
                // shape early, so re-quote.
                let t = inner.trim();
                let quoted = t.len() >= 2 && t.starts_with('"') && t.ends_with('"');
                let plain = !inner.contains(['(', ')', '[', ']', '{', '}', '/', '\\', '<', '>', '"']);
                let inner = if sh.kind == ShapeKind::At || !(quoted || plain) {
                    format_label(&label)
                } else {
                    inner.to_string()
                };
                (sh.start, sh.end, format!("{open}{inner}{close}"))
            }
        };
        src = splice(&src, vec![edit]);
    }
    src
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "flowchart TD\n    A[Start] --> B[Read]\n    B -->|yes| C{OK?}\n    C & D --> E\n    X --> Y --> Z";

    #[test]
    fn edges_in_engine_order() {
        let e = edge_list("graph LR\nA & B --> C & D\nC --- E\nE -- hi there --> A");
        let e: Vec<String> = e.into_iter().map(|(a, b)| format!("{a}>{b}")).collect();
        assert_eq!(e, ["A>C", "A>D", "B>C", "B>D", "C>E", "E>A"]);
    }

    #[test]
    fn rename_keeps_shape() {
        assert!(rename_node(S, "C", "Is it (ok)?").contains("C{\"Is it (ok)?\"}"));
        assert!(rename_node(S, "E", "Echo").contains("C & D --> E[Echo]"));
    }

    #[test]
    fn delete_node_and_edge() {
        let out = delete_node(S, "B");
        assert!(!out.contains("B"), "{out}");
        let out = delete_edge(S, "C", "E", 0);
        // D is declared nowhere else, so the left half stays as `C & D`.
        assert!(out.contains("    C & D\n    D --> E"), "{out}");
    }

    #[test]
    fn ops_round_trip() {
        for raw in ["-->", "-->|yes|", "-.->", "==>", "---", "<-->", "--o", "x--x"] {
            let o = parse_op(raw);
            assert_eq!(parse_op(&build_op(&o)), o, "{raw}");
        }
        assert_eq!(parse_op("-- hi there -->").label.as_deref(), Some("hi there"));
    }

    #[test]
    fn shapes_and_groups() {
        assert_eq!(node_shape(S, "C"), Some("diamond"));
        let out = set_node_shape(S, &["A".into()], "circle");
        assert!(out.contains("A((Start))"));
        let g = group_nodes(S, &["A".into(), "B".into()], "G1", "In").unwrap();
        assert!(g.ends_with("    subgraph G1 [In]\n        A\n        B\n    end"), "{g}");
        assert_eq!(ungroup(&g, "G1"), S);
    }
}
