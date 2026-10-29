package main

import (
	"slices"
	"strings"
	"testing"
)

// The extension verifies golink's Let's Encrypt certificate in Go. js/wasm has
// no system roots, so dropping the baked-in roots (as tsconnect does, because a
// browser verifies certificates itself) makes every HTTPS golink unreachable.
func TestTagsKeepBakedRoots(t *testing.T) {
	if slices.Contains(strings.Split(tags(), ","), "ts_omit_bakedroots") {
		t.Fatal("tags omit the baked-in roots; HTTPS golink servers would fail certificate verification")
	}
}

func TestTagsStillTrimUnusedFeatures(t *testing.T) {
	if !slices.Contains(strings.Split(tags(), ","), "ts_omit_aws") {
		t.Fatal("tags no longer follow tsconnect's trimmed build")
	}
}
