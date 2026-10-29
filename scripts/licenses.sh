#!/bin/sh
# Writes THIRD_PARTY_NOTICES.md plus the license of every Go module compiled
# into the WASM binary to the file named by the first argument. Fails if a
# module has no license file, so a release never ships incomplete notices.
set -eu
cd "$(dirname "$0")/.."
out=${1:?usage: licenses.sh OUTPUT_FILE}

modules=$(mktemp)
trap 'rm -f "$modules"' EXIT
if [ -n "${MODULE_LIST_FILE:-}" ]; then
	cp "$MODULE_LIST_FILE" "$modules"
else
	GOOS=js GOARCH=wasm go list -deps -f '{{with .Module}}{{.Path}} {{.Version}} {{.Dir}}{{end}}' ./wasm | sort -u >"$modules"
fi

cp THIRD_PARTY_NOTICES.md "$out"
{
	printf '\n# Licenses of modules compiled into main.wasm\n'
	while read -r path version dir; do
		[ "$path" = golink-chrome-extension ] && continue
		found=
		for file in "$dir"/LICENSE* "$dir"/LICENCE* "$dir"/COPYING* "$dir"/NOTICE* "$dir"/PATENTS*; do
			[ -f "$file" ] || continue
			if [ -z "$found" ]; then printf '\n## %s %s\n' "$path" "$version"; found=1; fi
			printf '\n### %s\n\n' "$(basename "$file")"
			cat "$file"
			printf '\n'
		done
		if [ -z "$found" ]; then
			echo "licenses: no license file for $path $version" >&2
			exit 1
		fi
	done <"$modules"
} >>"$out"
