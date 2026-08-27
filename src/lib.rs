//! WASM bindings for the flowmaid diagram engine.
//!
//! The engine itself is pure std (no filesystem, threads, or
//! network), so these bindings are a thin string-in / string-out
//! shim — all diagram intelligence lives in the `flowmaid` crate.

use flowmaid::model::Document;
use wasm_bindgen::prelude::*;

fn parse(source: &str) -> Result<Document, JsError> {
    flowmaid::parser::parse_document(source).map_err(|e| JsError::new(&e.to_string()))
}

/// Render Mermaid-syntax text (flowchart / erDiagram / classDiagram /
/// sequenceDiagram / pie)
/// to an SVG string. Errors carry the 1-indexed line number, e.g.
/// `line 3: closing ']' not found`.
#[wasm_bindgen]
pub fn render_svg(source: &str) -> Result<String, JsError> {
    flowmaid::render_svg(source).map_err(|e| JsError::new(&e.to_string()))
}

/// Render an advance / swimlane diagram from JSON to an SVG string.
#[wasm_bindgen]
pub fn render_advance_svg(source: &str) -> Result<String, JsError> {
    render_advance_svg_impl(source).map_err(|e| JsError::new(&e))
}

fn render_advance_svg_impl(source: &str) -> Result<String, String> {
    flowmaid::render_advance_svg(source).map_err(|e| e.to_string())
}

/// Render an advance / swimlane diagram from JSON with caller-provided
/// node centre positions (flat `[x, y]` pairs in the same order as
/// [`layout_advance_json`]'s `nodes` array). Edges are re-routed and
/// lane boxes are recomputed around the dragged nodes.
#[wasm_bindgen]
pub fn render_advance_routed(source: &str, positions: &[f64]) -> Result<String, JsError> {
    render_advance_routed_impl(source, positions).map_err(|e| JsError::new(&e))
}

fn render_advance_routed_impl(source: &str, positions: &[f64]) -> Result<String, String> {
    flowmaid::render_advance_routed(source, positions).map_err(|e| e.to_string())
}

/// Render an advance / swimlane diagram from JSON with caller-provided
/// node centre positions and explicit lane widths (in the same order as
/// the `lanes` array). Margin and gap are also supplied by the host so
/// the lane background resizes with dragged column borders.
#[wasm_bindgen]
pub fn render_advance_routed_with_lanes(
    source: &str,
    positions: &[f64],
    lane_widths: &[f64],
    margin: f64,
    gap: f64,
) -> Result<String, JsError> {
    render_advance_routed_with_lanes_impl(source, positions, lane_widths, margin, gap)
        .map_err(|e| JsError::new(&e))
}

fn render_advance_routed_with_lanes_impl(
    source: &str,
    positions: &[f64],
    lane_widths: &[f64],
    margin: f64,
    gap: f64,
) -> Result<String, String> {
    flowmaid::render_advance_routed_with_lanes(source, positions, lane_widths, margin, gap)
        .map_err(|e| e.to_string())
}

/// Layout an advance / swimlane diagram from JSON and return its
/// geometry as a JSON string: width, height, lanes, nodes, and edges
/// with orthogonal routing points. Serialised by hand so no serde
/// dependency is added to the wasm bundle.
#[wasm_bindgen]
pub fn layout_advance_json(source: &str) -> Result<String, JsError> {
    layout_advance_json_impl(source).map_err(|e| JsError::new(&e))
}

fn layout_advance_json_impl(source: &str) -> Result<String, String> {
    let scene = flowmaid::layout_advance(source).map_err(|e| e.to_string())?;
    Ok(advance_scene_to_json(&scene))
}

fn shape_name(shape: flowmaid::model::Shape) -> &'static str {
    use flowmaid::model::Shape;
    match shape {
        Shape::Rect => "rect",
        Shape::Rounded => "rounded",
        Shape::Stadium => "stadium",
        Shape::Diamond => "diamond",
        Shape::Circle => "circle",
        Shape::DoubleCircle => "doublecircle",
        Shape::Cylinder => "cylinder",
        Shape::Subroutine => "subroutine",
        Shape::Hexagon => "hexagon",
        Shape::Parallelogram => "parallelogram",
        Shape::ParallelogramAlt => "parallelogramalt",
        Shape::StateStart => "statestart",
        Shape::StateEnd => "stateend",
        Shape::ForkBar => "forkbar",
    }
}

