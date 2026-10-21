# Golink Chrome extension implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loadable Chrome extension that embeds a persistent Tailscale WASM node and resolves, saves, and autocompletes links from an existing golink server.

**Architecture:** A Manifest V3 service worker owns Chrome storage and browser actions. An offscreen document owns the Go WASM node, whose netstack HTTP client is passed into a separately tested golink client. A shared status page acts as the popup and as the pending navigation, login, creation, and error page.

**Tech Stack:** Go, `tailscale.com v1.104.2`, Chrome Manifest V3, JavaScript ES modules, Node's built-in test runner, GitHub Actions. The verified upstream Go directive is `go 1.27.3`; use Node 22 and Chrome 116 or newer, which provides `runtime.getContexts`.

**Spec:** `docs/superpowers/specs/2026-10-21-golink-chrome-extension-design.md`

## Global constraints

- Module name: `golink-chrome-extension`.
- Pin `tailscale.com v1.104.2`; pin the test dependency `github.com/tailscale/golink` to commit `8b59870` through its resolved Go pseudo-version.
- Copy and attribute `cmd/tsconnect/wasm/wasm_js.go` from the pinned Tailscale module; remove SSH. Do not use `tsnet`.
- `golinkclient/` is ordinary Go without build tags. `wasm/` uses `//go:build js`.
- Real golink and SQLite are test-only imports and must not enter the WASM dependency graph.
- No npm dependencies. JavaScript tests run with `node --test`.
- All seven `globalThis.golinkExt` calls return Promises.
- Tailnet requests use Go's netstack HTTP transport, never browser `fetch`.
- `Resolve` and `Save` have 10 s deadlines; `Links` has 20 s; reachability has 5 s.
- Preserve redirect `Location` strings and input path/query escaping.
- Service worker owns `chrome.storage.local`; offscreen document uses only `chrome.runtime` among extension APIs.
- Auth keys stay in memory and are never persisted or logged.
- Persist identity writes before publishing `Running` or completing identity-changing operations.
- One queue serializes state writes and logout/reset/replacement storage changes. Epochs reject old-document writes.
- Stop automatic recovery after 2 fatals within 60 s.
- Autocomplete uses local cache; stale after 5 minutes; refresh after successful save. Typing never initiates tailnet traffic.
- No tab traffic proxy, in-browser golink server, recreation of golink's browse/edit/delete UI, or Web Store publishing.
- Weekly CI tries `tailscale.com@latest` and runs the same checks as push/PR CI.

## Starting state and design review

The repository currently contains only the spec. Its working copy has user changes; preserve those changes. This plan does not change its approval status. Before execution, read the current spec again and review any changes since this plan was written.

This is one integrated product, so keep one plan with independently testable tasks. Execute in order. Each task's final commit includes only its named files and any associated `go.mod`/`go.sum` changes. Use an isolated workspace at execution time if required by the worktree skill. Do not create one just to write this plan.

Source inspection confirmed the following details at golink `8b59870` and Tailscale `v1.104.2`:

- `golink.NewSQLiteDB(path)` and `golink.New(golink.Options{DB: db, Dev: true})` are exported. Use `Server.Handler()` in integration tests.
- Export records have `Short`, `Long`, and `Owner` JSON keys; decode into the extension's own type with case-insensitive `encoding/json` matching.
- Successful `POST /` returns a 2xx response, with a JSON link unless HTML was requested. Treat only 2xx as successful save.
- tsconnect passes `controlclient.LoginEphemeral` into `NewLocalBackend`. Use zero login flags here so ordinary interactive devices persist. Auth keys can still request ephemeral devices.
- tsconnect's state store uses hex. This project must use base64 as specified.
- Set `http.Transport.DialContext` to the Tailscale dialer and `Proxy: nil`. A custom dialer keeps Go's JS HTTP transport on raw netstack connections.

Implementation decisions that make the spec executable:

- Initial `tsState` is `{epoch: 1, values: {}}`. Each newly started document after that gets a persisted epoch increment, preserving values for ordinary recovery and clearing them for logout/reset/auth-key restart.
- A worker restart that finds the same live offscreen document reuses its epoch and identity. Add a `hello` handshake so readiness is recoverable even if the initial `ready` message was missed.
- State deletion uses `value: null`; empty bytes use an empty base64 string. This distinction preserves `ipn.StateStore` semantics.
- Add an in-memory document ID to messages. Pairing that ID with epoch distinguishes messages during bootstrap and recovery; it is not another persisted key.
- Keep operation scheduling separate from the storage queue. Waiting for `logout()` while holding the storage queue would deadlock its state-write acknowledgements.
- A failed cache refresh after a successful save does not report that the save failed. Retain the previous cache and report the refresh failure separately.
- Persist configuration fields `golinkHost` and optional `controlURL` alongside the spec's storage keys to support the documented MagicDNS fallback. Defaults are `go` and Tailscale's default control URL. The auth key is not part of this configuration.
- Reject redirects with unsupported schemes at the browser navigation boundary; the Go client still returns absolute `Location` values unchanged. Allow `http:` and `https:` targets for this example.
- Weekly CI detects future incompatibilities; somebody must enable workflow failure notifications for the repository. Do not claim scheduled CI can prevent all upstream changes.

## File map

```text
.gitignore                         ignore generated WASM, Go executable, local artifacts
package.json                       private ESM package; no dependencies
build.sh                           build ext/main.wasm, copy matching wasm_exec.js
README.md                          setup, architecture, limitations, manual verification
THIRD_PARTY_NOTICES.md              copied Tailscale BSD attribution and license text
go.mod, go.sum                     pinned module dependencies
golinkclient/client.go             Resolve/Save/Links and typed errors
golinkclient/client_test.go        real-golink integration and HTTP failure tests
wasm/main_js.go                    register public Promise API, retain JS funcs
wasm/node_js.go                    copied setup, backend and netstack lifecycle
wasm/state_js.go                   synchronous map-backed base64 state store
wasm/bridge_js.go                  argument/result conversion, promise helpers
scripts/wasm-smoke.cjs             run compiled Go WASM, check API, terminate
ext/manifest.json                  permissions, CSP, popup, background, web resources
ext/lib.js                         parsing, suggestions, XML escaping, crash window
ext/state.js                       storage queue and epoch transitions
ext/lifecycle.js                   offscreen readiness, request and restart scheduling
ext/background.js                  register events, browser actions, cache, routing
ext/offscreen.html                 classic wasm_exec.js plus module offscreen.js
ext/offscreen.js                   runtime RPC, Go startup, persistence acknowledgements
ext/status.html                    accessible status/login/save forms
ext/status.js                      page mode, state refresh, actions, pending resolve
ext/status.css                     shared popup/tab presentation
ext/main.wasm, ext/wasm_exec.js     generated and ignored
tests/                             Node test files
  lib.test.js                      pure helper tests
  state.test.js                    persistence ordering and epoch tests
  lifecycle.test.js                readiness, recovery, acknowledgements
  background.test.js               event routing and navigation tests
  status.test.js                   page controller tests with fake view
.github/workflows/build.yml        pinned checks and weekly latest-dependency check
```

