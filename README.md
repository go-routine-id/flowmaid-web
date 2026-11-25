# flowmaid-web

[![CI](https://github.com/go-routine-id/flowmaid-web/actions/workflows/ci.yml/badge.svg)](https://github.com/go-routine-id/flowmaid-web/actions/workflows/ci.yml)
The [flowmaid](https://crates.io/crates/flowmaid) diagram engine compiled to WebAssembly, plus a zero-dependency web playground — Mermaid-like diagrams rendered entirely in your browser by pure Rust. The whole engine is a ~538 KB (gzipped; ~1.4 MB raw) wasm bundle.

**Live playground:** https://opensource.go-routine.com/flowmaid/
**Documentation:** https://opensource.go-routine.com/flowmaid/docs/

## Using the bindings

```js
import init, { render_svg } from "./pkg/flowmaid_web.js";
await init();
document.body.innerHTML = render_svg("flowchart TD\nA([Start]) --> B{OK?}");
```

`render_svg` accepts `flowchart`/`graph` and `erDiagram` sources (including `style` / `classDef` / `:::` custom colors) and throws with a line-numbered message on parse errors. `render_svg_transparent` renders the same SVG without the white canvas, so it sits on the host page's background (text and edge colours stay dark).

## Visual editing

Flowcharts can be edited straight on the canvas; every action is written back into the Mermaid source.

- **Hover a node** (tap it on a touch screen) for a toolbar: **+** adds the next node along the flow, already connected, in the nearest free spot (drag **+** onto another node to connect them instead), **✎** edits the label, **◩** changes its shape (rectangle, rounded, stadium, subroutine, database, circle, double circle, decision, hexagon, input/output), **🎨** sets its colour (a `style` line), **🗑** deletes it with its edges.
- **Click an edge** (or its label) for its toolbar: edit the label, switch solid / dotted / thick, reverse it, delete it. Double-click an edge to edit its label.
- **Keyboard**, with a node selected: `Tab` adds a child, `Enter` a sibling, `F2` renames, arrow keys move between nodes, `Delete` removes, `Esc` clears the selection.
- **Several nodes**: Shift+click or Ctrl/⌘+click to select more, then **Group** (or Ctrl/⌘+G) wraps them in a `subgraph` and asks for its title; **Ungroup**, shape, colour and delete work on the whole selection.
- Double-click empty canvas for a new node; drag the ● handle of a selected node (or Shift+drag a node) to connect.

The ⛶ button on the zoom bar (or Shift+F) shows the canvas alone, fullscreen where the browser allows it; Esc leaves.

The **Edit** button (`V`) turns these canvas gestures off and on; it is on by default. Only the statements an action touches are rewritten (`flowedit.js`), and Ctrl/⌘+Z in the code panel undoes canvas edits too. Tests: `node tests/flowedit.test.mjs`.

## MCP server (AI agents + live view)

[`mcp/`](mcp/) is a Rust MCP server that gives an AI agent tools to read, edit and render diagrams with this engine, and serves this playground locally as a live view that stays in sync both ways with what the agent sees. The edit logic both share lives in [`src/edit.rs`](src/edit.rs) (wasm for the page, native for the server). Setup and tools: [mcp/README.md](mcp/README.md).

```bash
cargo install --locked --git https://github.com/go-routine-id/flowmaid-web flowmaid-mcp
claude mcp add flowmaid -- flowmaid-mcp
```

## Building

```bash
scripts/build-wasm.sh                    # emits pkg/ (cargo + wasm-bindgen + wasm-opt; wasm-pack works too)
python3 -m http.server                   # then open http://localhost:8000
```

`pkg/` is committed on purpose so GitHub Pages can serve the playground without a build pipeline.

## License

GPL-3.0-or-later — same as the flowmaid engine. Full text in `LICENSE`.
