//! The flowmaid engine and the shared edit module, natively: render,
//! check, and describe a source so an agent knows the ids to edit.

use flowmaid_web::edit;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

fn is_advance(src: &str) -> bool {
    src.trim_start().starts_with('{')
}

fn is_swimlane(src: &str) -> bool {
    src.trim_start().starts_with("swimlane")
}

/// Render to SVG; errors carry the engine's line-numbered message.
pub fn render_svg(src: &str) -> Result<String, String> {
    if is_advance(src) {
        flowmaid::render_advance_svg(src).map_err(|e| e.to_string())
    } else if is_swimlane(src) {
        flowmaid::render_advance_text_svg(src).map_err(|e| e.to_string())
    } else {
        flowmaid::render_svg(src).map_err(|e| e.to_string())
    }
}

/// None when the source parses, else the engine's error message.
pub fn parse_error(src: &str) -> Option<String> {
    render_svg(src).err()
}

/// Node ids in engine order (empty for diagrams without keyed nodes).
pub fn node_ids(src: &str) -> Vec<String> {
    flowmaid_web::node_keys_impl(src)
        .map(|k| k.split('\n').filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// The diagram type from the first meaningful line ("flowchart", "erDiagram", …).
pub fn diagram_type(src: &str) -> String {
    if is_advance(src) {
        return "swimlane-json".into();
    }
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
        let w = t.split(|c: char| c.is_whitespace() || c == ';').next().unwrap_or("");
        return if w == "graph" { "flowchart".into() } else { w.into() };
    }
    "empty".into()
}

/// Facts an agent needs to edit: nodes, edges and groups with their ids.
pub fn describe(src: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("type".into(), json!(diagram_type(src)));
    if let Some(e) = parse_error(src) {
        out.insert("valid".into(), json!(false));
        out.insert("error".into(), json!(e));
        return out;
    }
    out.insert("valid".into(), json!(true));
    let ids = node_ids(src);
    if !edit::is_flowchart(src) {
        out.insert("editable".into(), json!(false));
        out.insert("nodes".into(), json!(ids.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>()));
        return out;
    }
    let (blocks, member) = edit::subgraphs(src);
    let nodes: Vec<Value> = ids
        .iter()
        .map(|id| {
            let mut n = Map::new();
            n.insert("id".into(), json!(id));
            n.insert("label".into(), json!(edit::node_label(src, id)));
            n.insert("shape".into(), json!(edit::node_shape(src, id).unwrap_or("custom")));
            if let Some(f) = edit::node_fill(src, id) {
                n.insert("fill".into(), json!(f));
            }
            if let Some((_, g)) = member.iter().find(|(m, _)| m == id) {
                n.insert("group".into(), json!(g));
            }
            Value::Object(n)
        })
        .collect();
    let mut seen: Vec<((String, String), usize)> = Vec::new();
    let edges: Vec<Value> = edit::edge_list(src)
        .into_iter()
        .map(|(from, to)| {
            let nth = match seen.iter_mut().find(|(k, _)| k.0 == from && k.1 == to) {
                Some((_, c)) => {
                    *c += 1;
                    *c - 1
                }
                None => {
                    seen.push(((from.clone(), to.clone()), 1));
                    0
                }
            };
            let op = edit::edge_op(src, &from, &to, nth);
            let mut e = Map::new();
            e.insert("from".into(), json!(from));
            e.insert("to".into(), json!(to));
            if nth > 0 {
                e.insert("nth".into(), json!(nth));
            }
            if let Some(l) = op.as_ref().and_then(|o| o.label.clone()).filter(|l| !l.is_empty()) {
                e.insert("label".into(), json!(l));
            }
            e.insert("style".into(), json!(op.as_ref().map_or("solid", |o| o.kind.as_str())));
            if op.as_ref().is_some_and(|o| o.end.is_empty()) {
                e.insert("arrow".into(), json!(false));
            }
            Value::Object(e)
        })
        .collect();
    let groups: Vec<Value> = blocks
        .iter()
        .map(|b| {
            let mut g = Map::new();
            g.insert("id".into(), json!(b.id));
            g.insert("title".into(), json!(b.title));
            if let Some(p) = &b.parent {
                g.insert("parent".into(), json!(p));
            }
            Value::Object(g)
        })
        .collect();
    out.insert("editable".into(), json!(true));
    out.insert("nodes".into(), json!(nodes));
    out.insert("edges".into(), json!(edges));
    out.insert("groups".into(), json!(groups));
    out
}

fn fonts() -> std::sync::Arc<resvg::usvg::fontdb::Database> {
    static DB: OnceLock<std::sync::Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        std::sync::Arc::new(db)
    })
    .clone()
}

/// Rasterise an SVG to PNG at `scale`, on white.
pub fn render_png(svg: &str, scale: f32) -> Result<Vec<u8>, String> {
    let opt = resvg::usvg::Options { font_family: "Arial".into(), fontdb: fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| e.to_string())?;
    let size = tree.size().to_int_size().scale_by(scale).ok_or("bad size")?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height()).ok_or("image too large")?;
    pixmap.fill(resvg::tiny_skia::Color::WHITE);
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|e| e.to_string())
}
