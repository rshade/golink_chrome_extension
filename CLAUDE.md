# CLAUDE.md

A Chrome MV3 extension that embeds a Tailscale node compiled to WebAssembly and
uses it to resolve, save, and autocomplete links on an existing golink server.
It is a reference example: keep it readable.

## Read first

- `docs/superpowers/specs/2026-10-21-golink-chrome-extension-design.md`: the
  design. It describes the code as built; update it when behavior changes.
- `docs/testing-on-a-test-tailnet.md`: manual checks on a real tailnet, with
  check IDs (A1, B7, …). Bug reports usually cite these.
- `README.md`: user-facing setup and known limitations.

## Commands

```sh
./build.sh                    # ext/main.wasm + ext/wasm_exec.js (gitignored)
go test ./...                 # golinkclient against a real dev-mode golink
GOOS=js GOARCH=wasm go test -exec="$(go env GOROOT)/lib/wasm/go_js_wasm_exec" ./wasm
node --test                   # tests/*.test.js, fake Chrome APIs, no npm deps
node scripts/wasm-smoke.cjs   # after build.sh: exported Go API, no network
scripts/test-bundle.sh        # needs a clean tree; writes dist/
```

Run all of them before committing; CI (`.github/workflows/build.yml`) runs the
same set and also checks that `go list -deps ./wasm` has no golink or SQLite.

## Layout

- `golinkclient/`: plain Go HTTP client for golink (resolve, save, export,
  HTTPS upgrade). All golink protocol decisions live here; it is tested on
  Linux.
- `wasm/` (`//go:build js`): node setup copied from tailscale.com v1.104.2
  `cmd/tsconnect/wasm` (see `THIRD_PARTY_NOTICES.md`), state store, and the
  JS Promise bridge exported as `globalThis.golinkExt`.
- `ext/background.js`: service worker; omnibox, redirect rule, page message
  routing and sender validation, login tab, links cache.
- `ext/lifecycle.js`: offscreen document lifecycle (hello handshake, epochs,
  crash limit, logout/reset/auth key). `ext/state.js`: storage queue.
- `ext/offscreen.js`: hosts the WASM node. `ext/status.js`: popup and page UI.
- `testdata/e2e/`: golink fixtures and policy for the manual checks.

## Trying a change in Chrome

Go changes need `./build.sh`; `ext/` JS/HTML/CSS changes don't. Then reload the
extension on `chrome://extensions` (the unpacked `ext/` directory). The node
restarts and keeps its identity. Rerun the affected check from the testing doc.

## Conventions

- Write a failing test first, then the fix.
- Commit messages: `fix:`, `feat:`, `docs:`, `test:`, `ci:` and an imperative
  summary, with a body explaining why.
- Status-page commands must come from the popup or a top-level tab: the worker
  rejects framed senders because `status.html` is web accessible.
- Never log, store, or render auth keys.
