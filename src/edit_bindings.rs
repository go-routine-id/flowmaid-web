//! wasm-bindgen exports of [`crate::edit`] for the playground. Lists and
//! records cross as JSON (hand-written: no serde in the wasm bundle);
//! `flowedit.js` turns them back into the JS shapes the page uses.

use crate::edit;
use wasm_bindgen::prelude::*;

fn ids(joined: &str) -> Vec<String> {
    joined.split('\n').filter(|s| !s.is_empty()).map(String::from).collect()
}

fn q(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn opt(s: &Option<String>) -> String {
    s.as_deref().map_or("null".into(), q)
}

fn op_json(o: &edit::EdgeOp) -> String {
    format!(r#"{{"start":{},"kind":{},"end":{},"label":{}}}"#, q(&o.start), q(&o.kind), q(&o.end), opt(&o.label))
}

#[wasm_bindgen]
pub fn fe_is_flowchart(src: &str) -> bool {
    edit::is_flowchart(src)
}

#[wasm_bindgen]
pub fn fe_edge_list(src: &str) -> String {
    let items: Vec<String> = edit::edge_list(src).iter().map(|(a, b)| format!("[{},{}]", q(a), q(b))).collect();
    format!("[{}]", items.join(","))
}

#[wasm_bindgen]
pub fn fe_node_label(src: &str, id: &str) -> String {
    edit::node_label(src, id)
}

#[wasm_bindgen]
pub fn fe_format_label(label: &str) -> String {
    edit::format_label(label)
}

#[wasm_bindgen]
pub fn fe_rename_node(src: &str, id: &str, label: &str) -> String {
    edit::rename_node(src, id, label)
}

#[wasm_bindgen]
pub fn fe_fresh_id(src: &str, taken: &str, prefix: &str) -> String {
    edit::fresh_id(src, &ids(taken), prefix)
}

#[wasm_bindgen]
pub fn fe_add_node(src: &str, id: &str, label: &str) -> String {
    edit::add_node(src, id, label)
}

#[wasm_bindgen]
pub fn fe_add_edge(src: &str, from: &str, to: &str, op: &str) -> String {
    edit::add_edge(src, from, to, op)
}

#[wasm_bindgen]
pub fn fe_delete_node(src: &str, id: &str) -> String {
    edit::delete_node(src, id)
}

#[wasm_bindgen]
pub fn fe_delete_edge(src: &str, from: &str, to: &str, nth: u32) -> String {
    edit::delete_edge(src, from, to, nth as usize)
}

#[wasm_bindgen]
pub fn fe_parse_op(raw: &str) -> String {
    op_json(&edit::parse_op(raw))
}

#[wasm_bindgen]
pub fn fe_build_op(start: &str, kind: &str, end: &str, label: Option<String>) -> String {
    edit::build_op(&edit::EdgeOp { start: start.into(), kind: kind.into(), end: end.into(), label })
}

#[wasm_bindgen]
pub fn fe_edge_op(src: &str, from: &str, to: &str, nth: u32) -> Option<String> {
    edit::edge_op(src, from, to, nth as usize).map(|o| op_json(&o))
}

#[wasm_bindgen]
pub fn fe_set_edge_label(src: &str, from: &str, to: &str, nth: u32, label: &str) -> String {
    edit::set_edge_label(src, from, to, nth as usize, label)
}

#[wasm_bindgen]
pub fn fe_set_edge_kind(src: &str, from: &str, to: &str, nth: u32, kind: &str) -> String {
    edit::set_edge_kind(src, from, to, nth as usize, kind)
}

#[wasm_bindgen]
pub fn fe_reverse_edge(src: &str, from: &str, to: &str, nth: u32) -> String {
    edit::reverse_edge(src, from, to, nth as usize)
}

/// `props`: entries `key\x1fvalue` joined by `\x1e`; a value of `\0`
/// removes the key. `clear` (props ignored) removes fill/stroke/color.
#[wasm_bindgen]
pub fn fe_set_node_style(src: &str, ids_joined: &str, props: &str, clear: bool) -> String {
    let parsed: Vec<(String, Option<String>)> = props
        .split('\x1e')
        .filter(|e| !e.is_empty())
        .filter_map(|e| e.split_once('\x1f'))
        .map(|(k, v)| (k.to_string(), (v != "\0").then(|| v.to_string())))
        .collect();
    edit::set_node_style(src, &ids(ids_joined), if clear { None } else { Some(&parsed) })
}

#[wasm_bindgen]
pub fn fe_node_fill(src: &str, id: &str) -> Option<String> {
    edit::node_fill(src, id)
}

#[wasm_bindgen]
pub fn fe_subgraphs(src: &str) -> String {
    let (blocks, member) = edit::subgraphs(src);
    let b: Vec<String> = blocks
        .iter()
        .map(|b| {
            format!(
                r#"{{"id":{},"title":{},"line":{},"endLine":{},"depth":{},"parent":{}}}"#,
                q(&b.id),
                q(&b.title),
                b.line,
                b.end_line.map_or(-1, |e| e as i64),
                b.depth,
                opt(&b.parent)
            )
        })
        .collect();
    let m: Vec<String> = member.iter().map(|(n, g)| format!("[{},{}]", q(n), q(g))).collect();
    format!(r#"{{"blocks":[{}],"member":[{}]}}"#, b.join(","), m.join(","))
}

#[wasm_bindgen]
pub fn fe_group_nodes(src: &str, ids_joined: &str, gid: &str, title: &str) -> Result<String, JsError> {
    edit::group_nodes(src, &ids(ids_joined), gid, title).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn fe_rename_group(src: &str, gid: &str, title: &str) -> String {
    edit::rename_group(src, gid, title)
}

#[wasm_bindgen]
pub fn fe_ungroup(src: &str, gid: &str) -> String {
    edit::ungroup(src, gid)
}

#[wasm_bindgen]
pub fn fe_node_shapes() -> String {
    let items: Vec<String> =
        edit::NODE_SHAPES.iter().map(|(k, o, c)| format!("{}:[{},{}]", q(k), q(o), q(c))).collect();
    format!("{{{}}}", items.join(","))
}

#[wasm_bindgen]
pub fn fe_node_shape(src: &str, id: &str) -> Option<String> {
    edit::node_shape(src, id).map(String::from)
}

#[wasm_bindgen]
pub fn fe_set_node_shape(src: &str, ids_joined: &str, key: &str) -> String {
    edit::set_node_shape(src, &ids(ids_joined), key)
}

/// `[[id, x, y], …]`
#[wasm_bindgen]
pub fn fe_read_positions(src: &str) -> String {
    let items: Vec<String> = edit::read_positions(src).iter().map(|(id, x, y)| format!("[{},{x},{y}]", q(id))).collect();
    format!("[{}]", items.join(","))
}

/// `pos`: entries `id\x1fx\x1fy` joined by `\x1e`.
#[wasm_bindgen]
pub fn fe_write_positions(src: &str, pos: &str) -> String {
    let parsed: Vec<(String, f64, f64)> = pos
        .split('\x1e')
        .filter_map(|e| {
            let mut it = e.split('\x1f');
            let (id, x, y) = (it.next()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
            Some((id.to_string(), x, y))
        })
        .collect();
    edit::write_positions(src, &parsed)
}

#[wasm_bindgen]
pub fn fe_extract_nodes(src: &str, ids_joined: &str) -> String {
    edit::extract_nodes(src, &ids(ids_joined))
}

/// `{"src": …, "map": [[snippet id, new id], …]}`
#[wasm_bindgen]
pub fn fe_paste_nodes(src: &str, snippet: &str) -> String {
    let (out, map) = edit::paste_nodes(src, snippet);
    let m: Vec<String> = map.iter().map(|(a, b)| format!("[{},{}]", q(a), q(b))).collect();
    format!(r#"{{"src":{},"map":[{}]}}"#, q(&out), m.join(","))
}