fn edge_kind_name(kind: flowmaid::model::EdgeKind) -> &'static str {
    use flowmaid::model::EdgeKind;
    match kind {
        EdgeKind::Arrow => "arrow",
        EdgeKind::Open => "open",
        EdgeKind::Dotted => "dotted",
        EdgeKind::DottedOpen => "dottedopen",
        EdgeKind::Thick => "thick",
        EdgeKind::ThickOpen => "thickopen",
        EdgeKind::Invisible => "invisible",
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn advance_scene_to_json(scene: &flowmaid::AdvanceScene) -> String {
    let mut s = String::new();
    s.push_str("{\"width\":");
    s.push_str(&format!("{:.1}", scene.width));
    s.push_str(",\"height\":");
    s.push_str(&format!("{:.1}", scene.height));

    s.push_str(",\"lanes\":[");
    for (i, lane) in scene.lanes.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"title\":{},\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}}",
            json_escape(&lane.id),
            json_escape(&lane.title),
            lane.x,
            lane.y,
            lane.w,
            lane.h
        ));
    }
    s.push(']');

    s.push_str(",\"nodes\":[");
    for (i, node) in scene.nodes.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"label\":{},\"lane\":{},\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"shape\":\"{}\"}}",
            json_escape(&node.id),
            json_escape(&node.label),
            json_escape(&node.lane),
            node.x,
            node.y,
            node.w,
            node.h,
            shape_name(node.shape)
        ));
    }
    s.push(']');

    s.push_str(",\"edges\":[");
    for (i, edge) in scene.edges.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"from\":{},\"to\":{},\"label\":{},\"kind\":\"{}\",\"points\":[",
            json_escape(&edge.from),
            json_escape(&edge.to),
            edge.label
                .as_deref()
                .map(json_escape)
                .unwrap_or_else(|| "null".to_string()),
            edge_kind_name(edge.kind)
        ));
        for (j, p) in edge.points.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            s.push_str(&format!("[{:.1},{:.1}]", p.0, p.1));
        }
        s.push_str("]}");
    }
    s.push(']');

    s.push('}');
    s
}

// ── Interactive API (drag & drop) ─────────────────────────────
//
// Mirrors the desktop app's split: the host owns positions and
// pointer input; the engine owns layout and edge geometry. All
// arrays are flat `[x0, y0, x1, y1, ...]` in node/entity order to
// avoid JSON churn on every pointer move.

/// Identity key per node (flowchart node id / ER entity name),
/// newline-joined, in the same order as every array below. Used to
/// preserve dragged positions across text edits.
#[wasm_bindgen]
pub fn node_keys(source: &str) -> Result<String, JsError> {
    Ok(match parse(source)? {
        // State diagrams share the flowchart Graph — same drag model.
        Document::Flowchart(g) | Document::State(g) => g
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Document::Er(d) => d
            .entities
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Document::Class(d) => d
            .classes
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        // Static diagrams have no draggable nodes.
        Document::Sequence(_)
        | Document::Pie(_)
        | Document::Mindmap(_)
        | Document::Journey(_)
        | Document::GitGraph(_)
        | Document::Architecture(_) => String::new(),
    })
}

/// Automatic-layout centres, flat `[x, y]` pairs.
#[wasm_bindgen]
pub fn auto_positions(source: &str) -> Result<Vec<f64>, JsError> {
    Ok(match parse(source)? {
        Document::Flowchart(g) | Document::State(g) => flowmaid::scene::scene(&g)
            .nodes
            .iter()
            .flat_map(|n| [n.x, n.y])
            .collect(),
        Document::Er(d) => flowmaid::er::scene(&d)
            .scene
            .nodes
            .iter()
            .flat_map(|n| [n.x, n.y])
            .collect(),
        Document::Class(d) => flowmaid::class::scene(&d)
            .scene
            .nodes
            .iter()
            .flat_map(|n| [n.x, n.y])
            .collect(),
        // Static diagrams have no draggable node positions.
        Document::Sequence(_)
        | Document::Pie(_)
        | Document::Mindmap(_)
        | Document::Journey(_)
        | Document::GitGraph(_)
        | Document::Architecture(_) => Vec::new(),
    })
}

