// Command wasmtags prints the Tailscale feature tags that upstream
// cmd/tsconnect uses for its browser build, so build.sh omits the same
// unused features as the pinned Tailscale release.
package main

import (
	"fmt"

	"tailscale.com/cmd/tsconnect/wasmbuild"
)

func main() { fmt.Println(wasmbuild.Tags()) }
