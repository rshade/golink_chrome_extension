#!/bin/sh
# Runs the install test in a private mount namespace where /etc/opt is an empty
# tmpfs, so the managed-policy file it writes for Chrome for Testing never
# reaches the host's real browsers.
set -eu
cd "$(dirname "$0")/.."
exec unshare --user --map-root-user --mount sh -c '
	mount -t tmpfs tmpfs /etc/opt
	exec node scripts/check-install.cjs
'
