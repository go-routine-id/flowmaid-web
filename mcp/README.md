# flowmaid-mcp

An [MCP](https://modelcontextprotocol.io) server, written in Rust, that lets an AI agent (Claude Desktop, Claude Code, Cursor, …) build, edit and render diagrams with the [flowmaid](https://github.com/go-routine-id/flowmaid) engine. It also serves the flowmaid playground on your machine as a **live view** that stays in sync both ways:

- the agent's edits appear on the canvas at once;
- what you change in the browser (dragging, the node and edge toolbars, the code panel) is what the agent reads next.

One self-contained binary: the engine runs natively, the edit logic is the same Rust module the [playground](https://opensource.go-routine.com/flowmaid-web/) runs as wasm (`src/edit.rs` in this repository), and the playground itself is embedded. The live view listens on `127.0.0.1` only.

## Install

Download the archive for your system (Linux x86_64 / arm64, macOS Apple silicon / Intel, Windows x86_64) from the [latest release](https://github.com/go-routine-id/flowmaid-web/releases/latest), check it against its `.sha256`, and put `flowmaid-mcp` on your `PATH`. Or build it with Rust:

```bash
cargo install --locked --git https://github.com/go-routine-id/flowmaid-web flowmaid-mcp
```

(or `cargo build -p flowmaid-mcp --release` in a checkout; the binary lands in `target/release/`).

Releases are built by `.github/workflows/release.yml` when a tag `mcp-vX.Y.Z` matching `mcp/Cargo.toml`'s version is pushed.

## Setup

Claude Code:

```bash
claude mcp add flowmaid -- flowmaid-mcp
```

Claude Desktop, Cursor and other clients (`mcpServers` in their config; use the full path if `~/.cargo/bin` is not on the client's `PATH`):

```json
{
  "mcpServers": {
    "flowmaid": { "command": "flowmaid-mcp" }
  }
}
```

Then ask the agent something like *"draw the signup flow and open it in the live view"*.

## Tools

| Tool | What it does |
|---|---|
| `get_diagram` | Mermaid source plus parsed nodes (id, label, shape, fill, group), edges (from, to, nth, label, style) and groups, the live URL, and who changed it last (`agent`, `user (live view)`, `file`). |
| `set_diagram` | Replace the whole source (any diagram type). Checked with the engine first; parse errors come back with a line number and change nothing. |
| `edit_diagram` | A list of flowchart edits, applied in order and all-or-nothing: `add_node`, `rename_node`, `delete_node`, `connect`, `update_edge`, `delete_edge`, `set_shape`, `set_color`, `group`, `ungroup`. Only the touched lines are rewritten. |
| `render_diagram` | PNG (default, rendered natively with resvg and your system fonts) or SVG of a document, or of any `source` passed in. |
| `open_live_view` | Opens the diagram in the browser and returns the URL. |
| `open_file` | Binds a document to a `.mmd` file: loaded on open, written on every edit, re-read when another program changes it. |
| `list_diagrams` | The documents in this session. |

Documents are named (`doc`, default `"default"`); each has its own live URL (`?doc=name`).

Shapes: `rect`, `rounded`, `stadium`, `subroutine`, `cylinder`, `circle`, `doublecircle`, `diamond`, `hexagon`, `parallelogram`, `parallelogramalt`. Edge styles: `solid`, `dotted`, `thick`. Colours: `blue`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`, `teal`, `grey`, `default`, or `fill` / `stroke` hex.

## Live view

- Port `7878` by default (the next free one if taken); `FLOWMAID_PORT` chooses another, `0` lets the system pick.
- The URL carries a random session token; requests without it are refused, so other web pages cannot read or change your diagrams. A restarted server has a new token: reopen the view from the agent.
- An edit made in the browser on top of an older copy (the agent changed it meanwhile) is refused rather than undoing the agent's edit, and the page says so.
- Node positions you drag in the browser are saved in the source as a `%% flowmaid:pos id=x,y …` comment line: the agent sees them in `get_diagram`, `render_diagram` draws that layout, and agent edits keep it (a deleted node leaves it).
- The badge in the corner shows the connection and switches between the session's documents; undo / redo in the page reach the agent like any other edit.

## Development

```bash
cargo build -p flowmaid-mcp
cd mcp/test && npm install
npm test                 # the official MCP client drives every tool, the live channel and file binding
node live-browser.mjs    # two-way sync through a real browser (needs Playwright)
```

The live view embeds `index.html`, `flowedit.js` and `pkg/` from the repository root at build time; after changing `src/edit.rs`, rebuild `pkg/` with `scripts/build-wasm.sh` so the playground and the server run the same code.

## License

GPL-3.0-or-later, same as the flowmaid engine.
