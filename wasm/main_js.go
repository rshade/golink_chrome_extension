//go:build js

package main

import "syscall/js"

// Exported callbacks must remain live for the offscreen document's lifetime.
var exportedFuncs []js.Func

func main() {
	app := new(application)
	api := make(map[string]any)
	for _, method := range []string{"start", "login", "logout", "status", "resolve", "save", "links"} {
		fn := js.FuncOf(func(_ js.Value, args []js.Value) any {
			return makePromise(func() (any, error) { return app.call(method, args) }, app.fatal)
		})
		exportedFuncs = append(exportedFuncs, fn)
		api[method] = fn
	}
	js.Global().Set("golinkExt", api)
	select {}
}
