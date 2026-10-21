// Package golinkclient accesses an existing golink server over an injected HTTP transport.
package golinkclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client sends requests to Host, an authority such as go or go.example.ts.net.
// HTTP may provide a Tailscale transport. A nil HTTP uses http.DefaultClient.
// Requests never follow redirects or change the caller's HTTP client.
type Client struct {
	HTTP *http.Client
	Host string
}

// Link is a record from golink's streamed JSON export.
type Link struct {
	Short string `json:"short"`
	Long  string `json:"long"`
	Owner string `json:"owner"`
}

// Result identifies a destination, a missing link, or a golink web UI path.
type Result struct {
	Redirect string
	NotFound bool
	GolinkUI string
}

// Error reports an http, unreachable, or timeout failure.
type Error struct {
	Kind    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Resolve returns golink's redirect without requesting the destination.
// path contains the raw remainder and query, without a leading slash.
func (c *Client) Resolve(ctx context.Context, path string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusFound:
		location := resp.Header.Get("Location")
		u, err := url.Parse(location)
		if err != nil || location == "" {
			return Result{}, &Error{Kind: "http", Message: "missing or malformed redirect Location"}
		}
		if u.IsAbs() {
			if (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) && u.Host == "" {
				return Result{}, &Error{Kind: "http", Message: "missing host in redirect Location"}
			}
			return Result{Redirect: location}, nil
		}
		if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "//") {
			return Result{GolinkUI: location}, nil
		}
		return Result{}, &Error{Kind: "http", Message: "redirect Location must be absolute or a golink UI path"}
	case http.StatusNotFound:
		return Result{NotFound: true}, nil
	default:
		return Result{}, responseError(resp)
	}
}

// Save creates or updates a link using golink's form API.
func (c *Client) Save(ctx context.Context, short, long string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	form := url.Values{"short": {short}, "long": {long}}
	resp, err := c.request(ctx, http.MethodPost, "", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseError(resp)
	}
	return nil
}

// Links reads all JSON records from golink's export endpoint.
func (c *Client) Links(ctx context.Context) ([]Link, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := c.request(ctx, http.MethodGet, ".export", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, responseError(resp)
	}
	links := []Link{}
	decoder := json.NewDecoder(exportReader{resp.Body})
	for {
		var link Link
		if err := decoder.Decode(&link); err != nil {
			if errors.Is(err, io.EOF) {
				return links, nil
			}
			var readErr *Error
			if errors.As(err, &readErr) {
				return nil, readErr
			}
			return nil, &Error{Kind: "http", Message: "decode golink export: " + err.Error()}
		}
		links = append(links, link)
	}
}

// Classify body read failures before decoding, so malformed JSON ending at EOF
// remains an HTTP error while stream failures retain their transport error kind.
type exportReader struct{ io.Reader }

func (r exportReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		return n, transportError(err)
	}
	return n, err
}

func (c *Client) request(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	if err := validateHost(c.Host); err != nil {
		return nil, &Error{Kind: "http", Message: err.Error()}
	}
	if strings.Contains(path, "#") {
		return nil, &Error{Kind: "http", Message: "request path must not contain a fragment"}
	}
	// Concatenation preserves escaped paths, repeated slashes, and raw queries.
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Host+"/"+path, body)
	if err != nil {
		return nil, &Error{Kind: "http", Message: err.Error()}
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Sec-Golink", "1")
	}
	hc := *http.DefaultClient
	if c.HTTP != nil {
		hc = *c.HTTP
	}
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	transport := hc.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	hc.Transport = locationTransport{transport}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, transportError(err)
	}
	return resp, nil
}

func validateHost(host string) error {
	u, err := url.Parse("http://" + host)
	if err != nil || host == "" || u.Host != host || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("invalid golink host %q", host)
	}
	if strings.Contains(host, ":") {
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			if net.ParseIP(u.Hostname()) == nil {
				return fmt.Errorf("invalid golink host %q", host)
			}
		} else {
			name, port, err := net.SplitHostPort(host)
			portNumber, portErr := strconv.Atoi(port)
			if err != nil || portErr != nil || portNumber < 0 || portNumber > 65535 || (strings.Contains(name, ":") && net.ParseIP(name) == nil) {
				return fmt.Errorf("invalid golink host %q", host)
			}
		}
	}
	if strings.ContainsAny(host, "[]") && net.ParseIP(u.Hostname()) == nil {
		return fmt.Errorf("invalid golink host %q", host)
	}
	return nil
}

// net/http parses Location before CheckRedirect. Classify malformed headers here
// so its parsing error cannot be mistaken for a failure to reach golink.
type locationTransport struct{ http.RoundTripper }

func (t locationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.RoundTripper.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		if _, err := url.Parse(resp.Header.Get("Location")); err != nil {
			resp.Body.Close()
			return nil, &Error{Kind: "http", Message: "malformed redirect Location: " + err.Error()}
		}
	}
	return resp, nil
}

func responseError(resp *http.Response) error {
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return transportError(err)
	}
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = fmt.Sprintf("HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	return &Error{Kind: "http", Message: message}
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout())
}

func transportError(err error) error {
	var clientErr *Error
	if errors.As(err, &clientErr) {
		return clientErr
	}
	kind := "unreachable"
	if isTimeout(err) {
		kind = "timeout"
	}
	return &Error{Kind: kind, Message: err.Error()}
}
