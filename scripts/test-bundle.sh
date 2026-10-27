#!/bin/sh
# Builds two archives in dist/ for testing on another machine:
#   golink-ext-test-<commit>.tar.gz: the built extension, pinned golink server
#     binaries, test fixtures, and docs/testing-on-a-test-tailnet.md as README.
#   <repo>-<commit>-full.tar.gz: the whole repository with Git history, the
#     built ext/, and the test bundle, so problems can be fixed on that machine.
# dist/ holds only this script's output and is emptied first.
set -eu
cd "$(dirname "$0")/.."

# The bundle is named after the commit, so it must contain exactly that commit.
if [ -n "$(git status --porcelain)" ]; then
	echo "test-bundle: commit or stash changes first" >&2
	exit 1
fi
rev=$(git rev-parse --short HEAD)
name=golink-ext-test-$rev
out=dist/$name
rm -rf dist
mkdir -p "$out/golink" "$out/fixtures"

./build.sh
cp -R ext "$out/extension"
cp testdata/e2e/links.jsonl testdata/e2e/policy.hujson testdata/e2e/framed-check.html "$out/fixtures/"
cp docs/testing-on-a-test-tailnet.md "$out/README.md"

# golink is a pinned test dependency of this module, so the server matches the
# version the Go tests run against.
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64 windows/amd64; do
	goos=${target%/*} goarch=${target#*/}
	bin=golink-$goos-$goarch
	[ "$goos" = windows ] && bin=$bin.exe
	CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags "-s -w" \
		-o "$out/golink/$bin" github.com/tailscale/golink/cmd/golink
done

git archive --format=tar.gz --prefix=golink-chrome-extension/ -o "$out/source.tar.gz" HEAD
cat >"$out/VERSION" <<EOF
extension commit: $(git rev-parse HEAD)
golink: $(go list -m -f '{{.Version}}' github.com/tailscale/golink)
tailscale.com: $(go list -m -f '{{.Version}}' tailscale.com)
go: $(go env GOVERSION)
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
(cd "$out" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum >SHA256SUMS)
tar -C dist -czf "dist/$name.tar.gz" "$name"

# Archive the repository from one level up so it unpacks under its own name.
# The test bundle's own archive is already inside dist/$name, unpacked.
repo=$(basename "$PWD")
full=$repo-$rev-full.tar.gz
tar -C .. --exclude="$repo/dist/*.tar.gz" -czf "dist/$full" "$repo"
echo "dist/$name.tar.gz"
echo "dist/$full"
