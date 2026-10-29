#!/bin/sh
# The extension embeds a Tailscale node, not the golink server: keep both the
# server and its SQLite driver out of the WASM binary.
set -eu
cd "$(dirname "$0")/.."
deps=$(GOOS=js GOARCH=wasm go list -deps ./wasm)
if printf '%s\n' "$deps" | grep -E '^(github.com/tailscale/golink|modernc.org/sqlite)(/|$)'; then
	echo "check-wasm-deps: server or SQLite leaked into the WASM build" >&2
	exit 1
fi
