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
	if err := c.Save(ctx, "docs", target, false); err != nil {
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
	if err := c.Save(ctx, "home", "https://example.net/", false); err != nil {
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
	if err := c.Save(context.Background(), "tmpl", "https://example.com/{{.Path}}", false); err != nil {
		t.Fatal(err)
	}
	got, err := c.Resolve(context.Background(), "tmpl/a%2Fb?x=1&x=2")
	if err != nil || got.Redirect != "https://example.com/a/b?x=1&x=2" {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
}

func TestResolveGolinkPages(t *testing.T) {
	c := realClient(t)
	for path, want := range map[string]string{"": "/", ".all": "/.all", ".help": "/.help"} {
		got, err := c.Resolve(context.Background(), path)
		if err != nil || got.GolinkUI != want {
			t.Errorf("Resolve(%q) = %+v, %v; want GolinkUI %q", path, got, err, want)
		}
	}
}

func TestResolveFollowsAliases(t *testing.T) {
	c := realClient(t)
	ctx := context.Background()
	for short, long := range map[string]string{"chat": "/meet", "meet": "https://meet.example/{{.Path}}", "a": "/b", "b": "/a"} {
		if err := c.Save(ctx, short, long, false); err != nil {
			t.Fatal(err)
		}
	}
	got, err := c.Resolve(ctx, "chat/room?x=1")
	if err != nil || got.Redirect != "https://meet.example/room?x=1" {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
	_, err = c.Resolve(ctx, "a")
	assertKind(t, err, "loop")
}

func TestSaveRefusesExistingLinks(t *testing.T) {
	c := realClient(t)
	ctx := context.Background()
	if err := c.Save(ctx, "docs", "https://example.com/old", false); err != nil {
		t.Fatal(err)
	}
	for _, short := range []string{"docs", "DOCS", "do-cs"} {
		got := assertKind(t, c.Save(ctx, short, "https://example.com/new", false), "exists")
		if !strings.Contains(got.Message, "https://example.com/old") {
			t.Fatalf("Message = %q", got.Message)
		}
	}
	if link, err := c.Lookup(ctx, "docs"); err != nil || link == nil || link.Long != "https://example.com/old" {
		t.Fatalf("Lookup = %+v, %v", link, err)
	}
	if err := c.Save(ctx, "docs", "https://example.com/new", true); err != nil {
		t.Fatal(err)
	}
	if link, err := c.Lookup(ctx, "docs"); err != nil || link == nil || link.Long != "https://example.com/new" {
		t.Fatalf("Lookup after overwrite = %+v, %v", link, err)
	}
	if link, err := c.Lookup(ctx, "missing"); err != nil || link != nil {
		t.Fatalf("Lookup(missing) = %+v, %v", link, err)
	}
}

func TestPing(t *testing.T) {
	if !realClient(t).Ping(context.Background()) {
		t.Fatal("Ping = false for a live golink")
	}
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) })
	if c.Ping(context.Background()) {
		t.Fatal("Ping = true for a failing server")
	}
}

func TestQueryIsEscapedForTheRequestLine(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.RequestURI != "/search?q=hello%20world%22%C3%A9&x=a%2Bb" {
			t.Errorf("RequestURI = %q", r.RequestURI)
		}
		w.WriteHeader(404)
	})
	if got, err := c.Resolve(context.Background(), "search?q=hello world\"é&x=a%2Bb"); err != nil || !got.NotFound {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
}

