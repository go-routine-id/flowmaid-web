// Named diagrams in memory, each optionally bound to a .mmd file. Every
// change bumps the version and emits "change" so live views follow, and
// a bound file is written (or re-read when someone else edits it).
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const STARTER = "flowchart TD\n    A[Start] --> B[End]\n";

export class Store extends EventEmitter {
  docs = new Map(); // name -> { name, source, version, file, origin, watcher }

  get(name = "default") {
    let d = this.docs.get(name);
    if (!d) {
      d = { name, source: STARTER, version: 1, file: null, origin: "init", watcher: null };
      this.docs.set(name, d);
    }
    return d;
  }

  list() { return [...this.docs.values()]; }

  /** Replace a diagram's source. origin: "agent" | "browser:<id>" | "file". */
  set(name, source, origin) {
    const d = this.get(name);
    if (source === d.source) return d;
    d.source = source;
    d.version++;
    d.origin = origin;
    if (d.file && origin !== "file") {
      d.writing = source;
      try { writeFileSync(d.file, source); } catch (e) { console.error("flowmaid-mcp: write failed:", e.message); }
    }
    this.emit("change", d);
    return d;
  }

  /** Bind a diagram to a file: load it (or create it from the current source). */
  bind(name, path, createWith) {
    const d = this.get(name);
    const file = resolve(path);
    d.watcher?.close();
    d.file = file;
    if (existsSync(file)) this.set(name, readFileSync(file, "utf8"), "file");
    else {
      if (createWith !== undefined) this.set(name, createWith, "file");
      writeFileSync(file, d.source);
    }
    try {
      d.watcher = watch(file, { persistent: false }, () => {
        let text;
        try { text = readFileSync(file, "utf8"); } catch { return; }
        // Ignore the echo of our own write.
        if (text === d.writing) return;
        this.set(name, text, "file");
      });
    } catch { d.watcher = null; }
    return d;
  }
}
