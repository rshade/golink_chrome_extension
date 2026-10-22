# golink Chrome extension (Tailscale WASM): design

Date: 2026-10-21
Status: approved in brainstorming; pending written-spec review

## Purpose

A reference example, also usable as a customer or teammate demo, of a Chrome
extension that embeds a Tailscale node compiled to WebAssembly and uses it to
reach an existing [golink](https://github.com/tailscale/golink) server. A
machine without Tailscale installed can resolve `go/` links, save links, and
autocomplete them.

Being an example, clarity comes first. It still has to log in and reconnect
reliably, because it will be demoed and handed to other people.

### Success criteria

- `go foo` in the omnibox and navigations to `http://go/foo` open the link's
  target, with golink template expansion (path, query) intact.
- Users can log in interactively (their own identity) or with an auth key.
- The node keeps its identity across browser restarts without logging in
  again.
- Users can save the current tab as a go link from the popup.
- The omnibox autocompletes from the tailnet's links.
- The popup shows the node's state, the logged-in user, and whether golink is
  reachable.
- CI flags breakage within a week when `tailscale.com` internals change.

### Non-goals

- Running the golink server in the browser. golink's `modernc.org/sqlite`
  dependency does not build for `js/wasm`, and a database in the browser would
  not be shared across the tailnet anyway.
- Proxying page loads. Link targets that are themselves tailnet-only hosts
  will not load in the tab without native Tailscale. Chrome extensions cannot
  route tab traffic through an in-extension transport.
- Rebuilding golink's web UI (browse, edit, delete) in the extension.
- Publishing to the Chrome Web Store.

## Background findings

Verified during brainstorming against golink `8b59870` and tailscale.com at
the time:

- tsconnect's WASM node (`cmd/tsconnect/wasm`) builds to about 37 MB raw and
  8.5 MB gzipped.
- tsconnect's JS `fetch(url)` follows redirects and returns only
  status/statusText/text. Following redirects is wrong here: the client would
  try to dial internet hosts through netstack, which has no route from inside
  a browser. It also has no method, request headers, or body.
- tsconnect's setup code lives in `package main`, which can't be imported.
- `tsnet` almost builds for `js/wasm`. `tsnet/tsnet.go` calls
  `local.Client.GetCertificate`, which is gated `!js && !ts_omit_acme`, so
  `tsnet` currently fails for `js` and with `-tags ts_omit_acme`. This upstream
  bug is out of scope. **Decision:** copy tsconnect's setup code (approach B),
  not tsnet.
- golink: `GET /{name}` gives `302` with a hand-set `Location` (the expanded
  target), or `404` plus the home page. `GET /{name}+` gives `302` to
  `/.detail/{name}`. `POST /` saves a link. The XSRF check is skipped when a
  `Sec-Golink` header is present; browser JS can't set it, but Go writing raw
  HTTP over netstack can. `/.export` streams all links as JSON lines. There is
  no JSON search endpoint.

## Architecture

Standalone repository at `golink_chrome_extension/`, with its own Go module
pinned to `tailscale.com v1.104.2` (the version golink uses at `8b59870`).

```
README.md            setup, ACL snippet, login identity, limitations, manual E2E checklist
build.sh             GOOS=js GOARCH=wasm go build → ext/main.wasm;
                     copies $(go env GOROOT)/lib/wasm/wasm_exec.js → ext/
go.mod / go.sum      module golink-chrome-extension (no host prefix; rename when published)
golinkclient/        plain Go, no build tags, testable on Linux
  client.go          Client{HTTP *http.Client, Host string}
                     Resolve(ctx, path) (Result, error)
                     Save(ctx, short, long) error
                     Links(ctx) ([]Link, error)
  client_test.go
wasm/                //go:build js
  main_js.go         registers globalThis.golinkExt
  node_js.go         setup copied from tailscale.com@v1.104.2
                     cmd/tsconnect/wasm/wasm_js.go (attributed, SSH removed),
                     and the JS-backed in-memory state store
  bridge_js.go       JS ⇄ Go promise helpers; passes the tailnet *http.Client
                     into golinkclient
ext/                 load unpacked
  manifest.json      MV3; omnibox keyword "go"; permissions: offscreen, storage,
                     tabs, declarativeNetRequestWithHostAccess;
                     host permission http://go/*; status.html is a web-accessible
                     resource for the redirect rule; CSP extension_pages:
                     script-src 'self' 'wasm-unsafe-eval'
  background.js      service worker: omnibox, redirect-rule installation,
                     offscreen lifecycle, storage, message routing
  lib.js             pure helpers (ES module) used by background.js; unit tested
  offscreen.html/js  hosts wasm_exec.js + main.wasm
  status.html/js/css popup UI, also opened as a full tab for pending/login/
                     create/error states
  wasm_exec.js       generated by build.sh
  main.wasm          generated by build.sh
.github/workflows/build.yml
```

### Go → JS API (`globalThis.golinkExt`)

All calls return Promises.

| Call | Behavior |
|---|---|
| `start(config, callbacks)` | config: `golinkHost` (default `"go"`), `hostname`, `state` (object of key → base64 value), optional `authKey`, `controlURL`. callbacks: `onState(state)`, `onBrowseToURL(url)`, `onStateWrite(key, value)`, `onFatal(msg)`. Starts the node. |
| `login()` | Starts an interactive login; the URL arrives via `onBrowseToURL`. |
| `logout()` | Calls LocalBackend `Logout`. |
| `status()` | `{state, loginName, tailnet, hostname, golinkReachable}`. `golinkReachable` comes from a `GET /` against golink with a 5 s timeout. |
| `resolve(path)` | `path` includes the remainder and query, e.g. `"foo/bar?x=1"`. Returns `{redirect: url}`, `{notFound: true}`, `{golinkUI: path}`, or `{error: msg, kind: "unreachable" \| "http" \| "timeout"}`. |
| `save(short, long)` | Returns `{ok: true}` or an error object as above. |
| `links()` | Returns `[{short, long, owner}]`. |

### `golinkclient.Resolve` classification

The HTTP client sets `CheckRedirect` to return `http.ErrUseLastResponse`.

| Response | Result |
|---|---|
| 302 with an absolute `Location` | `Redirect(url)`, the exact `Location` string, unmodified |
| 302 with `Location` starting with `/` | `GolinkUI(path)` |
| 404 | `NotFound` |
| other non-2xx | error, kind `http`, with the response body (trimmed) as the message |
| dial failure | error, kind `unreachable` |
| context deadline | error, kind `timeout` |

`Save` posts `application/x-www-form-urlencoded` `short` and `long` to `/` with
`Sec-Golink: 1`. `Links` parses the `/.export` JSON lines. Timeouts:
`Resolve`/`Save` 10 s, `Links` 20 s.

## Runtime and data flow

| Component | Lifetime | Owns |
|---|---|---|
| Service worker | Killed after about 30 s idle; woken by events and messages | `chrome.storage.local`, omnibox, routing |
| Offscreen document | Created on first use, lives until the browser exits; one per extension | WASM node and its in-memory state |
| status page / popup | While open | Display and pending resolve requests |

Offscreen documents can only use `chrome.runtime`, not `chrome.storage`.

### State persistence

1. Every node request from the service worker first calls `ensureOffscreen()`.
   This checks `chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})`
   and, if none exists, calls `chrome.offscreen.createDocument` with reason
   `WORKERS`. Concurrent calls share one in-flight promise. The offscreen
   document registers its message listener before loading WASM and sends a
   `ready` message when `golinkExt` is available; `ensureOffscreen()` waits for
   that handshake before sending `start` or other calls.
2. On creation, the service worker reads `chrome.storage.local.tsState` and
   the persisted `hostname`. `tsState` is `{epoch, values}`, where `values` is
   the state map passed to the offscreen document for `golinkExt.start`.
3. The Go state store serves reads from a synchronous in-memory map. Writes
   update the map and call `onStateWrite`. The offscreen document sends
   `{type: "stateWrite", epoch, key, value}` and tracks the reply. The service
   worker serializes state writes and the storage changes for logout and reset
   in one queue. For a matching epoch, it reads `tsState`, merges the key into
   `values`, awaits `chrome.storage.local.set({tsState})`, then acknowledges
   the message. It discards and acknowledges writes from an older epoch. The offscreen
   document waits for pending write acknowledgements before reporting
   `Running` or completing an operation that changes the node identity. A
   failed storage write is reported as a fatal persistence error, not as a
   successful login.
4. `hostname` is generated once as `golink-ext-<6 hex>` and persisted.

Storage keys: `tsState` (`{epoch, values}`), `hostname`, `linksCache`
(`{fetchedAt, links}`). The epoch is initialized once and increments on logout,
device reset, or offscreen replacement. The new epoch is persisted in the same
`tsState` write as the new values, before a replacement starts. Messages from
an older document cannot restore its state.

### Resolving a link

Entry points:

- `chrome.omnibox.onInputEntered`: input `foo/bar?x=1`. The handler immediately
  opens `status.html` with the pending path in the requested tab disposition.
- A persistent `declarativeNetRequest` main-frame redirect rule for
  `http://go/*`. The service worker installs it on extension installation and
  keeps it across browser restarts. It also checks the rule when the worker
  starts, so an update can repair a missing or stale rule. A regex substitution
  uses `chrome.runtime.getURL('status.html')` and puts the captured original
  URL in the fragment, so its path and query remain intact. `status.html` is
  declared in `web_accessible_resources`. The page parses the original URL
  and sends the path and query to the service worker. Navigation is intercepted
  before Chrome attempts to load `go`.

Flow:

1. The status page shows "Connecting…" immediately and requests a resolve.
   The service worker calls `ensureOffscreen()`, then reads the node state.
2. Not `Running`: the page shows the login UI or waits for the node, then
   retries automatically once `Running`.
3. `Running`: call `resolve(path)`.
   - `redirect`: `tabs.update(tabId, {url})`.
   - `notFound`: `status.html?create=<short>` (save form pre-filled).
   - `golinkUI`: `status.html?golinkUI=<path>`, which explains that golink's
     web UI needs native Tailscale and shows the link from `linksCache`.
   - `error`: `status.html?error=<kind>&msg=…`.

### Autocomplete

`chrome.omnibox.onInputChanged` filters `linksCache` locally, matching and
ranking prefixes first, then substrings, case-insensitively, up to Chrome's
suggestion limit. The cache is refreshed in the background when it's older
than 5 minutes and after every successful save. Typing never causes a request
to the tailnet.

### Cold start

The first request after the browser starts compiles the WASM and connects to
the tailnet, which takes a few seconds. The tab already shows `status.html`
during this time. The redirect rule survives service-worker restarts, so it
also works before the worker wakes up.

## Login, errors, recovery

### Interactive login (default)

Popup **Log in**, then `login()`, then `onBrowseToURL(url)`. The service worker
opens the URL with `chrome.tabs.create` and records the tab ID. On `Running`,
it closes that tab and resumes any pending resolve.

### Auth key (optional)

A popup field sends the key to the service worker while the node is in
`NeedsLogin`. Because `start()` has already run by then, the worker closes the
offscreen document, clears stale state values while incrementing the epoch,
and starts a replacement with `start({authKey})`. It serializes this restart
with other node operations and waits for the state write acknowledgements
before reporting success. The key is kept only in memory for that restart
and is **not persisted**. After registration the node's identity lives in
`tsState`. The README recommends a tagged key and
explains that golink then records the tag identity, not a person, as link
owner. Ephemeral keys cause the device to be deleted after it's been offline
for a while.

### States shown in the popup

| State | UI |
|---|---|
| `NoState`, `Starting` | "Connecting…" |
| `NeedsLogin` | **Log in** button and auth-key field |
| `NeedsMachineAuth` | "Waiting for an admin to approve this device" |
| `Running` | login name, tailnet, golink reachable, **Log out**, **Reset device** |
| `Stopped` | "Stopped" and **Log in** |

### Failure handling

- **Offscreen document gone:** recreated by `ensureOffscreen()` on the next
  request.
- **Go panic or WASM exit:** the offscreen document sends `{type: "fatal"}`.
  The service worker closes the document and recreates it on the next
  request. After 2 fatals within 60 s, it stops retrying and shows
  `status.html?error=fatal`.
- **golink unreachable:** message tells the user to check that ACLs allow this
  device to reach `go:80`.
- **HTTP errors:** golink's response body is shown.

**Reset device** is a service worker operation, not a Go API call. It blocks
new node operations, calls `logout()` (ignoring errors), and closes the
offscreen document. In the state-operation queue it increments the epoch and
stores `tsState: {epoch, values: {}}`, then removes `linksCache` (keeping
`hostname`). It recreates the offscreen document with the new epoch, which
starts in `NeedsLogin`. Late writes from the old document are discarded.

**Log out** uses the same queued epoch increment and state clearing after the
backend's `Logout` completes. It closes the offscreen document before clearing
local state, so a late write cannot log the user back in.

### Known limitations (documented in README)

- **Deleted devices:** `tailscale.com v1.104.2` doesn't include upstream
  commit `0f3c767d1`, which moves a deleted device to `NeedsLogin`. Until the
  pinned version includes it, a device deleted in the admin console (or an
  ephemeral device that was cleaned up) looks like "Running, but golink
  unreachable." **Reset device** recovers: it logs out and clears `tsState` and
  `linksCache`. Once the pin is bumped past that commit, the fix arrives with
  no code changes.
- **Logout:** **Log out** calls the backend's `Logout`, which expires the
  device key and disconnects. Ephemeral devices are then removed from the
  tailnet. Non-ephemeral devices remain in the admin console as logged out
  until an admin deletes them. Local state values and `linksCache` are cleared
  either way.
- Tailnet-only link targets don't load without native Tailscale (see
  Non-goals).
