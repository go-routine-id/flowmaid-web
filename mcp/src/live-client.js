// Loaded into the playground page by the MCP live server. Keeps the
// page's code panel in sync with the server's copy of the diagram:
// server changes (an agent's edits, the bound file) replace the text,
// and anything changed here (typing, canvas edits, picking an example)
// is sent back.
const params = new URLSearchParams(location.search);
const doc = params.get("doc") || "default";
const token = params.get("t") || "";
const client = Math.random().toString(36).slice(2, 10);
const editor = document.getElementById("editor");
const q = `doc=${encodeURIComponent(doc)}&t=${encodeURIComponent(token)}`;

// ── Status badge ──
const style = document.createElement("style");
style.textContent = `
  #live-badge {
    position: absolute; z-index: 5; top: 14px; right: 14px; display: flex; align-items: center; gap: 7px;
    padding: 6px 10px; border: 1px solid var(--line2); background: var(--bg); color: var(--dim);
    font: 500 10.5px var(--mono); letter-spacing: .07em; text-transform: uppercase; pointer-events: none;
  }
  #live-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  #live-badge.on::before { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
  #live-badge.flash { color: var(--accent); }
`;
document.head.append(style);
const badge = document.createElement("div");
badge.id = "live-badge";
badge.textContent = `Live · ${doc}`;
badge.title = "Synced with the flowmaid MCP server: agent edits appear here, your edits go back.";
document.getElementById("view").append(badge);
let flashTimer = 0;
function flash(text) {
  badge.textContent = text;
  badge.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { badge.classList.remove("flash"); badge.textContent = `Live · ${doc}`; }, 1400);
}

// ── Wait for the playground to be up ──
function ready() {
  return new Promise((ok) => {
    if (window.flowmaid) return ok();
    addEventListener("flowmaid:ready", ok, { once: true });
  });
}

// ── Server → page ──
let serverSrc = null; // last text the server and this page agreed on
let applying = false;
let first = true;

function applyRemote(src) {
  if (editor.value === src) return;
  applying = true;
  if (first) {
    // A fresh document: new layout, fitted to the view.
    window.flowmaid.open(src);
  } else {
    // Keep the layout (dragged positions survive by node id) and the caret.
    const a = editor.selectionStart, b = editor.selectionEnd;
    window.flowmaid.replace(src);
    if (document.activeElement === editor) editor.setSelectionRange(Math.min(a, src.length), Math.min(b, src.length));
  }
  applying = false;
}

await ready();
const es = new EventSource(`/__events?${q}`);
es.addEventListener("open", () => badge.classList.add("on"));
es.addEventListener("error", () => { badge.classList.remove("on"); badge.textContent = "Reconnecting…"; });
es.addEventListener("source", (e) => {
  const m = JSON.parse(e.data);
  badge.classList.add("on");
  const mine = m.origin === `browser:${client}`;
  serverSrc = m.source;
  if (mine) return;
  applyRemote(m.source);
  if (!first) flash(m.origin === "agent" ? "Agent edited" : m.origin === "file" ? "File changed" : "Updated");
  first = false;
});

// ── Page → server ──
let timer = 0;
function push() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const source = editor.value;
    if (source === serverSrc || serverSrc === null) return;
    serverSrc = source;
    try {
      await fetch(`/__source?${q}`, { method: "POST", body: JSON.stringify({ source, client }), headers: { "content-type": "application/json" } });
    } catch { /* the SSE reconnect brings the server's copy back */ }
  }, 250);
}
editor.addEventListener("input", () => { if (!applying) push(); });
// Some changes (examples, opened files) set the text without an input
// event; catch those too.
setInterval(() => { if (!applying && serverSrc !== null && editor.value !== serverSrc) push(); }, 800);
