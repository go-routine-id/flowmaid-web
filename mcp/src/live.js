// A small local web server: the flowmaid playground plus a sync channel.
// Agent edits reach open pages over Server-Sent Events; edits made in the
// page (canvas or code) come back with a POST. Bound to 127.0.0.1 only,
// and every sync request must carry the session token from the URL, so
// another website cannot read or overwrite the diagrams.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB } from "./engine.js";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };
const STATIC = new Map([
  ["/pkg/flowmaid_web.js", join(WEB, "pkg", "flowmaid_web.js")],
  ["/pkg/flowmaid_web_bg.wasm", join(WEB, "pkg", "flowmaid_web_bg.wasm")],
  ["/flowedit.js", join(WEB, "flowedit.js")],
  ["/__live.js", new URL("./live-client.js", import.meta.url)],
]);
const MAX_BODY = 1 << 20;

export async function startLive(store, { port = Number(process.env.FLOWMAID_PORT) || 7878, host = "127.0.0.1" } = {}) {
  const token = randomBytes(12).toString("hex");
  const clients = new Set(); // { res, doc }
  const page = () => readFileSync(join(WEB, "index.html"), "utf8")
    .replace("</body>", '<script type="module" src="/__live.js"></script>\n</body>');

  const send = (c, d) => c.res.write(`event: source\ndata: ${JSON.stringify({ doc: d.name, source: d.source, version: d.version, origin: d.origin })}\n\n`);
  store.on("change", (d) => { for (const c of clients) if (c.doc === d.name) send(c, d); });

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const authed = url.searchParams.get("t") === token;
    const doc = url.searchParams.get("doc") || "default";
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      return res.end(page());
    }
    if (req.method === "GET" && STATIC.has(url.pathname)) {
      const f = STATIC.get(url.pathname);
      const ext = String(f).slice(String(f).lastIndexOf("."));
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(readFileSync(f));
    }
    if (!authed && url.pathname.startsWith("/__")) { res.writeHead(403); return res.end("bad token"); }
    if (req.method === "GET" && url.pathname === "/__events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const c = { res, doc };
      clients.add(c);
      send(c, store.get(doc));
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); clients.delete(c); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/__source") {
      let body = "", tooBig = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY && !tooBig) { tooBig = true; res.writeHead(413); res.end(); req.destroy(); }
      });
      req.on("end", () => {
        if (tooBig) return;
        try {
          const { source, client } = JSON.parse(body);
          if (typeof source !== "string") throw new Error("source must be a string");
          const d = store.set(doc, source, `browser:${String(client).slice(0, 32)}`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: d.version }));
        } catch (e) {
          res.writeHead(400); res.end(String(e.message));
        }
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  });

  // Take the requested port, or the next free one.
  let p = port;
  for (;;) {
    try {
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(p, host, () => { server.off("error", fail); ok(); });
      });
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE" || p > port + 30) throw e;
      p++;
    }
  }
  const base = `http://${host}:${server.address().port}/`;
  return {
    server,
    viewers: (doc) => [...clients].filter((c) => c.doc === doc).length,
    url: (doc = "default") => `${base}?doc=${encodeURIComponent(doc)}&t=${token}`,
  };
}