/// Node box sizes, flat `[w, h]` pairs — position-independent, so
/// the host can hit-test drags with centres + these.
#[wasm_bindgen]
pub fn node_sizes(source: &str) -> Result<Vec<f64>, JsError> {
    Ok(match parse(source)? {
        Document::Flowchart(g) | Document::State(g) => flowmaid::scene::scene(&g)
            .nodes
            .iter()
            .flat_map(|n| [n.w, n.h])
            .collect(),
        Document::Er(d) => flowmaid::er::scene(&d)
            .scene
            .nodes
            .iter()
            .flat_map(|n| [n.w, n.h])
            .collect(),
        Document::Class(d) => flowmaid::class::scene(&d)
            .scene
            .nodes
            .iter()
            .flat_map(|n| [n.w, n.h])
            .collect(),
        Document::Sequence(_)
        | Document::Pie(_)
        | Document::Mindmap(_)
        | Document::Journey(_)
        | Document::GitGraph(_)
        | Document::Architecture(_) => Vec::new(),
    })
}

/// Render with caller-provided centres (flat `[x, y]` pairs, same
/// order as [`node_keys`]) — edges re-route around the dragged
/// positions without re-running layout, exactly like the desktop
/// app's drag path.
#[wasm_bindgen]
pub fn render_routed(source: &str, positions: &[f64]) -> Result<String, JsError> {
    routed_impl(source, positions).map_err(|e| JsError::new(&e))
}

/// Native-testable core of [`render_routed`] — `JsError` can only
/// be constructed on wasm targets, so validation lives here.
fn routed_impl(source: &str, positions: &[f64]) -> Result<String, String> {
    let doc = flowmaid::parser::parse_document(source).map_err(|e| e.to_string())?;
    let n = match &doc {
        Document::Flowchart(g) | Document::State(g) => g.nodes.len(),
        Document::Er(d) => d.entities.len(),
        Document::Class(d) => d.classes.len(),
        // Static diagrams: no positions expected, rendered as-is.
        Document::Sequence(_)
        | Document::Pie(_)
        | Document::Mindmap(_)
        | Document::Journey(_)
        | Document::GitGraph(_)
        | Document::Architecture(_) => 0,
    };
    if positions.len() != n * 2 {
        // A tailored message for static diagrams — "expected 0
        // coordinates for 0 nodes" read like the document was empty
        // (bug hunt).
        return Err(if matches!(
            doc,
            Document::Sequence(_)
                | Document::Pie(_)
                | Document::Mindmap(_)
                | Document::Journey(_)
        ) {
            format!(
                "this diagram type is static (not draggable): pass an \
                 empty positions array, got {} values",
                positions.len()
            )
        } else {
            format!(
                "expected {} coordinates for {} nodes, got {}",
                n * 2,
                n,
                positions.len()
            )
        });
    }
    // The wasm boundary is where untrusted JS input arrives —
    // NaN/infinite coordinates would silently poison the SVG
    // (found by a bughunter). Fail loudly instead.
    if let Some(i) = positions.iter().position(|v| !v.is_finite()) {
        return Err(format!("position[{}] is not a finite number", i));
    }
    let centers: Vec<(f64, f64)> = positions.chunks(2).map(|c| (c[0], c[1])).collect();
    Ok(match doc {
        Document::Flowchart(g) | Document::State(g) => {
            flowmaid::scene::to_svg(&flowmaid::scene::route(&g, &centers))
        }
        Document::Er(d) => flowmaid::er::to_svg(&flowmaid::er::route(&d, &centers)),
        Document::Class(d) => flowmaid::class::to_svg(&flowmaid::class::route(&d, &centers)),
        // Static diagrams ignore positions and render from layout.
        Document::Sequence(d) => flowmaid::seq::to_svg(&flowmaid::seq::scene(&d)),
        Document::Pie(d) => flowmaid::pie::to_svg(&flowmaid::pie::scene(&d)),
        Document::Mindmap(d) => flowmaid::mindmap::to_svg(&flowmaid::mindmap::scene(&d)),
        Document::Journey(d) => flowmaid::journey::to_svg(&flowmaid::journey::scene(&d)),
        Document::GitGraph(d) => flowmaid::gitgraph::to_svg(&flowmaid::gitgraph::scene(&d)),
        Document::Architecture(d) => {
            flowmaid::architecture::to_svg(&flowmaid::architecture::scene(&d))
        }
    })
}

