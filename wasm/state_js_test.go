//go:build js

package main

import (
	"errors"
	"testing"

	"tailscale.com/ipn"
)

func TestStateCopiesAndCallbacks(t *testing.T) {
	type write struct {
		key   string
		value any
	}
	var writes []write
	var store *stateStore
	var callbackRead []byte
	store, _ = newStateStore(map[string]string{"existing": "AAH/", "empty": ""}, func(key string, value any) error {
		writes = append(writes, write{key, value})
		// The callback must run after unlocking, so synchronous reads are safe.
		callbackRead, _ = store.ReadState(ipn.StateKey(key))
		return nil
	})
	got, err := store.ReadState("existing")
	if err != nil || string(got) != "\x00\x01\xff" {
		t.Fatalf("initial state = %q, %v", got, err)
	}
	got[0] = 42
	again, _ := store.ReadState("existing")
	if again[0] != 0 {
		t.Fatal("read aliases stored state")
	}
	if _, err := store.ReadState("missing"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("missing = %v", err)
	}
	if _, err := store.ReadState("empty"); err != nil {
		t.Fatalf("empty state missing: %v", err)
	}
	input := []byte{0, 2, 255}
	if err := store.WriteState("new", input); err != nil {
		t.Fatal(err)
	}
	input[0] = 42
	again, _ = store.ReadState("new")
	if string(again) != "\x00\x02\xff" || string(callbackRead) != "\x00\x02\xff" {
		t.Fatalf("write aliases input or callback sees stale state: %v %v", again, callbackRead)
	}
	if err := store.WriteState("new", []byte{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadState("new"); err != nil {
		t.Fatal("empty write deletes state")
	}
	if err := store.WriteState("new", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadState("new"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("delete = %v", err)
	}
	if len(writes) != 3 || writes[0] != (write{"new", "AAL/"}) || writes[1] != (write{"new", ""}) || writes[2] != (write{"new", nil}) {
		t.Fatalf("callbacks = %#v", writes)
	}
}

func TestStateRejectsInvalidBase64(t *testing.T) {
	if _, err := newStateStore(map[string]string{"bad": "not base64"}, nil); err == nil {
		t.Fatal("accepted corrupt initial state")
	}
}
