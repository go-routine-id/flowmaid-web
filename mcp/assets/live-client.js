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

// ── Selection → server ──
// What is selected on the canvas, so the agent can act on "this node".
let selTimer = 0, selNow = null;
function pushSel() {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    fetch(`/__selection?${q}`, {
      method: "POST",
      body: JSON.stringify({ selection: selNow, client, version: serverVersion }),
      headers: { "content-type": "application/json" },
    }).catch(() => {});
  }, 150);
}
addEventListener("flowmaid:select", (e) => { selNow = e.detail; pushSel(); });

// ── Chat with the agent ──
// Messages go to the agent's session when Claude Code loaded this server
// as a channel; its answers (reply_chat) come back over /__chat_events.
const chatStyle = document.createElement("style");
chatStyle.textContent = `
  #live-chat-btn { font: inherit; letter-spacing: inherit; text-transform: inherit; color: var(--ink); background: transparent;
    border: 0; border-left: 1px solid var(--line2); padding: 0 0 0 7px; cursor: pointer; }
  #live-chat {
    position: absolute; z-index: 5; top: 50px; right: 14px; width: min(340px, calc(100% - 28px)); display: flex; flex-direction: column;
    border: 1px solid var(--line2); background: var(--bg); color: var(--ink); font: 13px var(--body);
  }
  #live-chat[hidden] { display: none; }
  #live-chat .log { max-height: 260px; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  #live-chat .log:empty::before { content: attr(data-empty); color: var(--dim); font-size: 12px; }
  #live-chat .msg { padding: 5px 8px; max-width: 88%; white-space: pre-wrap; overflow-wrap: anywhere; }
  #live-chat .me { align-self: flex-end; background: var(--accent-soft); }
  #live-chat .agent { align-self: flex-start; border: 1px solid var(--line2); }
  #live-chat .note { align-self: center; color: var(--dim); font-size: 11.5px; }
  #live-chat form { display: flex; border-top: 1px solid var(--line2); }
  #live-chat textarea { flex: 1; resize: none; border: 0; padding: 8px 10px; font: inherit; color: var(--ink); background: transparent; min-height: 38px; }
  #live-chat textarea:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  #live-chat button[type=submit] { border: 0; border-left: 1px solid var(--line2); padding: 0 12px; font: 600 12px var(--body); color: var(--ink); background: transparent; cursor: pointer; }
`;
document.head.append(chatStyle);
const chatBtn = document.createElement("button");
chatBtn.id = "live-chat-btn";
chatBtn.type = "button";
chatBtn.textContent = "Chat";
chatBtn.setAttribute("aria-expanded", "false");
badge.append(chatBtn);
const chat = document.createElement("div");
chat.id = "live-chat";
chat.hidden = true;
chat.innerHTML = `<div class="log" role="log" aria-live="polite"></div>
  <form><textarea rows="1" maxlength="4000" placeholder="Ask the agent… (Enter to send)" aria-label="Message to the agent"></textarea><button type="submit">Send</button></form>`;
document.getElementById("view").append(chat);
const log = chat.querySelector(".log");
log.dataset.empty = "Messages reach the agent when Claude Code runs with: claude --dangerously-load-development-channels server:flowmaid";
const input = chat.querySelector("textarea");
for (const el of [chatBtn, chat]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
chat.addEventListener("keydown", (e) => e.stopPropagation());
chatBtn.addEventListener("click", () => {
  chat.hidden = !chat.hidden;
  chatBtn.setAttribute("aria-expanded", String(!chat.hidden));
  if (!chat.hidden) input.focus();
});
function say(text, who) {
  const p = document.createElement("div");
  p.className = "msg " + who;
  p.textContent = text;
  log.append(p);
  log.scrollTop = log.scrollHeight;
}
let waitTimer = 0;
chat.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  say(text, "me");
  try {
    const r = await fetch(`/__chat?${q}`, { method: "POST", body: JSON.stringify({ text }), headers: { "content-type": "application/json" } });
    if (!r.ok) return say(`Not sent (${r.status}): ${await r.text()}`, "note");
    // The server can't tell whether the session listens: say so if nothing comes back.
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => say("No answer yet. If none comes, start Claude Code with --dangerously-load-development-channels server:flowmaid.", "note"), 60000);
  } catch {
    say("Not sent — server unreachable", "note");
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chat.querySelector("form").requestSubmit(); }
});
const replies = new EventSource(`/__chat_events?${q}`);
replies.addEventListener("reply", (e) => {
  clearTimeout(waitTimer);
  say(JSON.parse(e.data).text, "agent");
  if (chat.hidden) chatBtn.click();
});
