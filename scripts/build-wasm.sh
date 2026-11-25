#!/usr/bin/env bash
# Rebuild pkg/ (the wasm engine + edit helpers the playground loads).
# Same steps wasm-pack runs: cargo build → wasm-bindgen (--target web) →
# wasm-opt -O. Needs the wasm32 target, wasm-bindgen-cli at the version
# in Cargo.lock, and a recent binaryen wasm-opt (old ones, e.g. distro
# v108, corrupt wasm-bindgen's externref table). Point WASM_OPT at one,
# or let it run from npm: WASM_OPT="npx -y binaryen@132.0.0 wasm-opt"
# does not work as-is (npx runs the package's default bin), so install
# it: npm i -g binaryen@132.0.0.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --lib --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/flowmaid_web.wasm
WASM_OPT=${WASM_OPT:-wasm-opt}
v=$($WASM_OPT --version | grep -o '[0-9]\+' | head -1)
if [ "${v:-0}" -lt 116 ]; then
  echo "wasm-opt $v is too old (need >= 116); set WASM_OPT or: npm i -g binaryen@132.0.0" >&2
  exit 1
fi
$WASM_OPT -O pkg/flowmaid_web_bg.wasm -o pkg/flowmaid_web_bg.wasm
ls -l pkg/flowmaid_web_bg.wasm
