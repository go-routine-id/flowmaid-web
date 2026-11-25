// The flowmaid-mcp binary under test: $FLOWMAID_MCP_BIN, else the
// workspace's release build, else its debug build.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = (p) => fileURLToPath(new URL(`../../target/${p}/flowmaid-mcp`, import.meta.url));
export const bin = process.env.FLOWMAID_MCP_BIN
  ?? [target("release"), target("debug")].find((p) => existsSync(p))
  ?? (() => { throw new Error("build it first: cargo build -p flowmaid-mcp"); })();