- Traffic goes through DERP relays over WebSocket only, with no direct UDP
  paths. Fine for lookups, slower than native Tailscale.
- To verify during implementation: whether Chrome sends a typed `go/foo` with
  no scheme to `http://go/foo` (caught by the redirect rule) or treats it as
  a search. If it becomes a search, document that users should enter
  `http://go/foo` or use the `go` omnibox keyword. The extension does not
  intercept searches sent to the user's search engine.
- To verify during implementation: that dialing the bare name `go` resolves
  through the in-process MagicDNS resolver. Fallback: configure the full
  `go.<tailnet>.ts.net` in `golinkHost`.

## Testing

### Go (`go test ./...`)

`golinkclient` tests run against real golink. `golink.New(golink.Options{DB:
NewSQLiteDB(tmp), Dev: true})` serves `Handler()` through `httptest`.
`github.com/tailscale/golink` is a test-only dependency, never imported by
`wasm/`, so SQLite stays out of `main.wasm`.

Cases:

- An absolute redirect is returned unmodified.
- A `{{.Path}}` template keeps the path and query exactly.
- An unknown link gives `NotFound`.
- `foo+` gives `GolinkUI("/.detail/foo")`.
- `Save` succeeds without an XSRF token, which proves `Sec-Golink` was sent.
- `Links` parses the export of several links.
- A stub 500 gives kind `http` with the body.
- A slow stub handler gives kind `timeout`.

