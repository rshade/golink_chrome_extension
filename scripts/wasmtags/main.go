// Command wasmtags prints the Tailscale feature tags that upstream
// cmd/tsconnect uses for its browser build, so build.sh omits the same
// unused features as the pinned Tailscale release. It keeps the baked-in Let's
// Encrypt roots: tsconnect drops them because a browser checks certificates
// itself, but this extension checks golink's certificate in Go.
package main

import (
	"fmt"
	"slices"
	"strings"

	"tailscale.com/cmd/tsconnect/wasmbuild"
)

func main() { fmt.Println(tags()) }

func tags() string {
	all := strings.Split(wasmbuild.Tags(), ",")
	return strings.Join(slices.DeleteFunc(all, func(tag string) bool { return tag == "ts_omit_bakedroots" }), ",")
}
