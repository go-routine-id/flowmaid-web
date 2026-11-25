// Copies the playground (page, edit helpers, wasm engine) into web/ so
// the published package is self-contained. In a checkout the server
// reads them straight from the repository root instead.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const web = join(here, "..", "web");
rmSync(web, { recursive: true, force: true });
mkdirSync(join(web, "pkg"), { recursive: true });
for (const f of ["index.html", "flowedit.js", "LICENSE"]) cpSync(join(root, f), join(web, f));
for (const f of ["flowmaid_web.js", "flowmaid_web_bg.wasm"]) cpSync(join(root, "pkg", f), join(web, "pkg", f));
console.error("copied playground assets into", web);
