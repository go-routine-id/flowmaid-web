# flowmaid-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Desktop, Claude Code, Cursor, …) build, edit and render diagrams with the [flowmaid](https://github.com/go-routine-id/flowmaid) engine. It also serves the flowmaid playground on your machine as a **live view** that stays in sync both ways:

- the agent's edits appear on the canvas at once;
- what you change in the browser (dragging, the node and edge toolbars, the code panel) is what the agent reads next.

Everything runs locally: the engine is the same WebAssembly build as the [playground](https://opensource.go-routine.com/flowmaid-web/), and the live view listens on `127.0.0.1` only.

## Setup

Claude Code:

```bash
claude mcp add flowmaid -- npx -y flowmaid-mcp
```

Claude Desktop, Cursor and other clients (`mcpServers` in their config):

```json
{
  "mcpServers": {
    "flowmaid": { "command": "npx", "args": ["-y", "flowmaid-mcp"] }
  }
}
```

From a checkout of this repository instead of npm:

```bash
cd mcp && npm install
# then use: "command": "node", "args": ["/path/to/flowmaid-web/mcp/server.js"]
```

Then ask the agent something like *"draw the signup flow and open it in the live view"*.

## Tools

| Tool | What it does |
|---|---|
| `get_diagram` | Mermaid source plus parsed nodes (id, label, shape, fill, group), edges (from, to, nth, label, style) and groups, the live URL, and who changed it last (`agent`, `user (live view)`, `file`). |
| `set_diagram` | Replace the whole source (any diagram type). Checked with the engine first; parse errors come back with a line number and change nothing. |
| `edit_diagram` | A list of flowchart edits, applied in order and all-or-nothing: `add_node`, `rename_node`, `delete_node`, `connect`, `update_edge`, `delete_edge`, `set_shape`, `set_color`, `group`, `ungroup`. Only the touched lines are rewritten. |
| `render_diagram` | PNG (default) or SVG of a document, or of any `source` passed in. |
| `open_live_view` | Opens the diagram in the browser and returns the URL. |
| `open_file` | Binds a document to a `.mmd` file: loaded on open, written on every edit, re-read when someone else changes it. |
| `list_diagrams` | The documents in this session. |

Documents are named (`doc`, default `"default"`); each has its own live URL (`?doc=name`).

Shapes: `rect`, `rounded`, `stadium`, `subroutine`, `cylinder`, `circle`, `doublecircle`, `diamond`, `hexagon`, `parallelogram`, `parallelogramalt`. Edge styles: `solid`, `dotted`, `thick`. Colours: `blue`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`, `teal`, `grey`, `default`, or `fill` / `stroke` hex.

## Live view

- Port `7878` by default (the next free one if taken); set `FLOWMAID_PORT` to choose.
- The URL carries a random session token; requests without it are refused, so other web pages cannot read or change your diagrams.
- Several browser tabs can follow the same document. Changes are last-writer-wins.
- Node positions you drag in the browser stay where they are when the agent edits.

## PNG

PNG rendering uses the optional [`@resvg/resvg-js`](https://github.com/yisibl/resvg-js) with your system fonts. Where it cannot be installed, `render_diagram` returns SVG instead.

## Development

```bash
npm install
npm test                       # MCP client over stdio: every tool, the live channel, file binding
node test/live-browser.mjs     # two-way sync through a real browser (needs Playwright)
npm pack                       # copies the playground and engine into web/ first (prepack)
```

## License

GPL-3.0-or-later, same as the flowmaid engine.
