#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ext
GOOS=js GOARCH=wasm go build -o ext/main.wasm ./wasm
cp -f "$(go env GOROOT)/lib/wasm/wasm_exec.js" ext/wasm_exec.js
