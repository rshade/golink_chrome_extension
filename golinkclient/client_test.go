package golinkclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	golink "github.com/tailscale/golink"
)

func realClient(t *testing.T) *Client {
	t.Helper()
	db, err := golink.NewSQLiteDB(filepath.Join(t.TempDir(), "golink.db"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := golink.New(golink.Options{DB: db, Dev: true})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &Client{HTTP: ts.Client(), Host: u.Host}
}

func TestSaveResolveAndExport(t *testing.T) {
	c := realClient(t)
	ctx := context.Background()
	const target = "https://example.com/a%2Fb?q=x%2By#section"
	if err := c.Save(ctx, "docs", target); err != nil {
		t.Fatal(err)
	}
	got, err := c.Resolve(ctx, "docs")
	if err != nil || got.Redirect != target {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
	detail, err := c.Resolve(ctx, "docs+")
	if err != nil || detail.GolinkUI != "/.detail/docs" {
		t.Fatalf("detail = %+v, %v", detail, err)
	}
	missing, err := c.Resolve(ctx, "missing")
	if err != nil || !missing.NotFound {
		t.Fatalf("missing = %+v, %v", missing, err)
	}
	if err := c.Save(ctx, "home", "https://example.net/"); err != nil {
		t.Fatal(err)
	}
	links, err := c.Links(ctx)
	if err != nil || len(links) != 2 {
		t.Fatalf("Links = %+v, %v", links, err)
	}
	byShort := map[string]Link{}
	for _, link := range links {
		byShort[link.Short] = link
	}
	if byShort["docs"].Long != target || byShort["home"].Long != "https://example.net/" || byShort["docs"].Owner == "" || byShort["home"].Owner == "" {
		t.Fatalf("Links = %+v", links)
	}
}

// These tests catch redirect following, request normalization, missing protocol
// headers, unbounded error reads, truncated exports, and incorrect error kinds.
func TestTemplatePathAndQuery(t *testing.T) {
	c := realClient(t)
	if err := c.Save(context.Background(), "tmpl", "https://example.com/{{.Path}}"); err != nil {
		t.Fatal(err)
	}
	got, err := c.Resolve(context.Background(), "tmpl/a%2Fb?x=1&x=2")
	if err != nil || got.Redirect != "https://example.com/a/b?x=1&x=2" {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
}

func stubClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	s := httptest.NewServer(handler)
	t.Cleanup(s.Close)
	u, err := url.Parse(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &Client{HTTP: s.Client(), Host: u.Host}
}

func assertKind(t *testing.T, err error, kind string) *Error {
	t.Helper()
	var got *Error
	if !errors.As(err, &got) || got.Kind != kind {
		t.Fatalf("error = %#v; want *Error kind %q", err, kind)
	}
	if got.Message == "" || got.Error() != got.Message {
		t.Fatalf("empty or inconsistent error message: %+v", got)
	}
	return got
}

func TestDoesNotFollowRedirect(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer target.Close()
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL+"/a%2Fb?x=1&x=2")
		w.WriteHeader(302)
	})
	callerRedirects := 0
	c.HTTP.CheckRedirect = func(*http.Request, []*http.Request) error { callerRedirects++; return nil }
	got, err := c.Resolve(context.Background(), "foo")
	if err != nil || got.Redirect != target.URL+"/a%2Fb?x=1&x=2" || hits != 0 || callerRedirects != 0 {
		t.Fatalf("result=%+v error=%v destination hits=%d caller redirects=%d", got, err, hits, callerRedirects)
	}
	if err := c.HTTP.CheckRedirect(nil, nil); err != nil || callerRedirects != 1 {
		t.Fatal("caller CheckRedirect was mutated")
	}
}

func TestResolvePreservesRequestURI(t *testing.T) {
	const path = "a%2fb/../c//d%3Fe?q=x%2By&x=2&x=1"
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.RequestURI != "/"+path {
			t.Errorf("RequestURI = %q", r.RequestURI)
		}
		w.WriteHeader(404)
	})
	got, err := c.Resolve(context.Background(), path)
	if err != nil || !got.NotFound {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
}

func TestResolveRejectsInvalidResponses(t *testing.T) {
	for _, tt := range []struct {
		name, location string
		status         int
	}{
		{"missing location", "", 302},
		{"malformed location", "/bad%zz", 302},
		{"malformed permanent redirect", "/bad%zz", 301},
		{"relative location", "detail/foo", 302},
		{"protocol relative location", "//other.example/foo", 302},
		{"missing absolute host", "https://", 302},
		{"unexpected success", "", 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
				if tt.location != "" {
					w.Header().Set("Location", tt.location)
				}
				w.WriteHeader(tt.status)
			})
			_, err := c.Resolve(context.Background(), "foo")
			assertKind(t, err, "http")
		})
	}
}

func TestResolveAbsoluteSchemeIsReturnedUnchanged(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "custom:example%2Fvalue#part")
		w.WriteHeader(302)
	})
	got, err := c.Resolve(context.Background(), "foo")
	if err != nil || got.Redirect != "custom:example%2Fvalue#part" {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
}

func TestSaveFormAndHeaders(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || r.Header.Get("Sec-Golink") != "1" {
			t.Errorf("headers = %v", r.Header)
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.PostForm.Get("short") != "some link+" || r.PostForm.Get("long") != "https://example.com/a%2Fb?q=a+b&x=2#f" {
			t.Errorf("form = %v", r.PostForm)
		}
		w.WriteHeader(204)
	})
	if err := c.Save(context.Background(), "some link+", "https://example.com/a%2Fb?q=a+b&x=2#f"); err != nil {
		t.Fatal(err)
	}
}