Use `tests/` at the repository root. Splitting storage and lifecycle out of the spec's `background.js` keeps each race-prone concern testable; `background.js` remains the extension entry point. Export factory functions with injected dependencies from lifecycle/background/status modules, then register real Chrome events only when the corresponding globals exist. This lets Node exercise actual controllers without installing a DOM package.

## Shared interfaces

These contracts apply to every task. Change them in this section and in all consumers together if execution reveals a necessary adjustment.

```go
// package golinkclient
type Client struct { HTTP *http.Client; Host string }
type Link struct {
     Short string `json:"short"`
     Long string `json:"long"`
     Owner string `json:"owner"`
 }
type Result struct { Redirect string; NotFound bool; GolinkUI string }
type Error struct { Kind string; Message string }
func (e *Error) Error() string
func (c *Client) Resolve(ctx context.Context, path string) (Result, error)
func (c *Client) Save(ctx context.Context, short, long string) error
func (c *Client) Links(ctx context.Context) ([]Link, error)
```

`Host` is an authority such as `go`, `go.example.ts.net`, or `127.0.0.1:12345` in tests. It is not an arbitrary URL. Build `http://<Host>/<path>` without decoding or cleaning the supplied path. Requests remain on the configured golink host.

```js
// All runtime messages include channel: 'golink'.
// Requests also include target: 'worker' | 'offscreen'.
// Offscreen requests include docId, epoch, requestId, method, args.
// Response envelope:
// {ok: true, value: <method-specific value>}
// {ok: false, error: {kind: string, message: string}}
// Control/persistence messages to worker:
// {type: 'ready', docId}
// {type: 'stateWrite', docId, epoch, key, value: string | null}
// {type: 'state', docId, epoch, state: string}
// {type: 'browseToURL', docId, epoch, url: string}
// {type: 'fatal', docId, epoch, message: string}

// Worker page methods:
// status() -> {state, loginName, tailnet, hostname, golinkReachable}
// login() -> {ok:true}
// authKey(key) -> {ok:true}          [valid only in NeedsLogin]
// logout() / reset() -> {ok:true}
// resolve(path) -> public Go resolve result, or {pending:true}
// save(short, long) -> {ok:true}
// cachedLinks() -> {fetchedAt, links}
// configure({golinkHost, controlURL}) -> {ok:true}

// Go start result: {ok:true}; login/logout result: {ok:true}.
// Go failures for operational calls: {error: string, kind: string}.
// Go links success: Link[]; status success: the status object above.
// Bridge converts Go failures and rejected Promises into RPC error envelopes.
```

`hello` is an internal offscreen RPC returning `{docId, ready, started, epoch}` without starting Go or the node. Offscreen must reject arbitrary methods and stale docId/epoch combinations. Only the worker accepts page requests; it obtains navigation tab IDs from the sender rather than from caller-supplied IDs. Validate worker/offscreen message senders against the extension ID and expected extension document URL. Expose only `status.html` as a web-accessible page, not offscreen resources.

### Task 1: Build and test the plain Go client

**Files:** Create `go.mod`, `go.sum`, `golinkclient/client.go`, `golinkclient/client_test.go`, `.gitignore`.

**Consumes:** Existing golink HTTP API from the pinned commit.
**Produces:** All `golinkclient` interfaces above; Linux tests proving behavior against golink.

- [ ] **Step 1: Initialize the pinned module and add the real-server test fixture.**

```bash
go mod init golink-chrome-extension
go mod edit -go=1.27.3
go get tailscale.com@v1.104.2 github.com/tailscale/golink@8b59870
```

Create this fixture in `client_test.go` with imports `context`, `net/http`, `net/http/httptest`, `net/url`, `path/filepath`, `testing`, and `github.com/tailscale/golink` as `golink`:

```go
func realClient(t *testing.T) *Client {
    t.Helper()
    db, err := golink.NewSQLiteDB(filepath.Join(t.TempDir(), "golink.db"))
    if err != nil { t.Fatal(err) }
    server, err := golink.New(golink.Options{DB: db, Dev: true})
    if err != nil { t.Fatal(err) }
    ts := httptest.NewServer(server.Handler())
    t.Cleanup(ts.Close)
    u, err := url.Parse(ts.URL)
    if err != nil { t.Fatal(err) }
    return &Client{HTTP: ts.Client(), Host: u.Host}
}

func TestSaveResolveAndExport(t *testing.T) {
    c := realClient(t)
    ctx := context.Background()
    const target = "https://example.com/a%2Fb?q=x%2By#section"
    if err := c.Save(ctx, "docs", target); err != nil { t.Fatal(err) }
    got, err := c.Resolve(ctx, "docs")
    if err != nil || got.Redirect != target {
        t.Fatalf("Resolve = %+v, %v", got, err)
    }
    detail, err := c.Resolve(ctx, "docs+")
    if err != nil || detail.GolinkUI != "/.detail/docs" {
        t.Fatalf("detail = %+v, %v", detail, err)
    }
    missing, err := c.Resolve(ctx, "missing")
    if err != nil || !missing.NotFound { t.Fatalf("missing = %+v, %v", missing, err) }
    links, err := c.Links(ctx)
    if err != nil || len(links) != 1 || links[0].Short != "docs" || links[0].Owner == "" {
        t.Fatalf("Links = %+v, %v", links, err)
    }
}
```

- [ ] **Step 2: Run the test and observe missing client symbols.**

