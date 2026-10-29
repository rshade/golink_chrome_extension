#!/bin/sh
# Packs the built extension into a release directory: signed CRX, unpacked zip,
# update XML, notices, and checksums. The signing key comes from a file named
# by RELEASE_KEY_FILE and is never copied or printed.
set -eu
cd "$(dirname "$0")/.."
ext=${EXT_DIR:-ext}
out=${OUT_DIR:-dist/release}
repo_url=${RELEASE_REPO_URL:-https://github.com/rshade/golink_chrome_extension}
: "${RELEASE_KEY_FILE:?set RELEASE_KEY_FILE to the signing key path}"
version=${RELEASE_VERSION:-$(node -p "require(require('node:path').resolve('$ext', 'manifest.json')).version")}
crx=golink-ext-$version.crx

rm -rf "$out"
mkdir -p "$out"
id=$(node scripts/pack-crx.cjs --ext "$ext" --key "$RELEASE_KEY_FILE" --version "$version" \
	--crx "$out/$crx" --zip "$out/golink-ext-$version.zip")
node scripts/update-xml.cjs --manifest "$ext/manifest.json" \
	--codebase "$repo_url/releases/download/v$version/$crx" --out "$out/update.xml"
scripts/licenses.sh "$out/THIRD_PARTY_NOTICES.md"
(cd "$out" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum >SHA256SUMS)
echo "extension $id version $version"
