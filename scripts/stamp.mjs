// Stamp index.html's import map with a hash of the modules it loads, so
// every build gets new URLs and browsers never mix a new page with old
// cached modules (GitHub Pages caches .js for hours, the page for
// minutes). Run after changing pkg/ or flowedit.js (build-wasm.sh does);
// `--check` fails when the stamp is out of date (CI).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const FILES = ["flowedit.js", "pkg/flowmaid_web.js", "pkg/flowmaid_web_bg.wasm"];
const hash = createHash("sha256");
for (const f of FILES) hash.update(readFileSync(root(f)));
const v = hash.digest("hex").slice(0, 12);

const page = readFileSync(root("index.html"), "utf8");
const map = page.match(/<script type="importmap">[\s\S]*?<\/script>/);
if (!map) throw new Error("index.html has no import map");
const stamped = map[0].replace(/\?v=[0-9a-z]+"/g, `?v=${v}"`);
for (const f of FILES) {
  if (!stamped.includes(`"./${f}": "./${f}?v=${v}"`)) throw new Error(`import map lacks ${f}`);
}
if (process.argv.includes("--check")) {
  if (stamped !== map[0]) {
    console.error(`index.html's import map is not stamped for these modules (want ?v=${v}): run node scripts/stamp.mjs`);
    process.exit(1);
  }
  console.log(`import map stamp ok (${v})`);
} else {
  writeFileSync(root("index.html"), page.replace(map[0], stamped));
  console.log(`stamped ?v=${v}`);
}