Run `go test ./golinkclient -run TestSaveResolveAndExport -v`. Expected failure is undefined `Client`, rather than dependency or fixture errors. Fix fixture setup errors before proceeding.

- [ ] **Step 3: Implement the client contracts with exact transport behavior.**

Use the injected transport but copy the client before installing a redirect policy, so caller configuration is not mutated:

```go
hc := *c.HTTP
hc.CheckRedirect = func(*http.Request, []*http.Request) error {
    return http.ErrUseLastResponse
}
ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.Host+"/"+path, nil)
```

Reject malformed hosts and fragments in a supplied request path. If `HTTP` is nil, use a copy of `http.DefaultClient` before installing the redirect policy. Preserve escaped paths and query strings by avoiding `path.Clean`, `QueryUnescape`, or re-encoding the raw input. `Resolve` classifies 302 absolute locations, 302 slash-relative golink UI locations, and 404. Return a typed `http` error for a missing/malformed 302 location and unexpected 2xx without a redirect; do not return an ambiguous empty result. Protocol-relative `//host/path` locations are not golink UI paths.

Construct the save request as follows; close every response body, and accept only 2xx:

```go
form := url.Values{"short": {short}, "long": {long}}
req, err := http.NewRequestWithContext(ctx, http.MethodPost,
    "http://"+c.Host+"/", strings.NewReader(form.Encode()))
if err != nil { return err }
req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
req.Header.Set("Sec-Golink", "1")
```

For exports, use a `json.Decoder` loop until `io.EOF`, so long template URLs are not limited by a scanner token size. Initialize the result to a non-nil empty slice. Classify deadlines using `errors.Is(err, context.DeadlineExceeded)` and `net.Error.Timeout`; classify transport failures as `unreachable`. For HTTP failures trim the response text and cap error-body reads at 64 KiB. Check status before decoding an export.

- [ ] **Step 4: Add the remaining concrete protocol regressions, then run all client tests.**

Add a real-server template test, following golink's own `TestExpandLink` cases at the pinned commit to assert the exact `.Path` output for `tmpl/a%2Fb?x=1&x=2`. Add a second saved link and assert both exports. Add the following stub regression to prove redirect destinations are not fetched:

```go
func TestDoesNotFollowRedirect(t *testing.T) {
    hits := 0
    target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        hits++
        w.WriteHeader(200)
    }))
    defer target.Close()
    source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Location", target.URL+"/a%2Fb?x=1&x=2")
        w.WriteHeader(302)
    }))
    defer source.Close()
    u, _ := url.Parse(source.URL)
    c := &Client{HTTP: source.Client(), Host: u.Host}
    got, err := c.Resolve(context.Background(), "foo")
    if err != nil || got.Redirect != target.URL+"/a%2Fb?x=1&x=2" || hits != 0 {
        t.Fatalf("result=%+v error=%v destination hits=%d", got, err, hits)
    }
}
```

Use `errors.As` to assert `*Error{Kind:"http", Message:"broken"}` for a stub 500 body `" broken\n"`. Use a caller context with a 10 ms timeout and a handler waiting on `r.Context().Done()` to assert `timeout` without waiting 10 s. A custom failing `RoundTripper` returning a dial error proves `unreachable`. Test a malformed export record and successful empty export. Verify `Sec-Golink` with a stub as well as the successful real-server save. Run `go test ./golinkclient -v` and `go mod tidy`; confirm Tailscale remains at `v1.104.2`.

- [ ] **Step 5: Ignore generated artifacts and commit.**

```gitignore
/ext/main.wasm
/ext/wasm_exec.js
/wasm-bin
```

Run `git add go.mod go.sum golinkclient .gitignore` then `git commit -m "feat: add tested golink HTTP client"`.

### Task 2: Compile the Tailscale node and expose its Promise API

**Files:** Create `wasm/main_js.go`, `wasm/node_js.go`, `wasm/state_js.go`, `wasm/bridge_js.go`, `build.sh`, `scripts/wasm-smoke.cjs`, `THIRD_PARTY_NOTICES.md`; update Go dependencies only as needed by imports.

**Consumes:** `golinkclient.Client` and the shared Go/JS API.
**Produces:** `ext/main.wasm`, matching `ext/wasm_exec.js`, seven Promise functions, and a no-network smoke test.

- [ ] **Step 1: Add the smoke test before registering any API.**

Create `scripts/wasm-smoke.cjs`:

```js
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
globalThis.crypto ??= require('node:crypto').webcrypto;
require(path.resolve('ext/wasm_exec.js'));
const go = new Go();
const timer = setTimeout(() => { console.error('WASM API startup timed out'); process.exit(1); }, 10000);
(async () => {
  const {instance} = await WebAssembly.instantiate(fs.readFileSync('ext/main.wasm'), go.importObject);
  go.run(instance).catch(err => { console.error(err); process.exit(1); });
  while (!globalThis.golinkExt) await new Promise(resolve => setTimeout(resolve, 10));
  for (const method of ['start', 'login', 'logout', 'status', 'resolve', 'save', 'links']) {
    assert.equal(typeof golinkExt[method], 'function', method);
  }
  // No start call: this smoke check must not create a node or contact a tailnet.
  clearTimeout(timer);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
```

Run `node scripts/wasm-smoke.cjs`. Expect a missing generated runtime or WASM file.

- [ ] **Step 2: Add the reproducible build script and registration skeleton.**

```sh
#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ext
GOOS=js GOARCH=wasm go build -o ext/main.wasm ./wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ext/wasm_exec.js
```

Make `build.sh` executable. `main_js.go` retains a package-level slice of all exported `js.Func` values and blocks forever after setting `globalThis.golinkExt`. Use `//go:build js` on each Go file. Define the seven functions in `bridge_js.go`, backed by a singleton node. Pre-start operational calls return rejected Promises explaining that the node is not started.

- [ ] **Step 3: Adapt the pinned setup with attribution and persistent state.**

Get the portable upstream source location with:

```bash
go mod download tailscale.com@v1.104.2
go list -m -f '{{.Dir}}' tailscale.com
```

