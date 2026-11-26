//! Structured edits on a flowchart source — the ones the playground's
//! canvas makes. Each op is checked against the current ids first so an
//! agent gets a clear error instead of a silently broken diagram, and a
//! batch is all-or-nothing.

use crate::engine::{node_ids, parse_error};
use flowmaid_web::edit::{self, EdgeOp};
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    Rect,
    Rounded,
    Stadium,
    Subroutine,
    Cylinder,
    Circle,
    Doublecircle,
    Diamond,
    Hexagon,
    Parallelogram,
    Parallelogramalt,
}

impl Shape {
    fn key(self) -> &'static str {
        match self {
            Shape::Rect => "rect",
            Shape::Rounded => "rounded",
            Shape::Stadium => "stadium",
            Shape::Subroutine => "subroutine",
            Shape::Cylinder => "cylinder",
            Shape::Circle => "circle",
            Shape::Doublecircle => "doublecircle",
            Shape::Diamond => "diamond",
            Shape::Hexagon => "hexagon",
            Shape::Parallelogram => "parallelogram",
            Shape::Parallelogramalt => "parallelogramalt",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Solid,
    Dotted,
    Thick,
}

impl Style {
    fn key(self) -> &'static str {
        match self {
            Style::Solid => "solid",
            Style::Dotted => "dotted",
            Style::Thick => "thick",
        }
    }
}

/// The playground's palette (fill, stroke).
#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Blue,
    Green,
    Yellow,
    Orange,
    Red,
    Pink,
    Purple,
    Teal,
    Grey,
    Default,
}

impl Color {
    fn fill_stroke(self) -> Option<(&'static str, &'static str)> {
        Some(match self {
            Color::Blue => ("#e7f0ff", "#3b6fd8"),
            Color::Green => ("#e5f5ea", "#2f9e44"),
            Color::Yellow => ("#fff3bf", "#f08c00"),
            Color::Orange => ("#ffe8cc", "#e8590c"),
            Color::Red => ("#ffe3e3", "#e03131"),
            Color::Pink => ("#ffdeeb", "#d6336c"),
            Color::Purple => ("#f3e8ff", "#8839ef"),
            Color::Teal => ("#e3fafc", "#1098ad"),
            Color::Grey => ("#f1f3f5", "#868e96"),
            Color::Default => return None,
        })
    }
}

/// One edit. Ids come from get_diagram.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Add a node; optionally connect from an existing one.
    AddNode {
        label: String,
        /// Defaults to a fresh N1, N2, …
        id: Option<String>,
        shape: Option<Shape>,
        /// Connect from this node to the new one.
        from: Option<String>,
        edge_label: Option<String>,
        edge_style: Option<Style>,
    },
    RenameNode { id: String, label: String },
    /// Also removes its edges and its style / class / click lines.
    DeleteNode { id: String },
    Connect {
        from: String,
        to: String,
        label: Option<String>,
        style: Option<Style>,
        /// false for a line without arrowhead.
        arrow: Option<bool>,
    },
    UpdateEdge {
        from: String,
        to: String,
        /// Which of several from→to edges, 0-based.
        nth: Option<usize>,
        /// "" removes the label.
        label: Option<String>,
        style: Option<Style>,
        reverse: Option<bool>,
    },
    DeleteEdge { from: String, to: String, nth: Option<usize> },
    SetShape { ids: Vec<String>, shape: Shape },
    SetColor {
        ids: Vec<String>,
        color: Option<Color>,
        /// #hex fill, overrides the named colour.
        fill: Option<String>,
        /// #hex stroke, overrides the named colour.
        stroke: Option<String>,
    },
    /// Wrap nodes in a subgraph (nested when they already share one).
    Group {
        ids: Vec<String>,
        title: String,
        /// Subgraph id, defaults to G1, G2, …
        id: Option<String>,
    },
    Ungroup { group: String },
}

impl Op {
    fn name(&self) -> &'static str {
        match self {
            Op::AddNode { .. } => "add_node",
            Op::RenameNode { .. } => "rename_node",
            Op::DeleteNode { .. } => "delete_node",
            Op::Connect { .. } => "connect",
            Op::UpdateEdge { .. } => "update_edge",
            Op::DeleteEdge { .. } => "delete_edge",
            Op::SetShape { .. } => "set_shape",
            Op::SetColor { .. } => "set_color",
            Op::Group { .. } => "group",
            Op::Ungroup { .. } => "ungroup",
        }
    }
}

/// Letters, digits or _, and not a word that starts other lines (`end`,
/// `style`, …): a node with such an id can't be edited here.
fn check_id(id: &str, what: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(format!("{what} \"{id}\" must be letters, digits or _"));
    }
    if edit::is_keyword(id) {
        return Err(format!("{what} \"{id}\" is a Mermaid keyword; pick another"));
    }
    Ok(())
}

/// #rgb, #rgba, #rrggbb or #rrggbbaa.
fn valid_hex(c: &str) -> bool {
    let h = c.strip_prefix('#').unwrap_or("");
    matches!(h.len(), 3 | 4 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())
}

fn op_text(style: Option<Style>, label: Option<&str>, arrow: bool) -> String {
    edit::build_op(&EdgeOp {
        start: String::new(),
        kind: style.unwrap_or(Style::Solid).key().into(),
        end: if arrow { ">".into() } else { String::new() },
        label: label.map(String::from),
    })
}

