#!/bin/sh
# Runs scripts/browser-e2e.cjs against the published release: Google Chrome
# force-installs it by policy from the manifest's real update_url, then the
# usual checks run against a golink on a real tailnet (needs GOLINK_E2E_AUTHKEY).
# Chrome reads policy from /etc/opt, so a private mount namespace with a tmpfs
# there keeps the policy file off the host.
set -eu
cd "$(dirname "$0")/.."
export GOLINK_E2E_INSTALLED=1
exec unshare --user --map-root-user --mount sh -ec 'mount -t tmpfs tmpfs /etc/opt && exec node scripts/browser-e2e.cjs'
