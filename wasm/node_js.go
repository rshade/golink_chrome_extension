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
	"time"

	"golink-chrome-extension/golinkclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/logpolicy"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
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
}

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
	lb.SetNotifyCallback(func(n ipn.Notify) {
		defer func() {
			if r := recover(); r != nil {
				callbacks.fatal(fmt.Sprintf("backend notification panic: %v", r))
			}
		}()
		if n.State != nil {
			callbacks.call("onState", n.State.String())
		}
		if n.BrowseToURL != nil {
			callbacks.call("onBrowseToURL", *n.BrowseToURL)
		}
	})
	if err := callbacks.call("onState", ipn.NoState.String()); err != nil {
		return nil, err
	}
	if err := lb.Start(ipn.Options{
		UpdatePrefs: &ipn.Prefs{
			ControlURL:  config.controlURL,
			RouteAll:    false,
			WantRunning: true,
			Hostname:    config.hostname,
		},
		AuthKey: config.authKey,
	}); err != nil {
		return nil, fmt.Errorf("start backend: %w", err)
	}
	httpClient := &http.Client{
		Transport:     &http.Transport{DialContext: dialer.UserDial, Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &node{lb: lb, client: &golinkclient.Client{HTTP: httpClient, Host: config.golinkHost}, hostname: config.hostname}, nil
}

func (n *node) status() map[string]any {
	status := n.lb.StatusWithoutPeers()
	result := map[string]any{
		"state": status.BackendState, "loginName": "", "tailnet": "",
		"hostname": n.hostname, "golinkReachable": false,
	}
	if status.Self != nil {
		result["loginName"] = status.User[status.Self.UserID].LoginName
	}
	if status.CurrentTailnet != nil {
		result["tailnet"] = status.CurrentTailnet.Name
	}
	if status.BackendState == ipn.Running.String() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+n.client.Host+"/", nil)
		if err == nil {
			resp, err := n.client.HTTP.Do(req)
			if err == nil {
				resp.Body.Close()
				result["golinkReachable"] = resp.StatusCode >= 200 && resp.StatusCode < 300
			}
		}
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
