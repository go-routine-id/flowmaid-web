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

Press **Edit** (or `V`) in the playground to edit flowcharts on the canvas:

- double-click empty canvas (or **+ Node**, `N`) — add a node, then type its label
- double-click a node (or `Enter` / `F2` on the selected one) — rename it in place
- drag the ● handle of the selected node (or Shift+drag a node) onto another node to connect them; drop on empty canvas to create a connected node
- click a node or an edge, then `Delete` — remove it (a node takes its edges and `style` / `class` / `click` lines with it)

Every action is a text edit on the Mermaid source (`flowedit.js`): only the statements it touches are rewritten, and Ctrl/⌘+Z in the code panel undoes canvas edits too. Tests: `node tests/flowedit.test.mjs`.

## Building

```bash
wasm-pack build --target web --release   # emits pkg/
python3 -m http.server                   # then open http://localhost:8000
```

`pkg/` is committed on purpose so GitHub Pages can serve the playground without a build pipeline.

## License

GPL-3.0-or-later — same as the flowmaid engine. Full text in `LICENSE`.
