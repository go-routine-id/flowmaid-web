// The flowmaid-mcp binary under test: $FLOWMAID_MCP_BIN, else the newer
// of the workspace's release and debug builds (so a leftover release
// build doesn't shadow the debug build just made).
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = (p) => fileURLToPath(new URL(`../../target/${p}/flowmaid-mcp`, import.meta.url));
const built = [target("release"), target("debug")].filter((p) => existsSync(p))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
export const bin = process.env.FLOWMAID_MCP_BIN
  ?? built[0]
  ?? (() => { throw new Error("build it first: cargo build -p flowmaid-mcp"); })();