/// flowmaid engine version baked into this bundle — derived from
/// Cargo.lock by build.rs, so it can never drift from the crate that
/// was actually compiled in (the old hand-maintained literal sat at
/// "0.4.0" through four engine releases).
#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("FLOWMAID_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn render_works_for_all_diagram_types() {
        assert!(flowmaid::render_svg("flowchart TD\nA-->B").is_ok());
        assert!(flowmaid::render_svg("erDiagram\nA ||--o{ B : has").is_ok());
        assert!(flowmaid::render_svg("classDiagram\nAnimal <|-- Dog").is_ok());
        assert!(flowmaid::render_svg("sequenceDiagram\nA->>B: hi").is_ok());
        assert!(flowmaid::render_svg("pie\n\"a\" : 1\n\"b\" : 2").is_ok());
        assert!(flowmaid::render_svg("gantt\nx").is_err());
        // Static diagrams render through routed_impl with no positions.
        assert!(super::routed_impl("pie\n\"a\" : 1", &[]).is_ok());
        assert!(super::routed_impl("sequenceDiagram\nA->>B: hi", &[]).is_ok());
    }

    #[test]
    fn routed_handles_class_diagrams() {
        // The wasm-bound getters (node_keys/auto_positions/node_sizes)
        // return JsError and aren't native-testable, but their new
        // Document::Class arms are guaranteed by compilation. Exercise
        // the runtime path through routed_impl (3 classes => 6 coords).
        let src = "classDiagram\nAnimal <|-- Dog\nAnimal <|-- Cat";
        assert!(super::routed_impl(src, &[0.0, 0.0, 100.0, 100.0, 200.0, 0.0]).is_ok());
        assert!(super::routed_impl(src, &[0.0, 0.0]).is_err(), "wrong length");
        assert!(super::routed_impl(src, &[f64::NAN; 6]).is_err(), "non-finite");
    }

    #[test]
    fn advance_svg_renders() {
        let src = r#"{"lanes":[{"id":"dev","title":"Dev"}],"nodes":[{"id":"a","label":"Start","lane":"dev"}]}"#;
        let svg = super::render_advance_svg_impl(src).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("Dev"));
        assert!(svg.contains("Start"));
    }

    #[test]
    fn advance_layout_json_has_expected_shape() {
        let src = r#"{
            "lanes":[{"id":"dev","title":"Development"},{"id":"qa","title":"QA"}],
            "nodes":[
                {"id":"a","label":"Design","lane":"dev"},
                {"id":"b","label":"Code","lane":"dev"},
                {"id":"c","label":"Test","lane":"qa"}
            ],
            "edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]
        }"#;
        let json = super::layout_advance_json_impl(src).unwrap();
        assert!(json.contains("\"width\""));
        assert!(json.contains("\"height\""));
        assert!(json.contains("\"lanes\""));
        assert!(json.contains("\"nodes\""));
        assert!(json.contains("\"edges\""));
        assert!(json.contains("\"points\""));
        // Centre coordinates are included.
        assert!(json.contains("\"x\":"));
        assert!(json.contains("\"y\":"));
    }

    #[test]
    fn advance_invalid_json_errors() {
        assert!(super::render_advance_svg_impl("not json").is_err());
        assert!(super::layout_advance_json_impl("not json").is_err());
    }

    #[test]
    fn advance_routed_renders_and_validates() {
        let src = r#"{
            "lanes":[{"id":"dev","title":"Dev"}],
            "nodes":[
                {"id":"a","label":"A","lane":"dev"},
                {"id":"b","label":"B","lane":"dev"}
            ],
            "edges":[{"from":"a","to":"b"}]
        }"#;
        let svg = super::render_advance_routed_impl(src, &[50.0, 50.0, 150.0, 50.0]).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("A"));
        assert!(svg.contains("B"));
        assert!(super::render_advance_routed_impl(src, &[50.0, 50.0]).is_err());
        assert!(super::render_advance_routed_impl(src, &[f64::NAN; 4]).is_err());
    }

    #[test]
    fn routed_rejects_non_finite_positions() {
        // Regression (bughunter): NaN from JS used to flow straight
        // into the SVG coordinates.
        assert!(super::routed_impl("A --> B", &[f64::NAN, 1.0, 2.0, 3.0]).is_err());
        assert!(super::routed_impl("A --> B", &[1.0, f64::INFINITY, 2.0, 3.0]).is_err());
        assert!(super::routed_impl("A --> B", &[1.0, 2.0, 3.0, 4.0]).is_ok());
    }
}