// golink's default -https mode serves only RedirectHandler on port 80.
func TestHTTPSUpgrade(t *testing.T) {
	db, err := golink.NewSQLiteDB(filepath.Join(t.TempDir(), "golink.db"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := golink.New(golink.Options{DB: db, Dev: true})
	if err != nil {
		t.Fatal(err)
	}
	secure := httptest.NewTLSServer(golink.HSTS(server.Handler()))
	t.Cleanup(secure.Close)
	secureURL, _ := url.Parse(secure.URL)
	plain := httptest.NewServer(golink.RedirectHandler(secureURL.Host))
	t.Cleanup(plain.Close)
	plainURL, _ := url.Parse(plain.URL)
	c := &Client{HTTP: secure.Client(), Host: plainURL.Host}
	ctx := context.Background()
	if !c.Ping(ctx) {
		t.Fatal("Ping did not follow the HTTPS upgrade")
	}
	if err := c.Save(ctx, "docs", "https://example.com/docs", false); err != nil {
		t.Fatal(err)
	}
	if got, err := c.Resolve(ctx, "docs"); err != nil || got.Redirect != "https://example.com/docs" {
		t.Fatalf("Resolve = %+v, %v", got, err)
	}
	if links, err := c.Links(ctx); err != nil || len(links) != 1 {
		t.Fatalf("Links = %+v, %v", links, err)
	}
}

func TestLinkRedirectsAreNotHTTPSUpgrades(t *testing.T) {
	for _, tt := range []struct {
		name, location string
		referrerPolicy bool
	}{
		{"golink link redirect", "https://HOST/foo", true},
		{"other host", "https://example.com/foo", false},
		{"other path", "https://HOST/bar", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var c *Client
			c = stubClient(t, func(w http.ResponseWriter, r *http.Request) {
				if tt.referrerPolicy {
					w.Header().Set("Referrer-Policy", "no-referrer")
				}
				w.Header().Set("Location", strings.Replace(tt.location, "HOST", c.Host, 1))
				w.WriteHeader(302)
			})
			want := strings.Replace(tt.location, "HOST", c.Host, 1)
			if got, err := c.Resolve(context.Background(), "foo"); err != nil || got.Redirect != want {
				t.Fatalf("Resolve = %+v, %v; want redirect %q", got, err, want)
			}
		})
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
	if err := c.Save(context.Background(), "some link+", "https://example.com/a%2Fb?q=a+b&x=2#f", true); err != nil {
		t.Fatal(err)
	}
}

func TestSaveRejectsRedirect(t *testing.T) {
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/saved")
		w.WriteHeader(302)
	})
	assertKind(t, c.Save(context.Background(), "foo", "https://example.com", true), "http")
}

var operations = []struct {
	name string
	call func(context.Context, *Client) error
}{
	{"Resolve", func(ctx context.Context, c *Client) error { _, err := c.Resolve(ctx, "foo"); return err }},
	{"Save", func(ctx context.Context, c *Client) error { return c.Save(ctx, "foo", "https://example.com", true) }},
	{"Lookup", func(ctx context.Context, c *Client) error { _, err := c.Lookup(ctx, "foo"); return err }},
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
		{"wrong field type", "{\"Short\":23}", 0, true},
		{"incomplete record", "{\"Short\":", 0, true},
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

type failingReader struct{ err error }

func (r failingReader) Read([]byte) (int, error) { return 0, r.err }

func TestLinksBodyReadErrors(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
		kind string
	}{
		{"connection reset", &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}, "unreachable"},
		{"unexpected EOF from transport", io.ErrUnexpectedEOF, "unreachable"},
		{"other body read failure", errors.New("broken response stream"), "unreachable"},
		{"deadline", fmt.Errorf("wrapped: %w", context.DeadlineExceeded), "timeout"},
		{"socket timeout", timeoutError{}, "timeout"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body := &trackingBody{Reader: io.MultiReader(
				strings.NewReader("{\"Short\":\"docs\",\"Long\":\"https://example.com\",\"Owner\":\"owner@example.com\"}\n"),
				failingReader{err: tt.err},
			)}
			c := &Client{Host: "go", HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: body}, nil
			})}}
			_, err := c.Links(context.Background())
			if !body.closed {
				t.Fatal("failed export response body was not closed")
			}
			assertKind(t, err, tt.kind)
		})
	}
}
