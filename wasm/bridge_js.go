//go:build js

// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"golink-chrome-extension/golinkclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnauth"
)

type callbacks struct {
	functions map[string]js.Value
	fatalOnce sync.Once
}

func readCallbacks(value js.Value) (*callbacks, error) {
	if value.Type() != js.TypeObject || value.IsNull() {
		return nil, errors.New("callbacks must be an object")
	}
	result := &callbacks{functions: make(map[string]js.Value)}
	for _, name := range []string{"onState", "onBrowseToURL", "onStateWrite", "onFatal"} {
		fn := value.Get(name)
		if fn.Type() != js.TypeFunction {
			return nil, fmt.Errorf("callbacks.%s must be a function", name)
		}
		result.functions[name] = fn
	}
	return result, nil
}

func (c *callbacks) fatal(message string) {
	if c == nil {
		return
	}
	// A document already marked fatal will be replaced. Report it once so an
	// error passing through multiple handlers does not spend the crash budget.
	c.fatalOnce.Do(func() {
		// A throwing error handler must not take down the Go runtime.
		defer func() { recover() }()
		c.functions["onFatal"].Invoke(message)
	})
}

func (c *callbacks) call(name string, args ...any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%s callback failed: %v", name, r)
			c.fatal(err.Error())
		}
	}()
	c.functions[name].Invoke(args...)
	return nil
}

func readConfig(value js.Value) (nodeConfig, error) {
	config := nodeConfig{golinkHost: "go", controlURL: ipn.DefaultControlURL, state: make(map[string]string)}
	if value.Type() != js.TypeObject || value.IsNull() {
		return config, errors.New("config must be an object")
	}
	for _, field := range []struct {
		name string
		dst  *string
	}{
		{"hostname", &config.hostname}, {"golinkHost", &config.golinkHost},
		{"controlURL", &config.controlURL}, {"authKey", &config.authKey},
	} {
		v := value.Get(field.name)
		if v.IsUndefined() {
			continue
		}
		if v.Type() != js.TypeString {
			return config, fmt.Errorf("config.%s must be a string", field.name)
		}
		*field.dst = v.String()
	}
	if strings.TrimSpace(config.hostname) == "" {
		return config, errors.New("config.hostname is required")
	}
	host, err := url.Parse("http://" + config.golinkHost)
	if err != nil || config.golinkHost == "" || host.Host != config.golinkHost || host.Hostname() == "" || host.User != nil || host.Path != "" || host.RawQuery != "" || host.Fragment != "" {
		return config, errors.New("config.golinkHost must be a host authority")
	}
	control, err := url.Parse(config.controlURL)
	if err != nil || (control.Scheme != "https" && control.Scheme != "http") || control.Host == "" || control.User != nil {
		return config, errors.New("config.controlURL must be an HTTP or HTTPS URL")
	}
	state := value.Get("state")
	if !state.IsUndefined() {
		if state.Type() != js.TypeObject || state.IsNull() || js.Global().Get("Array").Call("isArray", state).Bool() {
			return config, errors.New("config.state must be an object of base64 strings")
		}
		keys := js.Global().Get("Object").Call("keys", state)
		for i := 0; i < keys.Length(); i++ {
			key := keys.Index(i).String()
			v := state.Get(key)
			if v.Type() != js.TypeString {
				return config, errors.New("config.state values must be base64 strings")
			}
			config.state[key] = v.String()
		}
	}
	return config, nil
}

type application struct {
	mu        sync.Mutex
	node      *node
	starting  bool
	callbacks *callbacks
}

func (a *application) fatal(message string) {
	a.mu.Lock()
	callbacks := a.callbacks
	a.mu.Unlock()
	callbacks.fatal(message)
}

func (a *application) start(args []js.Value) (any, error) {
	if len(args) != 2 {
		return nil, errors.New("usage: start(config, callbacks)")
	}
	callbacks, err := readCallbacks(args[1])
	if err != nil {
		return nil, err
	}
	config, err := readConfig(args[0])
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.node != nil || a.starting {
		a.mu.Unlock()
		return nil, errors.New("node is already started or starting")
	}
	a.starting = true
	a.callbacks = callbacks
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.starting = false; a.mu.Unlock() }()
	node, err := newNode(config, callbacks)
	if err != nil {
		callbacks.fatal(err.Error())
		return nil, err
	}
	a.mu.Lock()
	a.node = node
	a.mu.Unlock()
	return map[string]any{"ok": true}, nil
}

func stringArgs(args []js.Value, count int, usage string) ([]string, error) {
	if len(args) != count {
		return nil, fmt.Errorf("usage: %s", usage)
	}
	values := make([]string, count)
	for i, arg := range args {
		if arg.Type() != js.TypeString {
			return nil, fmt.Errorf("usage: %s; arguments must be strings", usage)
		}
		values[i] = arg.String()
	}
	return values, nil
}

func (a *application) call(method string, args []js.Value) (any, error) {
	if method == "start" {
		return a.start(args)
	}
	a.mu.Lock()
	n := a.node
	a.mu.Unlock()
	if n == nil {
		return nil, errors.New("node is not started")
	}
	ctx := context.Background()
	switch method {
	case "login", "logout", "status", "links":
		if len(args) != 0 {
			return nil, fmt.Errorf("usage: %s()", method)
		}
	}
	switch method {
	case "login":
		if err := n.lb.StartLoginInteractive(ctx); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "logout":
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := n.lb.Logout(ctx, ipnauth.Self); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "status":
		return n.status(), nil
	case "resolve":
		values, err := stringArgs(args, 1, "resolve(path)")
		if err != nil {
			return nil, err
		}
		result, err := n.client.Resolve(ctx, values[0])
		if err != nil {
			return nil, err
		}
		switch {
		case result.NotFound:
			return map[string]any{"notFound": true}, nil
		case result.GolinkUI != "":
			return map[string]any{"golinkUI": result.GolinkUI}, nil
		default:
			return map[string]any{"redirect": result.Redirect}, nil
		}
	case "save":
		values, err := stringArgs(args, 2, "save(short, long)")
		if err != nil {
			return nil, err
		}
		if err := n.client.Save(ctx, values[0], values[1]); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "links":
		links, err := n.client.Links(ctx)
		if err != nil {
			return nil, err
		}
		result := make([]any, len(links))
		for i, link := range links {
			result[i] = map[string]any{"short": link.Short, "long": link.Long, "owner": link.Owner}
		}
		return result, nil
	default:
		return nil, errors.New("unknown node method")
	}
}

// Promise helper adapted from cmd/tsconnect/wasm/wasm_js.go. The executor
// returns immediately and is released after construction; exported API funcs
// live in exportedFuncs. No bridge work blocks a syscall/js callback.
func makePromise(work func() (any, error), fatal func(string)) js.Value {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer func() {
				if r := recover(); r != nil {
					message := fmt.Sprintf("bridge panic: %v", r)
					fatal(message)
					reject.Invoke(js.Global().Get("Error").New(message))
				}
			}()
			result, err := work()
			if err == nil {
				resolve.Invoke(result)
				return
			}
			var clientErr *golinkclient.Error
			if errors.As(err, &clientErr) {
				resolve.Invoke(map[string]any{"error": clientErr.Message, "kind": clientErr.Kind})
				return
			}
			reject.Invoke(js.Global().Get("Error").New(err.Error()))
		}()
		return nil
	})
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}