/// Apply ops in order; returns (new source, ids created). Errors name the op.
pub fn apply_ops(source: &str, ops: &[Op]) -> Result<(String, Vec<String>), String> {
    if !edit::is_flowchart(source) {
        return Err("edit_diagram works on flowchart / graph diagrams; use set_diagram to change other diagram types.".into());
    }
    if let Some(e) = parse_error(source) {
        return Err(format!("The current source does not parse, fix it with set_diagram first: {e}"));
    }
    let mut src = source.to_string();
    let mut created = Vec::new();
    for (i, o) in ops.iter().enumerate() {
        src = apply_one(&src, o, &mut created).map_err(|e| format!("op {} ({}): {e}", i + 1, o.name()))?;
    }
    if let Some(e) = parse_error(&src) {
        return Err(format!("the edits produced a source that does not parse ({e}); nothing was changed"));
    }
    Ok((src, created))
}

fn apply_one(src: &str, o: &Op, created: &mut Vec<String>) -> Result<String, String> {
    let ids = node_ids(src);
    let has = |id: &str| -> Result<(), String> {
        if ids.iter().any(|x| x == id) {
            if edit::is_keyword(id) {
                // The engine draws it, but its lines aren't statements to
                // the editor: every op would silently do nothing.
                return Err(format!(
                    "node \"{id}\" has a Mermaid keyword as its id and can't be edited by ops; rename it in the source with set_diagram"
                ));
            }
            Ok(())
        } else {
            Err(format!("no node with id \"{id}\" (ids: {})", if ids.is_empty() { "none".into() } else { ids.join(", ") }))
        }
    };
    let edge_exists = |from: &str, to: &str, nth: usize| -> Result<(), String> {
        match edit::edge_op(src, from, to, nth) {
            Some(_) => Ok(()),
            None => Err(format!("no edge {from} → {to}{}", if nth > 0 { format!(" #{nth}") } else { String::new() })),
        }
    };
    Ok(match o {
        Op::AddNode { label, id, shape, from, edge_label, edge_style } => {
            let id = id.clone().unwrap_or_else(|| edit::fresh_id(src, &ids, "N"));
            check_id(&id, "id")?;
            if ids.contains(&id) {
                return Err(format!("id \"{id}\" is already used"));
            }
            let mut s = edit::add_node(src, &id, label);
            if let Some(sh) = shape.filter(|s| *s != Shape::Rect) {
                s = edit::set_node_shape(&s, std::slice::from_ref(&id), sh.key());
            }
            if let Some(f) = from {
                has(f)?;
                s = edit::add_edge(&s, f, &id, &op_text(*edge_style, edge_label.as_deref(), true));
            }
            created.push(id);
            s
        }
        Op::RenameNode { id, label } => {
            has(id)?;
            edit::rename_node(src, id, label)
        }
        Op::DeleteNode { id } => {
            has(id)?;
            edit::delete_node(src, id)
        }
        Op::Connect { from, to, label, style, arrow } => {
            has(from)?;
            has(to)?;
            edit::add_edge(src, from, to, &op_text(*style, label.as_deref(), arrow.unwrap_or(true)))
        }
        Op::UpdateEdge { from, to, nth, label, style, reverse } => {
            let nth = nth.unwrap_or(0);
            edge_exists(from, to, nth)?;
            let mut s = src.to_string();
            if let Some(l) = label {
                s = edit::set_edge_label(&s, from, to, nth, l);
            }
            if let Some(st) = style {
                s = edit::set_edge_kind(&s, from, to, nth, st.key());
            }
            if reverse.unwrap_or(false) {
                s = edit::reverse_edge(&s, from, to, nth);
            }
            s
        }
        Op::DeleteEdge { from, to, nth } => {
            edge_exists(from, to, nth.unwrap_or(0))?;
            edit::delete_edge(src, from, to, nth.unwrap_or(0))
        }
        Op::SetShape { ids: list, shape } => {
            list.iter().try_for_each(|i| has(i))?;
            edit::set_node_shape(src, list, shape.key())
        }
        Op::SetColor { ids: list, color, fill, stroke } => {
            list.iter().try_for_each(|i| has(i))?;
            let named = color.and_then(Color::fill_stroke);
            // "default" resets first; a fill / stroke given with it then
            // applies on top of the reset, not of the old colours.
            let reset = matches!(color, Some(Color::Default));
            let base = if reset { edit::set_node_style(src, list, None) } else { src.to_string() };
            if named.is_none() && fill.is_none() && stroke.is_none() {
                if reset {
                    return Ok(base);
                }
                return Err("give a color name, or fill / stroke".into());
            }
            let f = fill.clone().or(named.map(|n| n.0.to_string()));
            let s = stroke.clone().or(named.map(|n| n.1.to_string()));
            for c in [&f, &s].into_iter().flatten() {
                if !valid_hex(c) {
                    return Err(format!("\"{c}\" is not a #hex colour"));
                }
            }
            let mut props = Vec::new();
            if let Some(f) = f {
                props.push(("fill".to_string(), Some(f)));
            }
            if let Some(s) = s {
                props.push(("stroke".to_string(), Some(s)));
            }
            edit::set_node_style(&base, list, Some(&props))
        }
        Op::Group { ids: list, title, id } => {
            list.iter().try_for_each(|i| has(i))?;
            let (blocks, _) = edit::subgraphs(src);
            let gid = id.clone().unwrap_or_else(|| edit::fresh_id(src, &ids, "G"));
            check_id(&gid, "group id")?;
            if blocks.iter().any(|b| b.id == gid) || ids.contains(&gid) {
                return Err(format!("id \"{gid}\" is already used"));
            }
            let s = edit::group_nodes(src, list, &gid, title)?;
            created.push(gid);
            s
        }
        Op::Ungroup { group } => {
            let (blocks, _) = edit::subgraphs(src);
            if !blocks.iter().any(|b| &b.id == group) {
                return Err(format!("no group \"{group}\""));
            }
            edit::ungroup(src, group)
        }
    })
}
