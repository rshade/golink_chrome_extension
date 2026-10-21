//go:build js

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"sync"

	"tailscale.com/ipn"
)

// stateStore keeps synchronous reads independent of asynchronous Chrome storage.
// The offscreen document waits for persistence acknowledgements when needed.
type stateStore struct {
	mu      sync.Mutex
	values  map[ipn.StateKey][]byte
	onWrite func(string, any) error
}

var _ ipn.StateStore = (*stateStore)(nil)

func newStateStore(initial map[string]string, onWrite func(string, any) error) (*stateStore, error) {
	s := &stateStore{values: make(map[ipn.StateKey][]byte), onWrite: onWrite}
	for key, value := range initial {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 state for key %q", key)
		}
		s.values[ipn.StateKey(key)] = decoded
	}
	return s, nil
}

func (s *stateStore) ReadState(key ipn.StateKey) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return bytes.Clone(value), nil
}

func (s *stateStore) WriteState(key ipn.StateKey, value []byte) error {
	var encoded any
	s.mu.Lock()
	if value == nil {
		delete(s.values, key)
	} else {
		s.values[key] = bytes.Clone(value)
		encoded = base64.StdEncoding.EncodeToString(value)
	}
	s.mu.Unlock()
	// JS may synchronously reenter Go. Never invoke it with the map locked.
	if s.onWrite != nil {
		return s.onWrite(string(key), encoded)
	}
	return nil
}
