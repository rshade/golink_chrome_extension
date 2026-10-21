//go:build js

package main

import (
	"syscall/js"
	"testing"
)

// One failed callback can pass through several error handlers. It must count
// as one fatal document failure, preserving the worker's two-crash budget.
func TestCallbackFailureReportsOneFatal(t *testing.T) {
	var fatals []string
	onFatal := js.FuncOf(func(_ js.Value, args []js.Value) any {
		fatals = append(fatals, args[0].String())
		return nil
	})
	defer onFatal.Release()
	noop := js.FuncOf(func(js.Value, []js.Value) any { return nil })
	defer noop.Release()
	cb, err := readCallbacks(js.ValueOf(map[string]any{
		"onState":      js.Global().Get("JSON").Get("parse"),
		"onStateWrite": noop, "onBrowseToURL": noop, "onFatal": onFatal,
	}))
	if err != nil {
		t.Fatal(err)
	}
	// JSON.parse throws a real JavaScript exception for a backend state name.
	if err := cb.call("onState", "Running"); err == nil {
		t.Fatal("callback exception was lost")
	} else {
		cb.fatal(err.Error())
	}
	if len(fatals) != 1 {
		t.Fatalf("one callback failure emitted %d fatals", len(fatals))
	}
}
