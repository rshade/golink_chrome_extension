#!/bin/sh
# Runs the real-tailnet e2e end to end from one OAuth client: mints a tag:golink
# and a tag:golink-ext key, builds and starts the pinned golink on a throwaway
# state directory, runs scripts/browser-e2e.cjs, then stops golink. Keys are
# ephemeral and single-use, are passed by environment only, and are never
# written to disk or printed.
#
# Needs TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET (and TS_TAILNET if the
# client is not scoped to its own tailnet). See docs/e2e-credentials.md.
set -eu
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
log="$work/golink.log"
pid=
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

go build -o "$work/golink" github.com/tailscale/golink/cmd/golink
TS_AUTHKEY="$(node scripts/mint-authkey.cjs tag:golink)"
export TS_AUTHKEY
GOLINK_E2E_AUTHKEY="$(node scripts/mint-authkey.cjs tag:golink-ext)"
export GOLINK_E2E_AUTHKEY

"$work/golink" -sqlitedb "$work/golink.db" -snapshot testdata/e2e/links.jsonl \
  -config-dir "$work/state" -verbose >"$log" 2>&1 </dev/null &
pid=$!
unset TS_AUTHKEY

for _ in $(seq 1 90); do
  grep -q 'Restored .* links' "$log" && break
  kill -0 "$pid" 2>/dev/null || { echo 'golink exited early:' >&2; sed 's/tskey-[A-Za-z0-9-]*/[redacted]/g' "$log" >&2; exit 1; }
  sleep 1
done
grep -q 'Restored .* links' "$log" || { echo 'golink did not become ready in 90s' >&2; exit 1; }

node scripts/browser-e2e.cjs