Copy the engine, system, netstack, dialer, backend, log-policy, and required logging transport setup from `cmd/tsconnect/wasm/wasm_js.go`. Preserve the BSD header and include the upstream BSD license in `THIRD_PARTY_NOTICES.md`. Remove SSH, terminal, peer presentation, random hostname, old `fetch`, and old global API code. Replace `log.Fatal` paths with returned errors or `onFatal` notifications. Pass zero login flags to `ipnlocal.NewLocalBackend` instead of `controlclient.LoginEphemeral`. Keep `RouteAll:false`, `WantRunning:true`, and the worker-supplied stable hostname. Complete `start` only after backend initialization succeeds, not after login.

State-store behavior:

```go
// Store under a mutex; invoke JS only after releasing the mutex.
// ReadState: missing -> ipn.ErrStateNotExist; return a copy of decoded bytes.
// WriteState(nil): delete key, callback onStateWrite(key, null).
// WriteState(non-nil): clone bytes, callback with base64.StdEncoding.EncodeToString(bs).
// Initialization: decode every config.state value; invalid base64 rejects start.
```

Use a map-backed store implementing `ipn.StateStore`. Do not synchronously wait for Chrome persistence inside a Go write callback. Offscreen owns the asynchronous durability barrier in Task 5. Keep the log policy in the same persisted store. `onState` emits backend state names; `onBrowseToURL` forwards the authentication URL; `onFatal` carries initialization and recovered bridge failures. The offscreen layer also detects unrecoverable Go runtime exit.

- [ ] **Step 4: Connect the seven public functions.**

```go
httpClient := &http.Client{
    Transport: &http.Transport{DialContext: dialer.UserDial, Proxy: nil},
    CheckRedirect: func(*http.Request, []*http.Request) error {
        return http.ErrUseLastResponse
    },
}
client := &golinkclient.Client{HTTP: httpClient, Host: golinkHost}
```

Use `status := lb.StatusWithoutPeers()`, `status.Self.UserID` and `status.User` for the login name, and `status.CurrentTailnet.Name` for tailnet, guarding absent fields. Tagged nodes may lack a person login name. Reachability is `GET /` through this client with a 5 s deadline, only in `Running`; unsuccessful HTTP status means unreachable. `login` calls `StartLoginInteractive`; `logout` awaits `Logout(ctx, ipnauth.Self)` with a bounded context. Resolve/save/links delegate to `golinkclient` and convert its typed errors to `{error,kind}`. Unknown internal errors reject with a JavaScript `Error`.

Every `js.FuncOf` callback starts asynchronous Go work and returns immediately. Promise executor callbacks can be released after the constructor returns; exported callbacks remain live until document destruction. Recover bridge goroutine panics into fatal notification plus rejection. Never log an auth key or a whole configuration object.

- [ ] **Step 5: Verify the artifact and dependency boundary, then commit.**

```bash
./build.sh
node scripts/wasm-smoke.cjs
go test ./...
GOOS=js GOARCH=wasm go list -deps ./wasm
```

The dependency list must exclude `github.com/tailscale/golink` and `modernc.org/sqlite`. Inspect it with `rg 'github.com/tailscale/golink|modernc.org/sqlite'`, expecting no matches. Run `go mod tidy`. Commit the task's source files, notices, and module changes with `feat: embed Tailscale WASM node and Promise bridge`. Generated assets stay ignored.

### Task 3: Implement pure browser helpers

**Files:** Create `package.json`, `ext/lib.js`, `tests/lib.test.js`.

**Consumes:** Link records and page entry URLs.
**Produces:** `inputPath(text)`, `originalURLPath(url)`, `suggestions(links,text,limit=5)`, `escapeXML(text)`, `recordFatal(timestamps,now)`.

- [ ] **Step 1: Add ESM configuration and failing tests.**

```json
{"name":"golink-chrome-extension","private":true,"type":"module","scripts":{"test":"node --test"}}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {inputPath, originalURLPath, suggestions, escapeXML, recordFatal} from '../ext/lib.js';
test('input preserves escaping and query', () => {
  assert.equal(inputPath(' foo/a%2Fb?x=1&x=2 '), 'foo/a%2Fb?x=1&x=2');
  assert.equal(originalURLPath('http://go/foo/a%2Fb?x=1&x=2'), 'foo/a%2Fb?x=1&x=2');
});
test('prefixes rank before substrings', () => {
  const links = [{short:'mydocs',long:'https://a',owner:'a'}, {short:'Docs',long:'https://b',owner:'b'}];
  assert.deepEqual(suggestions(links, 'doc', 1).map(s => s.content), ['Docs']);
});
test('suggestion markup is escaped', () => {
  assert.equal(escapeXML('<&>"'), '&lt;&amp;&gt;&quot;');
});
test('second fatal inside sixty seconds blocks retry', () => {
  assert.deepEqual(recordFatal([1000], 2000), {timestamps:[1000,2000], blocked:true});
  assert.equal(recordFatal([1000], 62000).blocked, false);
});
```

Run `node --test tests/lib.test.js` and observe the missing module/export failures.

- [ ] **Step 2: Implement helpers and concrete parsing guards.**

Trim only surrounding whitespace from omnibox input, remove an optional leading `go/` or `/`, and preserve the remainder. Reject fragments and non-go absolute URLs passed as original navigation URLs. For a captured original URL, use a validated `http://go/` prefix and take its raw suffix rather than decode/re-encode it. This preserves encoded slashes, repeated parameters, and literal query separators. Root navigation becomes `''`.

Suggestion matching uses short names, case-insensitive prefix matches first, substring matches second, with deterministic name ordering in each group. Return Chrome objects `{content: short, description: escapedText}` and cap at `limit`. Use `escapeXML` for every URL/owner/name displayed in suggestion XML. Crash tracking retains timestamps whose age is less than 60,000 ms, appends `now`, and sets `blocked` at length >= 2.

- [ ] **Step 3: Extend and run the table tests, then commit.**

Add cases for empty input, `foo+`, `%252F`, repeated query keys, Unicode, `?x=%23`, no matches, case-insensitive substring matches, more than five suggestions, and rejection of a captured `https://example.com/` URL. Run `node --test tests/lib.test.js`. Commit with `feat: add navigation and suggestion helpers`.

### Task 4: Make identity persistence durable and epoch-safe

**Files:** Create `ext/state.js`, `tests/state.test.js`.

**Consumes:** Chrome-storage-compatible async `get`, `set`, and `remove` functions, plus stateWrite messages.
**Produces:** `createStateStore(storage)` returning `initialize()`, `write({epoch,key,value})`, `advance({clear})`, `snapshot()`, and `idle()`.

