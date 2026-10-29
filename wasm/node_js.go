//go:build js

// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

// Node setup and logging transport adapted from tailscale.com v1.104.2,
// cmd/tsconnect/wasm/wasm_js.go. See THIRD_PARTY_NOTICES.md.
import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golink-chrome-extension/golinkclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/logpolicy"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/net/tlsdial"
	"tailscale.com/net/tsdial"
	"tailscale.com/tsd"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

type nodeConfig struct {
	hostname, golinkHost, controlURL, authKey string
	state                                     map[string]string
}

type node struct {
	lb       *ipnlocal.LocalBackend
	client   *golinkclient.Client
	hostname string
	errors   *lastError
}

// lastError keeps the backend's most recent user-visible error, such as a
// rejected auth key, which arrives only as Notify.ErrMessage.
type lastError struct {
	mu      sync.Mutex
	message string
}

func (e *lastError) set(message string) { e.mu.Lock(); e.message = message; e.mu.Unlock() }
func (e *lastError) get() string        { e.mu.Lock(); defer e.mu.Unlock(); return e.message }

func newNode(config nodeConfig, callbacks *callbacks) (_ *node, err error) {
	store, err := newStateStore(config.state, func(key string, value any) error {
		return callbacks.call("onStateWrite", key, value)
	})
	if err != nil {
		return nil, err
	}
	netns.SetEnabled(false)
	lpc, err := getOrCreateLogPolicyConfig(store)
	if err != nil {
		return nil, err
	}
	logger := logtail.NewLogger(logtail.Config{
		Collection:   lpc.Collection,
		PrivateID:    lpc.PrivateID,
		CompressLogs: false,
		HTTPC:        &http.Client{Transport: &noCORSTransport{http.DefaultTransport}},
	}, log.Printf)
	// A failed initialization must not leave its engine or logger running.
	cleanup := []func(){func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		logger.Shutdown(ctx)
	}}
	defer func() {
		if err != nil {
			for i := len(cleanup) - 1; i >= 0; i-- {
				cleanup[i]()
			}
		}
	}()
	logf := logger.Logf
	sys := tsd.NewSystem()
	sys.Set(store)
	dialer := &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	cleanup = append(cleanup, func() { dialer.Close() })
	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs:  sys.ExtraRootCAs,
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		return nil, fmt.Errorf("create engine: %w", err)
	}
	cleanup = append(cleanup, eng.Close)
	sys.Set(eng)
	ns, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		return nil, fmt.Errorf("create netstack: %w", err)
	}
	cleanup = append(cleanup, func() { ns.Close() })
	sys.Set(ns)
	ns.ProcessLocalIPs = true
	ns.ProcessSubnets = true
	dialer.UseNetstackForIP = func(netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		conn, err := ns.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		conn, err := ns.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()
	// Ordinary interactive logins keep their identity across browser restarts.
	lb, err := ipnlocal.NewLocalBackend(logf, lpc.PublicID, sys, 0)
	if err != nil {
		return nil, fmt.Errorf("create backend: %w", err)
	}
	cleanup = append(cleanup, lb.Shutdown)
	if err := ns.Start(lb); err != nil {
		return nil, fmt.Errorf("start netstack: %w", err)
	}
	backendErrors := &lastError{}
	lb.SetNotifyCallback(func(n ipn.Notify) {
		defer func() {
			if r := recover(); r != nil {
				callbacks.fatal(fmt.Sprintf("backend notification panic: %v", r))
			}
		}()
		if n.ErrMessage != nil {
			message := *n.ErrMessage
			if config.authKey != "" {
				message = strings.ReplaceAll(message, config.authKey, "[auth key]")
			}
			backendErrors.set(message)
		}
		if n.State != nil {
			if *n.State == ipn.Running {
				backendErrors.set("")
			}
			callbacks.call("onState", n.State.String())
		}
		if n.BrowseToURL != nil {
			callbacks.call("onBrowseToURL", *n.BrowseToURL)
		}
	})
	if err := callbacks.call("onState", ipn.NoState.String()); err != nil {
		return nil, err
	}
	// Logout persists LoggedOut before asking control to expire the key. If that
	// request fails, the registered identity remains; keep it logged out so the
	// next start does not silently log back in. Interactive login clears
	// LoggedOut. New profiles also default to LoggedOut, but have no node ID.
	prefs := lb.Prefs()
	loggedOut := prefs.LoggedOut() && prefs.Persist().Valid() && prefs.Persist().NodeID() != ""
	if err := lb.Start(ipn.Options{
		UpdatePrefs: &ipn.Prefs{
			ControlURL:  config.controlURL,
			RouteAll:    false,
			WantRunning: !loggedOut,
			LoggedOut:   loggedOut,
			Hostname:    config.hostname,
		},
		AuthKey: config.authKey,
	}); err != nil {
		return nil, fmt.Errorf("start backend: %w", err)
	}
	// Start only registers a node that already has a key. As in tailscale up,
	// a new node must start a login, which uses the auth key without a URL.
	if config.authKey != "" {
		if err := lb.StartLoginInteractive(context.Background()); err != nil {
			return nil, fmt.Errorf("start auth key login: %w", err)
		}
	}
	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: dialer.UserDial,
			Proxy:       nil,
			// golink's HTTPS listener uses a Let's Encrypt certificate. js/wasm has no
			// system roots, so tlsdial needs the baked-in roots, which wasmtags keeps.
			TLSClientConfig: tlsdial.Config(sys.HealthTracker.Get(), nil),
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &node{lb: lb, client: &golinkclient.Client{HTTP: httpClient, Host: config.golinkHost}, hostname: config.hostname, errors: backendErrors}, nil
}

func (n *node) status() map[string]any {
	status := n.lb.StatusWithoutPeers()
	result := map[string]any{
		"state": status.BackendState, "loginName": "", "tailnet": "",
		"hostname": n.hostname, "golinkReachable": false, "backendError": n.errors.get(),
	}
	if status.Self != nil {
		result["loginName"] = status.User[status.Self.UserID].LoginName
	}
	if status.CurrentTailnet != nil {
		result["tailnet"] = status.CurrentTailnet.Name
	}
	if status.BackendState == ipn.Running.String() {
		result["golinkReachable"] = n.client.Ping(context.Background())
	}
	return result
}

const logPolicyStateKey = "log-policy"

func getOrCreateLogPolicyConfig(store ipn.StateStore) (*logpolicy.Config, error) {
	if data, err := store.ReadState(logPolicyStateKey); err == nil {
		if config, err := logpolicy.ConfigFromBytes(data); err == nil {
			return config, nil
		}
	} else if err != ipn.ErrStateNotExist {
		return nil, err
	}
	config := logpolicy.NewConfig(logtail.CollectionNode)
	if err := store.WriteState(logPolicyStateKey, config.ToBytes()); err != nil {
		return nil, err
	}
	return config, nil
}

// Only Tailscale's log uploader uses browser fetch. Tailnet HTTP uses UserDial.
type noCORSTransport struct{ http.RoundTripper }

func (t *noCORSTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set("js.fetch:mode", "no-cors")
	resp, err := t.RoundTripper.RoundTrip(req)
	if err == nil {
		resp.StatusCode = http.StatusOK
		resp.Status = http.StatusText(http.StatusOK)
	}
	return resp, err
}