func TestSaveRejectsRedirect(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/saved")
		w.WriteHeader(302)
	})
	assertKind(t, c.Save(context.Background(), "foo", "https://example.com"), "http")
}

var operations = []struct {
	name string
	call func(context.Context, *Client) error
}{
	{"Resolve", func(ctx context.Context, c *Client) error { _, err := c.Resolve(ctx, "foo"); return err }},
	{"Save", func(ctx context.Context, c *Client) error { return c.Save(ctx, "foo", "https://example.com") }},
	{"Links", func(ctx context.Context, c *Client) error { _, err := c.Links(ctx); return err }},
}

func TestHTTPErrorBody(t *testing.T) {
	for _, op := range operations {
		t.Run(op.name, func(t *testing.T) {
			c := stubClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); io.WriteString(w, " broken\n") })
			got := assertKind(t, op.call(context.Background(), c), "http")
			if got.Message != "broken" {
				t.Fatalf("Message = %q", got.Message)
			}
		})
	}
}

func TestCallerDeadline(t *testing.T) {
	for _, op := range operations {
		t.Run(op.name, func(t *testing.T) {
			c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				<-r.Context().Done()
			})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			assertKind(t, op.call(ctx, c), "timeout")
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type timeoutError struct{}

func (timeoutError) Error() string   { return "socket timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestTransportErrors(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
		kind string
	}{
		{"dial", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("no route")}, "unreachable"},
		{"deadline", fmt.Errorf("wrapped: %w", context.DeadlineExceeded), "timeout"},
		{"socket timeout", timeoutError{}, "timeout"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := &Client{Host: "go", HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, tt.err })}}
			for _, op := range operations {
				assertKind(t, op.call(context.Background(), c), tt.kind)
			}
		})
	}
}

func TestLinksExport(t *testing.T) {
	long := "https://example.com/" + strings.Repeat("x", 128*1024)
	for _, tt := range []struct {
		name, body string
		want       int
		bad        bool
	}{
		{"empty", "\n", 0, false},
		{"large record", fmt.Sprintf("{\"Short\":\"big\",\"Long\":%q,\"Owner\":\"owner@example.com\"}\n", long), 1, false},
		{"malformed record", "{\"Short\":\"ok\"}\n{broken}", 0, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/.export" || r.Method != "GET" {
					t.Errorf("request = %s %s", r.Method, r.URL)
				}
				io.WriteString(w, tt.body)
			})
			got, err := c.Links(context.Background())
			if tt.bad {
				assertKind(t, err, "http")
				return
			}
			if err != nil || got == nil || len(got) != tt.want {
				t.Fatalf("Links = %v, %v", got, err)
			}
			if tt.want > 0 && (got[0].Long != long || got[0].Short != "big" || got[0].Owner != "owner@example.com") {
				t.Fatalf("unexpected record: short=%q owner=%q long length=%d", got[0].Short, got[0].Owner, len(got[0].Long))
			}
		})
	}
}

func TestRejectsMalformedHosts(t *testing.T) {
	for _, host := range []string{"", "http://go", "go/path", "go?query", "go#frag", "user@go", "go:bad", "go:", "go:65536", "go host", "[not-ip]", "2001:db8::1"} {
		t.Run(host, func(t *testing.T) {
			c := &Client{Host: host, HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				t.Error("malformed host reached transport")
				return nil, errors.New("unexpected request")
			})}}
			for _, op := range operations {
				assertKind(t, op.call(context.Background(), c), "http")
			}
		})
	}
}

func TestRejectsRequestFragments(t *testing.T) {
	c := &Client{Host: "go", HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("fragment reached transport")
		return nil, errors.New("unexpected request")
	})}}
	for _, path := range []string{"foo#fragment", "foo#", "foo%zz"} {
		_, err := c.Resolve(context.Background(), path)
		assertKind(t, err, "http")
	}
}

func TestDefaultClientIsCopied(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) })
	c.HTTP = nil
	got, err := c.Resolve(context.Background(), "foo")
	if err != nil || !got.NotFound {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
	if http.DefaultClient.CheckRedirect != nil {
		t.Fatal("default client was mutated")
	}
}

type trackingBody struct {
	io.Reader
	read   int
	closed bool
}

func (b *trackingBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.read += n
	return n, err
}
func (b *trackingBody) Close() error { b.closed = true; return nil }

func TestBodiesAreClosedAndHTTPErrorsAreBounded(t *testing.T) {
	for _, op := range operations {
		for _, status := range []int{200, 302, 404, 500} {
			t.Run(fmt.Sprintf("%s/%d", op.name, status), func(t *testing.T) {
				body := &trackingBody{Reader: strings.NewReader(strings.Repeat("x", 128*1024))}
				c := &Client{Host: "go", HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: status, Header: http.Header{}, Body: body}, nil
				})}}
				err := op.call(context.Background(), c)
				if !body.closed {
					t.Fatal("response body was not closed")
				}
				if status == 500 {
					got := assertKind(t, err, "http")
					if body.read > 64*1024 || len(got.Message) != 64*1024 {
						t.Fatalf("read=%d message length=%d", body.read, len(got.Message))
					}
				}
			})
		}
	}
}
