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
mise run test-browser         # real Chromium loads ext/; needs `mise run browser-setup`
mise run test-e2e             # real tailnet; see "Real tailnet run" below
mise run test-install         # force-install by policy, then update
mise run package              # signed release assets; needs RELEASE_KEY_FILE
scripts/test-bundle.sh        # needs a clean tree; writes dist/
```

Run all of them before committing; CI (`.github/workflows/build.yml`) runs the
same set and also checks that `go list -deps ./wasm` has no golink or SQLite.

## Real tailnet run

`scripts/browser-e2e.cjs` covers the auth-key checks of the testing doc (B, C,
F). Interactive login (A) and Chrome restarts (E) stay manual.

1. The tailnet needs `tag:golink` and `tag:golink-ext` (see
   `testdata/e2e/policy.hujson`), MagicDNS, and HTTPS certificates.
2. Build the pinned server: `go build -o golink github.com/tailscale/golink/cmd/golink`.
   Start it with a `tag:golink` auth key in `TS_AUTHKEY`, `-snapshot
   testdata/e2e/links.jsonl`, and a `-config-dir` it keeps.
3. Export a `tag:golink-ext` auth key as `GOLINK_E2E_AUTHKEY` and run
   `mise run test-e2e`. The key is never written to disk or extension storage.

`mise run test-e2e-minted` does steps 2 and 3 from one OAuth client
(`TS_OAUTH_CLIENT_ID`/`TS_OAUTH_CLIENT_SECRET`): it mints ephemeral keys with
`scripts/mint-authkey.cjs`, starts golink, and runs the checks. Locally the
client lives in a Pulumi ESC environment (`pulumi env run <env> -- mise run
test-e2e-minted`); CI uses the `e2e-tailnet` environment's secrets in
`.github/workflows/e2e.yml`. Never read or print the secret. Setup is in
`docs/e2e-credentials.md`.

Hard-won facts:

- `wasmtags` removes `ts_omit_bakedroots` from tsconnect's tags. js/wasm has no
  system roots, so without the baked-in Let's Encrypt roots every HTTPS golink
  fails with `x509: certificate signed by unknown authority`, and the popup says
  only "Golink is unreachable. Check ACL access". Unit tests and the no-network
  smoke cannot see this; only a real tailnet does.
- Tailscale rejects punctuation in auth key descriptions.
- `wasm_exec.js` rejects environments over 8 KB; `test-wasm` runs under
  `env -i` for that reason.
- Unknown links pass through `status.html#...` before `?create=...`; wait for
  the message text, not for the form to appear.

## Releasing

release-please opens release PRs from conventional commits; merging one tags,
checks, and packs a signed CRX in the approval-gated `release-signing`
environment. Setup and key handling are in `docs/releasing.md`; install and
policy snippets are in `docs/deploying.md`. Facts that cost time:

- The extension ID is fixed by the manifest `key` (`scripts/extension-id.cjs`);
  `update_url` in the manifest cannot change once installed copies exist.
- Chrome for Testing reads policy from `/etc/opt/chrome_for_testing/policies/managed`.
  `check-install` runs in `unshare --user --map-root-user --mount` with a tmpfs
  over `/etc/opt`, so the host is untouched; CI needs
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- Playwright's default `--disable-extensions` and `--disable-background-networking`
  must be ignored for force-install. Headless Chrome closes tabs on
  `chrome-extension://` URLs, so read `chrome://extensions-internals` instead.
- Node's test runner auto-runs `*-test.cjs`; name scripts `check-*`.
- Third-party actions in `release.yml` are pinned to commit SHAs.

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

## Planning changes

OpenSpec is pinned in `mise.toml` (`mise install`). Start a change with
`/opsx:propose "idea"`; proposals live in `openspec/changes/`. Project rules
for proposals are in `openspec/config.yaml`. The existing design spec stays in
`docs/superpowers/specs/` and has not been migrated into `openspec/specs/`.

## Conventions

- Write a failing test first, then the fix.
- Commit messages: `fix:`, `feat:`, `docs:`, `test:`, `ci:` and an imperative
  summary, with a body explaining why.
- Status-page commands must come from the popup or a top-level tab: the worker
  rejects framed senders because `status.html` is web accessible.
- Never log, store, or render auth keys.
