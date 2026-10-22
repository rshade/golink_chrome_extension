#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ext
# Match upstream cmd/tsconnect's production flags for the pinned release.
tags=$(go run ./scripts/wasmtags)
GOOS=js GOARCH=wasm go build -tags "$tags" -trimpath -ldflags "-s -w" -o ext/main.wasm ./wasm
cp -f "$(go env GOROOT)/lib/wasm/wasm_exec.js" ext/wasm_exec.js
