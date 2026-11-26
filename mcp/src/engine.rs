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
    } else if let Some(svg) = render_with_layout(src) {
        Ok(svg)
    } else {
        flowmaid::render_svg(src).map_err(|e| e.to_string())
    }
}

/// A diagram with a layout saved in the browser (`%% flowmaid:pos`
/// lines) renders as the user arranged it; nodes without a saved spot
/// keep their automatic one.
fn render_with_layout(src: &str) -> Option<String> {
    if !src.contains("%% flowmaid:pos") {
        return None;
    }
    let saved = edit::read_positions(src);
    let keys = node_ids(src);
    let auto = flowmaid_web::auto_positions_impl(src).ok()?;
    if keys.is_empty() || auto.len() != keys.len() * 2 {
        return None;
    }
    let mut pos = Vec::with_capacity(auto.len());
    for (i, k) in keys.iter().enumerate() {
        match saved.iter().rev().find(|(id, _, _)| id == k) {
            Some((_, x, y)) => pos.extend([*x, *y]),
            None => pos.extend([auto[i * 2], auto[i * 2 + 1]]),
        }
    }
    flowmaid_web::routed_impl(src, &pos).ok()
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
    // One parse for all nodes and one for all edges (per-node calls would
    // re-parse the whole source each time: quadratic on big diagrams).
    let (blocks, _) = edit::subgraphs(src);
    let nodes: Vec<Value> = ids
        .iter()
        .zip(edit::node_infos(src, &ids))
        .map(|(id, info)| {
            let mut n = Map::new();
            n.insert("id".into(), json!(id));
            n.insert("label".into(), json!(info.label));
            n.insert("shape".into(), json!(info.shape.unwrap_or("custom")));
            if let Some(f) = info.fill {
                n.insert("fill".into(), json!(f));
            }
            if let Some(g) = info.group {
                n.insert("group".into(), json!(g));
            }
            Value::Object(n)
        })
        .collect();
    let edges: Vec<Value> = edit::edge_infos(src)
        .into_iter()
        .map(|(from, to, nth, op)| {
            let mut e = Map::new();
            e.insert("from".into(), json!(from));
            e.insert("to".into(), json!(to));
            if nth > 0 {
                e.insert("nth".into(), json!(nth));
            }
            if let Some(l) = op.label.filter(|l| !l.is_empty()) {
                e.insert("label".into(), json!(l));
            }
            e.insert("style".into(), json!(op.kind));
            if op.end.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_saved_layout() {
        let src = "flowchart TD\n    A --> B\n";
        let auto = render_svg(src).unwrap();
        let moved = render_svg(&format!("{src}    %% flowmaid:pos B=900,700\n")).unwrap();
        assert_ne!(auto, moved);
        // Same as the playground: the routed renderer with those centres.
        let a = flowmaid_web::auto_positions_impl(src).unwrap();
        let want = flowmaid_web::routed_impl(&format!("{src}    %% flowmaid:pos B=900,700\n"), &[a[0], a[1], 900.0, 700.0]).unwrap();
        assert_eq!(moved, want);
        // Unknown ids in the layout are ignored.
        assert!(render_svg(&format!("{src}    %% flowmaid:pos Z=1,2\n")).is_ok());
    }
}
