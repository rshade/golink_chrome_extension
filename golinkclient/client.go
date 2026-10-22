// Package golinkclient accesses an existing golink server over an injected HTTP transport.
package golinkclient

import (
	"bytes"
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
	"sync"
	"time"
)

// Client sends requests to Host, an authority such as go or go.example.ts.net.
// HTTP may provide a Tailscale transport. A nil HTTP uses http.DefaultClient.
// Requests never follow link redirects or change the caller's HTTP client.
// When golink's plaintext listener only redirects to its HTTPS name, the client
// switches to that origin for the rest of its lifetime.
type Client struct {
	HTTP *http.Client
	Host string

	mu     sync.Mutex
	origin string // scheme://authority after an HTTPS upgrade
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

// Error reports an http, exists, loop, unreachable, or timeout failure.
type Error struct {
	Kind    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// maxAliasHops bounds golink links whose targets name another go link.
const maxAliasHops = 10

// Resolve returns golink's redirect without requesting the destination.
// path contains the raw remainder and query, without a leading slash.
// Relative redirects outside golink's "/." namespace are aliases to other go
// links and are followed here, as a browser would.
func (c *Client) Resolve(ctx context.Context, path string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for hop := 0; ; hop++ {
		result, alias, err := c.resolveOnce(ctx, path)
		if err != nil || alias == "" {
			return result, err
		}
		if hop == maxAliasHops {
			return Result{}, &Error{Kind: "loop", Message: "too many go link aliases"}
		}
		path = alias
	}
}

func (c *Client) resolveOnce(ctx context.Context, path string) (_ Result, alias string, _ error) {
	resp, err := c.request(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return Result{}, "", err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusFound:
		location := resp.Header.Get("Location")
		u, err := url.Parse(location)
		if err != nil || location == "" {
			return Result{}, "", &Error{Kind: "http", Message: "missing or malformed redirect Location"}
		}
		if u.IsAbs() {
			if (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) && u.Host == "" {
				return Result{}, "", &Error{Kind: "http", Message: "missing host in redirect Location"}
			}
			return Result{Redirect: location}, "", nil
		}
		if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "//") {
			// golink serves its own pages under "/."; any other path is a go link.
			if strings.HasPrefix(location, "/.") {
				return Result{GolinkUI: location}, "", nil
			}
			return Result{}, strings.TrimPrefix(location, "/"), nil
		}
		return Result{}, "", &Error{Kind: "http", Message: "redirect Location must be absolute or a golink UI path"}
	case resp.StatusCode == http.StatusNotFound:
		return Result{NotFound: true}, "", nil
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		// golink rendered one of its own pages, such as the home page for "/".
		return Result{GolinkUI: "/" + path}, "", nil
	default:
		return Result{}, "", responseError(resp)
	}
}

// Lookup returns the stored link for short, or nil if golink has none.
func (c *Client) Lookup(ctx context.Context, short string) (*Link, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	path := ".detail/" + url.PathEscape(short)
	// golink redirects a non-canonical spelling, such as a different case, once.
	for range 2 {
		resp, err := c.request(ctx, http.MethodGet, path, nil, http.Header{"Accept": {"application/json"}})
		if err != nil {
			return nil, err
		}
		switch resp.StatusCode {
		case http.StatusNotFound:
			resp.Body.Close()
			return nil, nil
		case http.StatusFound:
			location := resp.Header.Get("Location")
			resp.Body.Close()
			if !strings.HasPrefix(location, "/.detail/") {
				return nil, &Error{Kind: "http", Message: "unexpected link detail redirect"}
			}
			path = strings.TrimPrefix(location, "/")
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, responseError(resp)
		}
		var link Link
		if err := json.NewDecoder(exportReader{resp.Body}).Decode(&link); err != nil {
			var readErr *Error
			if errors.As(err, &readErr) {
				return nil, readErr
			}
			return nil, &Error{Kind: "http", Message: "decode golink link detail: " + err.Error()}
		}
		return &link, nil
	}
	return nil, &Error{Kind: "http", Message: "too many link detail redirects"}
}

// Ping reports whether golink answers a cheap request.
func (c *Client) Ping(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := c.request(ctx, http.MethodGet, ".opensearch", nil, nil)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// Save creates a link using golink's form API. The Sec-Golink header that
// authorizes API saves also skips golink's own check against overwriting an
// existing link, so Save checks first and returns an "exists" Error unless
// overwrite is set.
func (c *Client) Save(ctx context.Context, short, long string, overwrite bool) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if !overwrite {
		existing, err := c.Lookup(ctx, short)
		if err != nil {
			return err
		}
		if existing != nil {
			return &Error{Kind: "exists", Message: fmt.Sprintf("go/%s already points to %s", existing.Short, existing.Long)}
		}
	}
	form := url.Values{"short": {short}, "long": {long}}
	resp, err := c.request(ctx, http.MethodPost, "", []byte(form.Encode()), nil)
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
	resp, err := c.request(ctx, http.MethodGet, ".export", nil, nil)
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

func (c *Client) request(ctx context.Context, method, path string, body []byte, header http.Header) (*http.Response, error) {
	if err := validateHost(c.Host); err != nil {
		return nil, &Error{Kind: "http", Message: err.Error()}
	}
	if strings.Contains(path, "#") {
		return nil, &Error{Kind: "http", Message: "request path must not contain a fragment"}
	}
	path = escapeQuery(path)
	c.mu.Lock()
	origin := c.origin
	c.mu.Unlock()
	upgraded := origin != ""
	if !upgraded {
		origin = "http://" + c.Host
	}
	for {
		resp, err := c.send(ctx, method, origin+"/"+path, body, header)
		if err != nil || upgraded {
			return resp, err
		}
		next, ok := c.httpsUpgrade(resp)
		if !ok {
			return resp, nil
		}
		resp.Body.Close()
		c.mu.Lock()
		c.origin = next
		c.mu.Unlock()
		origin, upgraded = next, true
	}
}

func (c *Client) send(ctx context.Context, method, rawURL string, body []byte, header http.Header) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	// Concatenation preserves escaped paths, repeated slashes, and raw queries.
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, &Error{Kind: "http", Message: err.Error()}
	}
	for key, values := range header {
		req.Header[key] = values
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

// httpsUpgrade recognizes golink's RedirectHandler, which answers every
// plaintext request with a 302 to the same path on its HTTPS name. Unlike link
// redirects, those responses lack golink's Referrer-Policy header, and they
// name golink's own host, such as go.example.ts.net for the bare host go.
func (c *Client) httpsUpgrade(resp *http.Response) (string, bool) {
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Referrer-Policy") != "" {
		return "", false
	}
	u, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", false
	}
	req := resp.Request
	if req == nil || u.Path != req.URL.Path || u.RawQuery != req.URL.RawQuery {
		return "", false
	}
	host, want := strings.ToLower(u.Hostname()), strings.ToLower(req.URL.Hostname())
	if host != want && (strings.Contains(want, ".") || !strings.HasPrefix(host, want+".")) {
		return "", false
	}
	return "https://" + u.Host, true
}

// escapeQuery percent-encodes bytes that cannot appear literally in an HTTP
// request line. net/url leaves RawQuery as given, so omnibox text such as
// "q=hello world" would otherwise produce a malformed request.
func escapeQuery(path string) string {
	name, query, ok := strings.Cut(path, "?")
	if !ok {
		return path
	}
	var b strings.Builder
	for i := 0; i < len(query); i++ {
		if ch := query[i]; ch <= ' ' || ch >= 0x7f || ch == '"' || ch == '<' || ch == '>' {
			fmt.Fprintf(&b, "%%%02X", ch)
		} else {
			b.WriteByte(ch)
		}
	}
	return name + "?" + b.String()
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
