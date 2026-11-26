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
    font: 500 10.5px var(--mono); letter-spacing: .07em; text-transform: uppercase;
  }
  #live-badge select {
    font: inherit; letter-spacing: inherit; text-transform: none; color: var(--ink); background: transparent;
    border: 0; border-left: 1px solid var(--line2); padding: 0 0 0 7px; cursor: pointer; max-width: 160px;
  }
  #live-badge select:focus-visible { outline: 1px solid var(--accent); }
  #live-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  #live-badge.on::before { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
  #live-badge.flash { color: var(--accent); }
`;
document.head.append(style);
// "● LIVE  [doc ▾]": status text plus a switcher over the session's docs.
const badge = document.createElement("div");
badge.id = "live-badge";
badge.title = "Synced with the flowmaid MCP server: agent edits appear here, your edits go back.";
const status = document.createElement("span");
status.textContent = "Live";
const picker = document.createElement("select");
picker.setAttribute("aria-label", "Agent diagram");
picker.append(new Option(doc, doc, true, true));
badge.append(status, picker);
document.getElementById("view").append(badge);
document.body.classList.add("live");
document.body.dataset.liveDoc = doc;
picker.addEventListener("pointerdown", (e) => e.stopPropagation());
picker.addEventListener("change", () => {
  const u = new URL(location.href);
  u.searchParams.set("doc", picker.value);
  location.href = u.href;
});
// Keep the list current (the agent may create documents any time).
async function refreshDocs() {
  try {
    const list = await (await fetch(`/__docs?${q}`)).json();
    const names = list.map((d) => d.doc);
    if (!names.includes(doc)) names.unshift(doc);
    if (names.join("\n") === [...picker.options].map((o) => o.value).join("\n")) return;
    picker.replaceChildren(...names.map((n) => new Option(n, n, n === doc, n === doc)));
  } catch { /* offline: keep what we have */ }
}
picker.addEventListener("focus", refreshDocs);
// Other documents send no events to this page: look now and then.
setInterval(() => { if (!document.hidden) refreshDocs(); }, 3000);
let flashTimer = 0;
function flash(text) {
  status.textContent = text;
  badge.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { badge.classList.remove("flash"); status.textContent = "Live"; }, 1400);
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
let serverVersion = null; // its version: a POST built on it is refused if stale
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
es.addEventListener("error", () => {
  badge.classList.remove("on");
  // A restarted server has a new session token: this page can't rejoin.
  status.textContent = es.readyState === EventSource.CLOSED ? "Disconnected — reopen from the agent" : "Reconnecting…";
});
es.addEventListener("source", (e) => {
  const m = JSON.parse(e.data);
  badge.classList.add("on");
  refreshDocs();
  const mine = m.origin === `browser:${client}`;
  // Typing not yet sent is about to be replaced: say so.
  const lost = !mine && !first && serverSrc !== null && editor.value !== serverSrc && editor.value !== m.source;
  serverSrc = m.source;
  serverVersion = m.version;
  if (mine) return;
  applyRemote(m.source);
  if (lost) { flash("Agent edited — your unsent typing was replaced"); first = false; return; }
  if (!first) flash(m.origin === "agent" ? "Agent edited" : m.origin === "file" ? "File changed" : "Updated");
  first = false;
});

// ── Page → server ──
let timer = 0, inflight = false, refused = null;
function push() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const source = editor.value;
    if (inflight || source === serverSrc || serverSrc === null || source === refused) return;
    inflight = true;
    try {
      const r = await fetch(`/__source?${q}`, {
        method: "POST",
        body: JSON.stringify({ source, client, base: serverVersion }),
        headers: { "content-type": "application/json" },
      });
      if (r.ok) {
        // Only now is it the server's copy too, unless a newer version
        // (an agent edit) already arrived over SSE while this was in
        // flight: then that one stands.
        const v = (await r.json()).version;
        if (serverVersion === null || v > serverVersion) {
          serverSrc = source;
          serverVersion = v;
        }
        refused = null;
      } else if (r.status === 409) {
        // The agent changed it first; its version arrives over SSE.
        flash("Agent changed it first — your edit was not applied");
      } else {
        refused = source; // don't resend the same text; the next edit retries
        flash(`Not synced (${r.status})`);
      }
    } catch {
      flash("Not synced — server unreachable");
    } finally {
      inflight = false;
    }
  }, 250);
}
editor.addEventListener("input", () => { if (!applying) push(); });
// Some changes (examples, opened files) set the text without an input
// event; catch those too.
setInterval(() => { if (!applying && serverSrc !== null && editor.value !== serverSrc) push(); }, 800);