### JS (`node --test`, no npm dependencies)

`ext/lib.js` functions and the state-operation queue with fake Chrome storage:

- parsing omnibox input or a URL into a path;
- filtering and ranking suggestions;
- serializing and acknowledging `stateWrite`s, including concurrent keys and
  a late write after logout or reset;
- the crash-loop limiter (2 within 60 s).

### WASM smoke test

Run `main.wasm` under Node with `$(go env GOROOT)/lib/wasm/wasm_exec_node.js`
and check that `golinkExt` has all seven functions. No network.

### CI (`.github/workflows/build.yml`)

- push / PR: `go test ./...`, `GOOS=js GOARCH=wasm go build ./wasm`, the WASM
  smoke test, and `node --test`.
- weekly schedule: `go get tailscale.com@latest && go mod tidy`, then the same
  steps. A failure means the copied setup code needs updating.

### Manual end-to-end (README checklist; needs a real tailnet)

- Load unpacked; interactive login; resolve; template link.
- 404 leads to a pre-filled save form; save the current tab; `foo+`;
  autocomplete.
- State survives a browser restart; logout behavior as documented.
- Auth-key login; an ACL that blocks golink gives the "unreachable" message.
- A direct `http://go/foo` navigation on a cold start shows the pending page
  immediately, then resolves; a reset during an in-flight state write stays
  logged out after restart.
- Typed `go/foo` with no scheme (see Known limitations).