`initialize()` returns `{tsState, hostname, golinkHost, controlURL}` and creates missing defaults once. `advance` returns the newly persisted `{epoch,values}`; `clear:false` preserves values, `clear:true` clears values and removes `linksCache`. `write` returns `{applied:boolean}` only after storage completes. All five methods respect a single storage queue; `snapshot` cannot overtake preceding writes.

- [ ] **Step 1: Add a fake storage fixture and failing race regression.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateStore} from '../ext/state.js';
function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(keys) { return Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}
test('concurrent writes merge and stale writes cannot undo reset', async () => {
  const store = createStateStore(memoryStorage({tsState:{epoch:1,values:{}},hostname:'golink-ext-abcdef'}));
  await store.initialize();
  await Promise.all([
    store.write({epoch:1,key:'a',value:'YQ=='}),
    store.write({epoch:1,key:'b',value:'Yg=='}),
  ]);
  assert.deepEqual((await store.snapshot()).values, {a:'YQ==',b:'Yg=='});
  await store.advance({clear:true});
  assert.deepEqual(await store.write({epoch:1,key:'a',value:'b2xk'}), {applied:false});
  assert.deepEqual((await store.snapshot()).values, {});
});
```

Run `node --test tests/state.test.js`; expect missing implementation.

- [ ] **Step 2: Implement a queue that acknowledges only durable writes.**

```js
let tail = Promise.resolve();
function enqueue(operation) {
  const result = tail.then(operation);
  tail = result.catch(() => {}); // A caller still receives its rejection.
  return result;
}
```

Read and merge state inside the queue, not before enqueueing. For matching epoch, delete `key` when value is null, otherwise store the exact base64 string. Await `storage.set({tsState})` before resolving. For stale epochs acknowledge with `applied:false`. `advance` persists `{epoch:old.epoch+1,values:clear?{}:old.values}` atomically as one storage value, then removes the cache when clearing. A failed storage call rejects the operation; it never produces a successful acknowledgement. Generate `hostname` once using `crypto.getRandomValues(new Uint8Array(3))`, rendered as six lowercase hex characters.

- [ ] **Step 3: Add deferred-storage tests for acknowledgement ordering.**

```js
let release;
const gate = new Promise(resolve => { release = resolve; });
const storage = memoryStorage({tsState:{epoch:1,values:{}},hostname:'golink-ext-abcdef'});
const set = storage.set.bind(storage);
storage.set = async values => { await gate; await set(values); };
const store = createStateStore(storage);
await store.initialize();
let acknowledged = false;
const write = store.write({epoch:1,key:'node',value:'eA=='}).then(() => { acknowledged = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(acknowledged, false);
release();
await write;
assert.equal(acknowledged, true);
```

Wrap that code in a test. Add rejected-set propagation, deletion versus empty bytes, clear-state cache removal, ordinary-recovery value preservation, a late write queued on either side of a reset, and stable hostname on a second initialization. Run `node --test tests/state.test.js`. Commit with `feat: persist node state with serialized epochs`.

### Task 5: Host WASM offscreen and coordinate its lifecycle

**Files:** Create `ext/offscreen.html`, `ext/offscreen.js`, `ext/lifecycle.js`, `tests/lifecycle.test.js`.

**Consumes:** Task 4's store; Go API; Chrome runtime/offscreen functions injected into controller factories.
**Produces:** `createLifecycle({runtime,offscreen,store,now})` returning `ensureOffscreen()`, `call(method,args=[])`, `restart({clear,authKey})`, `handleEvent(message,sender)`, `dispose()`; offscreen factory `createOffscreenBridge({runtime,loadGo,docId})`.

`ensureOffscreen()` resolves to `{docId,epoch}` only after the API is ready and start succeeds. `call` accepts only the seven Go methods excluding public `start`; lifecycle owns start. `restart` blocks new operations while replacing the document. The bridge exposes `handleMessage` for fake-runtime tests and registers it before calling `loadGo`.

- [ ] **Step 1: Write readiness tests before implementation.**

Use a fake runtime/offscreen pair with a controlled `ready` event and a call log. Assert 20 concurrent `ensureOffscreen()` calls create exactly one document, no start is sent before `ready`, and exactly one start is sent afterward. A second lifecycle instance using the same fake live document must reuse `hello`'s started epoch without creating or restarting the node.

```js
// Test-owned fake API surface; implement these functions in the test fixture.
const calls = [];
const runtime = {
  async getContexts() { return contexts; },
  async sendMessage(message) {
    calls.push(message);
    if (message.method === 'hello') return {ok:true,value:hello};
    return bridge.handleMessage(message);
  },
};
const offscreen = {
  async createDocument(options) { contexts = [{documentUrl:'chrome-extension://test/offscreen.html'}]; },
  async closeDocument() { contexts = []; },
};
```

Use mutable `contexts`, `hello`, and `bridge` variables initialized within each test. A deferred `loadGo` is the readiness gate. Run `node --test tests/lifecycle.test.js` and observe failure before adding lifecycle code.

- [ ] **Step 2: Implement offscreen startup and recoverable handshakes.**

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Golink node</title></head>
<body><script src="wasm_exec.js"></script><script type="module" src="offscreen.js"></script></body></html>
```

```js
async function loadGo() {
  const go = new Go();
  const response = await fetch(chrome.runtime.getURL('main.wasm'));
  const {instance} = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  // Observe this Promise without awaiting it; Go main intentionally stays alive.
  const exited = go.run(instance);
  return {apiReady: waitForAPI(), exited};
}
async function waitForAPI() {
  const deadline = Date.now() + 30000;
  while (!globalThis.golinkExt) {
    if (Date.now() > deadline) throw new Error('Go API startup timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return globalThis.golinkExt;
}
```

Catch rejected WASM loads, Go run rejection, and normal unexpected Go exit into one fatal event per document. Register the message listener before loading. `hello` works while compiling. Wait up to 30 s for readiness and return a startup error on timeout rather than hanging a page forever. `WORKERS` document justification is that the document hosts a long-running WASM network node. Never call `chrome.storage` offscreen.

- [ ] **Step 3: Add the persistence barrier and test it with a fake Go API.**

```js
const pendingWrites = new Set();
let persistenceFailure;
function onStateWrite(key, value) {
  const pending = runtime.sendMessage({channel:'golink',target:'worker',type:'stateWrite',docId,epoch,key,value})
    .then(reply => {
      if (!reply?.ok) throw new Error(reply?.error?.message ?? 'State write failed');
    });
  pendingWrites.add(pending);
  pending.catch(error => { persistenceFailure = error; reportFatal(error); })
    .finally(() => pendingWrites.delete(pending));
}
async function flushWrites() {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
  if (persistenceFailure) throw persistenceFailure;
}
```

Install callbacks before `start`. Publish `Running` only after `flushWrites`; run the barrier before completing start/login/logout and any operation whose callback wrote identity state. Serialize publication so a delayed `Running` cannot overtake a later `NeedsLogin` event. When status reads `Running` directly from Go, apply the same barrier before returning it.

Test with a fake API whose `start` calls `onStateWrite` then `onState('Running')`: hold the acknowledgement and prove neither a Running event nor a Running status escapes. Reject storage and prove fatal is emitted and the operation fails. Test `null` deletion and `hello` before readiness.

- [ ] **Step 4: Implement replacement and worker recovery without queue deadlocks.**

The lifecycle controller first checks `runtime.getContexts`, then probes `hello` for an existing document, and otherwise shares a single create/ready/start Promise. A new document receives an epoch persisted by `store.advance({clear:false})` before start, except first-ever initialization uses its initial epoch. Recheck document identity before accepting callbacks. A worker awakened by a valid write may accept it after verifying current offscreen document ID and persisted epoch; it must not call `ensureOffscreen` in a way that waits for the very write being acknowledged.

Node operations acquire an operation gate. State-write messages bypass that gate and use the storage queue. A destructive restart closes admission to new operations, lets bounded in-flight calls finish, invokes backend logout when required, closes the document, persists a new epoch and chosen values, then starts a replacement. Auth-key restart is allowed only in `NeedsLogin`; pass the key only to this start and release references afterward. Logout errors prevent reporting logout success; reset may ignore backend logout errors, as the spec states. In both cases discard the old document before clearing persisted state. If startup fails, release the gate and expose the failure.

Store crash timestamps under `chrome.storage.session` through the worker adapter, so restarting the service worker does not erase the 60 s window. First fatal closes the document and permits on-demand recovery; second within 60 s blocks recovery. Expiry permits a later retry; explicit reset clears the limiter. Reject waiting operations when a document exits rather than leaving RPC Promises unresolved.

- [ ] **Step 5: Verify the lifecycle regressions and commit.**

Add tests for missing documents, wrong sender/docId/epoch, startup failure followed by retry, late writes after replacement, auth-key non-persistence, two fatals across worker reconstruction, and reset while a state write awaits acknowledgement. The reset test must finish and leave an empty state at the new epoch. Run `node --test tests/state.test.js tests/lifecycle.test.js`, then `./build.sh && node scripts/wasm-smoke.cjs`. Commit with `feat: coordinate offscreen node lifecycle and durable login`.

### Task 6: Wire browser navigation, omnibox, cache, and login

**Files:** Create `ext/manifest.json`, `ext/background.js`, `tests/background.test.js`.

**Consumes:** Lifecycle, storage, pure helpers, shared page RPC contract.
**Produces:** `createBackground({chrome,lifecycle,store,now})` with `register()` and `handleMessage()`; real service-worker registration.

- [ ] **Step 1: Add failing browser-controller tests with injected Chrome functions.**

Use call-recording `tabs.create/update/remove`, `declarativeNetRequest.getDynamicRules/updateDynamicRules`, storage, and Chrome event objects. Test omnibox `currentTab`, `newForegroundTab`, and `newBackgroundTab` dispositions. Assert a pending status page opens before any awaited node operation. Assert typing calls `suggest` from local cache and makes zero lifecycle calls even when the cache is stale.

```js
const events = () => ({listeners:[], addListener(fn) { this.listeners.push(fn); }});
const opened = [];
const tabs = {
  async create(options) { opened.push(options); return {id:10}; },
  async update(id, options) { opened.push({id,...options}); return {id}; },
  async remove(id) {},
};
```

Run `node --test tests/background.test.js` before implementation.

- [ ] **Step 2: Add the extension manifest and persistent redirect rule.**

```json
{
  "manifest_version": 3,
  "name": "Golink over Tailscale",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": ["offscreen", "storage", "tabs", "declarativeNetRequestWithHostAccess"],
  "host_permissions": ["http://go/*"],
  "background": {"service_worker": "background.js", "type": "module"},
  "action": {"default_popup": "status.html"},
  "omnibox": {"keyword": "go"},
  "web_accessible_resources": [{"resources": ["status.html"], "matches": ["http://go/*"]}],
  "content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"}
}
```

Use dynamic rule ID 1. Install/repair on registration, `onInstalled`, and `onStartup`, sharing an in-flight repair Promise. The exact JavaScript rule is:

```js
const rule = {
  id: 1, priority: 1,
  action: {type:'redirect', redirect:{regexSubstitution:chrome.runtime.getURL('status.html')+'#\\1'}},
  condition: {regexFilter:'^(http://go/.*)$', resourceTypes:['main_frame']},
};
```

Check the existing rule before replacing it with `updateDynamicRules({removeRuleIds:[1],addRules:[rule]})`. Persisting a dynamic rule makes it effective while the worker is asleep. Capturing the original URL in the fragment preserves its query. Register listeners synchronously at module evaluation; asynchronous initialization occurs inside handlers.

- [ ] **Step 3: Implement routing and cache refresh triggers.**

Pending omnibox page URL is `status.html?resolve=<encodeURIComponent(path)>`. Direct navigation uses `status.html#http://go/...`. `resolve` returns `{pending:true}` unless Running; the page retries after a later Running status. Resolve results navigate only the sender's status tab and only to supported `http:` or `https:` targets. Not-found opens the create mode with the first path component filled in; golink UI results show a local explanation and cached record. Build page URLs with `URL`/`URLSearchParams` rather than interpolating response bodies into HTML.

Wire `login` and `browseToURL` to a single login tab. Store its ID in `chrome.storage.session`, close only that tab on durable Running, and ignore a missing/already-closed tab. `logout`, `reset`, `authKey`, and configuration changes delegate to the lifecycle gate. Reject page attempts to call `start` or send persistence events. Return runtime error envelopes for failed operations; Chrome async message listeners must return `true` while `sendResponse` is pending.

Use cache `{fetchedAt,links}` from local storage. Refresh when Running begins and on non-typing requests if stale; refresh after every successful save. Deduplicate concurrent refreshes. Tag every refresh with the current epoch and discard its result after logout/reset so an old links request cannot repopulate the cleared cache. `cachedLinks` itself is local-only. After a stale cache was displayed, a background refresh can update future suggestions.

- [ ] **Step 4: Verify browser behavior and commit.**

Add tests asserting captured URL preservation for `http://go/foo/a%2Fb?x=1&x=2`, redirect rule repair, rejection of unsupported target schemes, login tab closure after worker reconstruction, no navigation on an unreachable error, one cache refresh for concurrent callers, cache refresh after save, stale refresh discard after reset, and successful save surviving a refresh failure. Run `node --test tests/background.test.js`. Commit with `feat: route go links and browser actions through the node`.

### Task 7: Build the shared popup and status page

**Files:** Create `ext/status.html`, `ext/status.js`, `ext/status.css`, `tests/status.test.js`.

**Consumes:** Worker page methods and status/result objects.
**Produces:** `createStatusController({rpc,view,location,activeTab,setTimer,clearTimer})` returning `start()` and `dispose()`; a DOM view adapter used by the real page.

- [ ] **Step 1: Test pending resolution and save behavior before building the UI.**

Inject a fake view that records render calls. Feed status results `Starting`, `NeedsLogin`, and `Running` and assert a pending request resolves only on Running, once at a time. Assert `dispose()` cancels polling. Assert save uses the short name and original active tab URL, and clears the auth-key input after submission. Run `node --test tests/status.test.js` expecting missing controller failures.

- [ ] **Step 2: Create semantic page elements and map every specified state.**

Start with this body and add labels for configuration fields using the same pattern:

```html
<main>
  <h1>Golink</h1>
  <p id="status" role="status" aria-live="polite">Connecting…</p>
  <p id="identity"></p><p id="reachability"></p>
  <section id="login-panel" hidden>
    <button id="login" type="button">Log in</button>
    <form id="auth-form">
      <label for="auth-key">Tailscale auth key</label>
      <input id="auth-key" type="password" autocomplete="off">
      <button type="submit">Use auth key</button>
    </form>
  </section>
  <form id="save-form" hidden>
    <label for="short">Short name</label><input id="short" required>
    <label for="long">Target URL</label><input id="long" required>
    <button type="submit">Save link</button>
  </form>
  <button id="logout" type="button" hidden>Log out</button>
  <button id="reset" type="button" hidden>Reset device</button>
  <p id="error" role="alert" hidden></p>
</main>
<script type="module" src="status.js"></script>
```

Use textContent for status, response messages, and cached links. Use native form controls with visible focus, disabled states during actions, and readable popup width around 360 px with a wider centered layout for full tabs. No inline scripts, third-party assets, or external fonts.

Map `NoState`/`Starting` to Connecting, `NeedsLogin` to login/auth-key form, `NeedsMachineAuth` to admin approval text, `Running` to identity/reachability/save/logout/reset, and `Stopped` to Stopped plus login. Show unexpected states as their literal name with reset available. Unreachable text tells users to check ACL access to `go:80`; timeout and HTTP messages are distinct. Golink UI mode explains the native-Tailscale requirement and displays the corresponding cached link.

- [ ] **Step 3: Implement page entry modes and refresh lifecycle.**

Parse direct-navigation fragments through `originalURLPath`; parse omnibox `resolve` through `URLSearchParams` exactly once. Support `create`, `golinkUI`, and `error` query modes. A popup with no mode queries the active tab and pre-fills its URL. A not-found page pre-fills only the missing short name and lets the user enter a target; it must not pre-fill its own extension URL. Preserve the pending path through login. Poll status every 2 s while open with one request in flight, cancel on page unload, and retry the pending path only when Running. RPC errors stop the spinner and display recovery controls.

Provide optional golink host and control URL settings. Save through the worker, which validates host as an authority and control URL as an HTTP(S) URL, then restarts with existing identity. Default fields work without configuration. Do not put the auth key in a URL, storage, error text, or logs.

- [ ] **Step 4: Run controller tests and inspect the built page.**

Add controller cases for every state, 404 create mode, `foo+` cached UI mode, blocked-ACL text, auth-key error recovery, and encoded pending paths. Run `node --test tests/status.test.js`, then `node --test`. Load the extension in Chrome after `./build.sh` and inspect both popup and full-tab layouts for working controls, keyboard navigation, and extension console errors. If a browser is unavailable, record that manual check as pending rather than claiming it passed. Commit with `feat: add login save and pending navigation UI`.

### Task 8: Automate builds and document operation

**Files:** Create `.github/workflows/build.yml`, `README.md`; update `THIRD_PARTY_NOTICES.md` only if additional copied code requires it.

**Consumes:** Build script and all automated tests.
**Produces:** CI for pinned and latest dependencies; runnable setup and manual acceptance checklist.

- [ ] **Step 1: Add the two-mode CI workflow.**

```yaml
name: build
on:
  push:
  pull_request:
  schedule:
    - cron: '23 9 * * 1'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        deps: ${{ github.event_name == 'schedule' && fromJSON('["pinned","latest"]') || fromJSON('["pinned"]') }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - if: matrix.deps == 'latest'
        name: Try latest Tailscale internals
        run: |
          go get tailscale.com@latest
          go mod tidy
      - run: go test ./...
      - run: ./build.sh
      - run: node scripts/wasm-smoke.cjs
      - run: node --test
      - name: Exclude server and SQLite from WASM
        shell: bash
        run: |
          GOOS=js GOARCH=wasm go list -deps ./wasm > /tmp/wasm-deps.txt
          if grep -E '^(github.com/tailscale/golink|modernc.org/sqlite)(/|$)' /tmp/wasm-deps.txt; then
            exit 1
          fi
```

The weekly latest job changes only its checkout; it does not commit dependency updates. Scheduled workflows require the file on the default branch. Document enabling failure notifications and checking scheduled-job status. Review action versions at execution time if repository policy pins actions to full SHAs.

- [ ] **Step 2: Write exact setup instructions and the ACL example.**

README must include these commands:

```bash
go version
node --version
./build.sh
go test ./...
node --test
node scripts/wasm-smoke.cjs
```

Explain loading `ext/` via Chrome extensions developer mode, running an existing golink server, logging in, using `go` then Tab/Space then a short name, using explicit `http://go/foo`, saving the current tab, and configuring a full MagicDNS hostname if bare `go` does not resolve. Include an example ACL fragment:

```json
{"grants":[{"src":["tag:golink-ext"],"dst":["tag:golink"],"ip":["tcp:80"]}]}
```

Explain that the tags must match the user's own tailnet policy and have appropriate `tagOwners`; interactive devices need the equivalent user/group source grant. Recommend a tagged auth key for demos and explain tag ownership of links. Explain ephemeral-key cleanup and ordinary logout leaving a non-ephemeral device in the admin console.

Document the offscreen/worker ownership boundary, cold-start delay, local identity storage, Reset device behavior, copied-source attribution, version pin, DERP WebSocket-only traffic, native-Tailscale requirement for tailnet-only destinations and golink web UI, deleted-device limitation before upstream `0f3c767d1`, and absence of Web Store publishing support.

- [ ] **Step 3: Include an executable manual acceptance record.**

Use this table in README. Keep results `not run` until somebody observes them; record Chrome version and OS alongside the completed table. Use a test tailnet whose golink can be edited for fixtures, and never include keys in the record.

| Check | Procedure | Expected result | Result |
|---|---|---|---|
| Interactive login | Load unpacked, click Log in, finish login | Durable Running, user/tailnet shown, login tab closes | not run |
| Resolve/template | Save simple and path/query template fixtures; use omnibox | Exact target including escaped path and repeated query keys | not run |
| Direct cold start | Restart browser; open `http://go/<fixture>` before popup | Pending page appears, then correct destination | not run |
| Missing/save | Resolve unknown name; enter target; also save an ordinary active tab from popup | Prefilled name, successful save, exported suggestion appears | not run |
| Detail | Resolve `<fixture>+` | Native-Tailscale explanation and cached record | not run |
| Autocomplete | Type prefix and substring with cached links | Ranked escaped suggestions; no request caused by typing | not run |
| Restart persistence | Restart browser after login | Same node identity and hostname; no login required | not run |
| Auth key | Reset, log in with a tagged key | Registered identity survives restart; key absent from storage | not run |
| Logout | Log out, restart browser | NeedsLogin; cleared node values and cache | not run |
| ACL failure | Deny this node access to golink TCP 80 | Unreachable message with ACL guidance | not run |
| Reset race | Delay a state-write acknowledgement in DevTools, then reset and release old write | Old write discarded; restart remains logged out | not run |
| Worker restart | Stop worker in DevTools while node document remains | Next request reuses node; no new device | not run |
| Crash loop | Simulate two fatal exits within 60 s | Retry stops; explicit reset permits recovery | not run |
| Bare go name | Resolve using default host; retry full MagicDNS hostname if needed | Record which hostname works | not run |
| Scheme-less navigation | Type `go/<fixture>` without scheme | Record navigation or search behavior; document explicit scheme if search | not run |
| Deleted device | Delete node in admin console, attempt resolve, then reset | Pinned-version limitation shown; reset restores NeedsLogin | not run |

- [ ] **Step 4: Run required checks and commit the automation/docs.**

```bash
go test ./...
./build.sh
node scripts/wasm-smoke.cjs
node --test
```

Inspect the YAML structure and paths, and confirm generated files remain ignored. Do not modify the main module pin merely to try the weekly path; use an isolated checkout for that check if desired. Commit with `ci: build test and document the extension`.

### Task 9: Review the integrated extension and complete acceptance

**Files:** Modify only files that need a verified fix; record manual results in `README.md`.

**Consumes:** All previous tasks.
**Produces:** A reviewed extension with automated results and an honest manual acceptance record.

- [ ] **Step 1: Review against the spec and shared contracts.**

Use `superpowers:requesting-code-review` and inspect changes against the spec. Verify seven public methods, host/path handling, precise typed errors, no imported SQLite in WASM, state deletion semantics, durability before Running, epoch reuse after worker-only restart, stale writes/refreshes after reset, no auth-key persistence, no network from typing, the persistent redirect rule, and the full popup state table. Resolve concrete review findings before claiming completion.

- [ ] **Step 2: Run the automated checks once after final fixes.**

Use `superpowers:verification-before-completion`:

```bash
go test ./...
./build.sh
node scripts/wasm-smoke.cjs
node --test
git diff --check
git status --short
```

Expected: all commands succeed, no accidental generated artifacts, and only intentional source/documentation changes. Record command results in the handoff; do not equate Node fakes or WASM API registration with an actual browser/tailnet E2E pass.

- [ ] **Step 3: Run manual acceptance when a real browser and tailnet are available.**

Complete the README table with observed results. Fix reproduced failures using the debugging workflow and add regression coverage for the actual defect. If credentials/browser access are unavailable, report the exact unrun rows and that dependency; finish all independent automated work.

- [ ] **Step 4: Commit any final fixes and hand off through the branch workflow.**

Stage only verified task files, preserve the user's pre-existing spec edits, and use a commit message describing the actual fixes. Follow `superpowers:finishing-a-development-branch` for integration options. The final report should link README setup, name the verified commands, identify manual checks still pending, and explain known limitations relevant to trying the demo.

## Plan self-review

- Spec coverage maps to Tasks 1–2 for golink protocol and WASM, Tasks 3/6 for omnibox and redirects, Tasks 4–5 for persistence and recovery, Task 7 for the popup and login/create/error pages, Task 8 for CI/docs, and Task 9 for integrated acceptance.
- Risk-focused regressions cover concurrent writes, storage failure before Running, offscreen readiness, worker-only restart, reset while writes are pending, stale cache completion, crash-loop history, and redirects that must not be followed by the node.
- Linux tests and WASM builds use the same module but different import graphs. The smoke test starts only the Go runtime, with no login or network setup.
- Manual tests explicitly cover the two unresolved platform questions from the spec: bare-name MagicDNS and scheme-less `go/foo` behavior.
- Existing spec edits remain untouched. Execution must report manual coverage separately from automated verification.
