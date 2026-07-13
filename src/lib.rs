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
        // Pie / sequence are static (no draggable nodes).
        Document::Sequence(_) | Document::Pie(_) => String::new(),
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
        // Pie / sequence have no draggable node positions.
        Document::Sequence(_) | Document::Pie(_) => Vec::new(),
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
        Document::Sequence(_) | Document::Pie(_) => Vec::new(),
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
        Document::Sequence(_) | Document::Pie(_) => 0,
    };
    if positions.len() != n * 2 {
        // A tailored message for static diagrams — "expected 0
        // coordinates for 0 nodes" read like the document was empty
        // (bug hunt).
        return Err(if matches!(doc, Document::Sequence(_) | Document::Pie(_)) {
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
    })
}

/// Render a whole Markdown document to an HTML fragment: prose
/// becomes HTML, every ```mermaid block an inline SVG, and a bad
/// block a line-numbered error box instead of a broken page.
#[wasm_bindgen]
pub fn render_markdown_html(source: &str) -> String {
    flowmaid::md::render_html(source)
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
    fn routed_rejects_non_finite_positions() {
        // Regression (bughunter): NaN from JS used to flow straight
        // into the SVG coordinates.
        assert!(super::routed_impl("A --> B", &[f64::NAN, 1.0, 2.0, 3.0]).is_err());
        assert!(super::routed_impl("A --> B", &[1.0, f64::INFINITY, 2.0, 3.0]).is_err());
        assert!(super::routed_impl("A --> B", &[1.0, 2.0, 3.0, 4.0]).is_ok());
    }
}
