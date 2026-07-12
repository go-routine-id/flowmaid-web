//! WASM bindings for the flowmaid diagram engine.
//!
//! The engine itself is pure std (no filesystem, threads, or
//! network), so these bindings are a thin string-in / string-out
//! shim — all diagram intelligence lives in the `flowmaid` crate.

use wasm_bindgen::prelude::*;

/// Render Mermaid-syntax text (flowchart / erDiagram) to an SVG
/// string. Errors carry the 1-indexed line number, e.g.
/// `line 3: closing ']' not found`.
#[wasm_bindgen]
pub fn render_svg(source: &str) -> Result<String, JsError> {
    flowmaid::render_svg(source).map_err(|e| JsError::new(&e.to_string()))
}

/// flowmaid engine version baked into this bundle.
#[wasm_bindgen]
pub fn engine_version() -> String {
    // Kept in sync by Cargo's resolver; there is no runtime query
    // for a dependency's version, so we track it manually against
    // Cargo.toml.
    "0.4.0".to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn render_works_for_both_diagram_types() {
        assert!(flowmaid::render_svg("flowchart TD\nA-->B").is_ok());
        assert!(flowmaid::render_svg("erDiagram\nA ||--o{ B : has").is_ok());
        assert!(flowmaid::render_svg("gantt\nx").is_err());
    }
}
