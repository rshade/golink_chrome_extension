# golink Chrome extension (Tailscale WASM): design

Date: 2026-10-21 (reconciled with the implementation 2026-10-26)
Status: implemented; manual tailnet acceptance not yet run

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
- golink stops its create form from overwriting an existing link by scoping
  the XSRF token to the placeholder name `.new`. `Sec-Golink` skips the XSRF
  check entirely, so an API save silently overwrites. **Decision:** `Save`
  checks `/.detail/{name}` first and returns kind `exists` unless the caller
  passes `overwrite`.
- In HTTPS mode golink's port 80 runs `RedirectHandler`, which answers every
  request with a `302` to the same path on its HTTPS MagicDNS name. That
  handler sits outside `Handler()`, so its responses lack the
  `Referrer-Policy` header every link redirect carries. The client uses this
  difference to tell an HTTPS upgrade from a link.
- A link whose target is another go link (`/other` or `http://go/other`)
  produces a redirect back to golink. golink's own `resolveLink` follows
  these, so the extension does too.

## Architecture

Standalone repository at `golink_chrome_extension/`, with its own Go module
pinned to `tailscale.com v1.104.2` (the version golink uses at `8b59870`).

```
README.md            setup, ACL snippet, login identity, limitations, manual E2E checklist
THIRD_PARTY_NOTICES.md  attribution and BSD license for the copied tsconnect code
build.sh             GOOS=js GOARCH=wasm go build → ext/main.wasm with upstream
                     tsconnect's feature tags (scripts/wasmtags);
                     copies $(go env GOROOT)/lib/wasm/wasm_exec.js → ext/
go.mod / go.sum      module golink-chrome-extension (no host prefix; rename when published)
package.json         "type": "module" and `node --test`; no npm dependencies
golinkclient/        plain Go, no build tags, testable on Linux
  client.go          Client{HTTP *http.Client, Host string}
                     Resolve(ctx, path) (Result, error)
                     Lookup(ctx, short) (*Link, error)
                     Save(ctx, short, long, overwrite) error
                     Links(ctx) ([]Link, error)
                     Ping(ctx) bool
  client_test.go
wasm/                //go:build js
  main_js.go         registers globalThis.golinkExt
  node_js.go         setup copied from tailscale.com@v1.104.2
                     cmd/tsconnect/wasm/wasm_js.go (attributed, SSH removed)
  state_js.go        synchronous in-memory ipn.StateStore that reports writes
  bridge_js.go       JS ⇄ Go promise helpers; passes the tailnet *http.Client
                     into golinkclient
scripts/
  wasmtags/          prints upstream tsconnect's build tags for build.sh
  wasm-smoke.cjs     runs main.wasm under Node and checks the exported API
tests/               node --test suites for every ext/ module
ext/                 load unpacked
  manifest.json      MV3; omnibox keyword "go"; permissions: offscreen, storage,
                     tabs, declarativeNetRequestWithHostAccess;
                     host permission http://go/*; status.html is a web-accessible
                     resource for the redirect rule; CSP extension_pages:
                     script-src 'self' 'wasm-unsafe-eval'
  background.js      service worker: omnibox, redirect-rule installation,
                     page message routing, login tab, links cache, settings
  lifecycle.js       offscreen document lifecycle: creation, hello handshake,
                     epochs, crash limit, restart/logout/reset/auth key
  state.js           serialized chrome.storage queue for tsState and settings
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
| `status()` | `{state, loginName, tailnet, hostname, golinkReachable, backendError}`. `golinkReachable` comes from `Ping`, a `GET /.opensearch` with a 5 s timeout, only when `Running`. `backendError` is the backend's last error message, with any auth key redacted. |
| `resolve(path)` | `path` includes the remainder and query, e.g. `"foo/bar?x=1"`. Returns `{redirect: url}`, `{notFound: true}`, `{golinkUI: path}`, or `{error: msg, kind}`. |
| `save(short, long, overwrite)` | Returns `{ok: true}` or an error object. With `overwrite` false, an existing link gives kind `exists`. |
| `links()` | Returns `[{short, long, owner}]`. |

Calls made before `start` reject with "node is not started".

### Error kinds

| Kind | Origin | Meaning |
|---|---|---|
| `unreachable` | golinkclient | dial or transport failure reaching golink |
| `timeout` | golinkclient | context deadline reaching golink |
| `http` | golinkclient | unexpected golink response; message is golink's body |
| `exists` | golinkclient | `save` without `overwrite` on an existing name |
| `loop` | golinkclient, worker | more than 10 go-link-to-go-link hops |
| `node-timeout` | lifecycle | the offscreen node didn't answer within 30 s |
| `fatal` | lifecycle | the node crashed, or crashed twice within 60 s |
| `authKey` | lifecycle | auth-key login rejected or timed out (20 s) |
| `unauthorized` | worker, lifecycle | message from an unexpected sender or a framed page |
| `stale`, `lifecycle` | lifecycle | message from a replaced document or epoch; internal failure |
| `url` | worker | redirect target or control URL isn't an http/https URL |
| `request` | worker | malformed page request or invalid `golinkHost` setting |

### `golinkclient.Resolve` classification

The HTTP client sets `CheckRedirect` to return `http.ErrUseLastResponse`.

| Response | Result |
|---|---|
| 302 with an absolute http/https `Location` | `Redirect(url)`, the exact `Location` string, unmodified |
| 302 with `Location` starting with `/.` | `GolinkUI(path)`, e.g. `/.detail/foo` for `foo+` |
| 302 with any other `Location` starting with `/` | an alias to another go link; resolved again, up to 10 hops, then kind `loop` |
| 302 with a missing or malformed `Location` | error, kind `http` |
| 2xx | `GolinkUI("/" + path)`: golink rendered one of its own pages, e.g. home for `""` |
| 404 | `NotFound` |
| other non-2xx | error, kind `http`, with the response body (trimmed) as the message |
| dial failure | error, kind `unreachable` |
| context deadline | error, kind `timeout` |

Every request first goes to `http://<golinkHost>/`. If that answers with a
`RedirectHandler`-style HTTPS upgrade (a 302 to `https://` on the same path and
query, with no `Referrer-Policy`, to the same host or a name under it), the
client switches to that HTTPS origin for the rest of its lifetime. TLS uses
`tlsdial`'s baked-in roots, since the browser runtime has no system roots.

`Save` posts `application/x-www-form-urlencoded` `short` and `long` to `/` with
`Sec-Golink: 1`, after a `Lookup` unless `overwrite` is set. `Links` parses the
`/.export` JSON lines. Timeouts: `Resolve` and `Save` (including its `Lookup`)
10 s, `Links` 20 s.

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
   that handshake before sending `start` or other calls. It also polls a
   `hello` RPC, which returns `{docId, ready, started, epoch}`, so a worker
   that restarted while WASM compiled recovers a missed `ready` and reuses a
   live, already-started document.
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

`chrome.storage.local` keys: `tsState` (`{epoch, values}`), `hostname`,
`golinkHost`, `controlURL`, `linksCache` (`{fetchedAt, links}`).
`chrome.storage.session` keys, which last until the browser exits:
`golinkLoginTab`, `golinkFatalTimestamps`, `golinkOffscreenUsed`. The epoch is initialized once and increments on logout,
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

1. The status page shows "Connecting…" immediately and polls `status` every
   2 s. The service worker calls `ensureOffscreen()`, then reads the node
   state.
2. Not `Running`: the worker answers `{pending: true}`. The page shows the
   login UI or waits for the node, then retries automatically once `Running`.
3. `Running`: the worker calls `resolve(path)` and returns a `navigate` URL.
   The status page navigates itself with `location.replace`, so it doesn't
   stay in session history and Back doesn't resolve again.
   - `redirect` to `http://go/…`: another go link; the worker resolves it
     again, up to 10 hops, then kind `loop`.
   - `redirect` elsewhere: must be http or https (else kind `url`). The page
     reapplies the original fragment unless the target has its own, as
     browsers do for redirects.
   - `notFound`: `status.html?create=<short>` (save form pre-filled).
   - `golinkUI`: `status.html?golinkUI=<path>`, which explains that golink's
     web UI needs native Tailscale and shows the link from `linksCache`,
     matched case- and dash-insensitively as golink does.
   - `error`: shown on the same page with **Try again** and **Reset device**.

### Settings

**Connection settings** in the status page sets `golinkHost` (host or
host:port, normalized to the form Go's `net/url` accepts) and `controlURL`.
Blank fields restore the defaults `go` and `https://controlplane.tailscale.com`.
Saving restarts the node with its existing identity (epoch advanced, values
kept) and clears `linksCache`. The redirect rule still only captures
`http://go/*`, whatever `golinkHost` is.

### Page sender validation

The worker accepts page commands only from `status.html` in this extension,
and only from the toolbar popup (no tab) or a top-level tab (`frameId` 0).
`status.html` must be web accessible for the redirect rule, which lets any
site frame it; a framed copy could otherwise be clickjacked into **Log out**,
**Reset device**, or **Replace existing link**. A framed status page also shows
a notice instead of its UI. Offscreen events are accepted only from
`offscreen.html`, and offscreen RPCs only from `background.js`.

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
opens the URL with `chrome.tabs.create` and records the tab ID in
`chrome.storage.session`, reusing that tab for a later login URL. On `Running`,
it closes that tab and the status page resumes any pending resolve. The tab
only counts as the login tab while it still shows the control server's login
pages, not its `/admin` console, so a tab the user has moved on in is never
closed.

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
  request. After 2 fatals within 60 s (timestamps in
  `chrome.storage.session`), every request fails with kind `fatal` and the
  status page shows the error with **Reset device**, which clears the limit.
- **golink unreachable:** message tells the user to check that ACLs allow this
  device to reach golink on TCP 80, and on 443 if golink serves HTTPS.
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

Cases against real golink:

- An absolute redirect is returned unmodified.
- A `{{.Path}}` template keeps the path and query exactly.
- An unknown link gives `NotFound`.
- `foo+` gives `GolinkUI("/.detail/foo")`.
- Relative aliases are followed; a cycle gives kind `loop`.
- `Save` succeeds without an XSRF token, which proves `Sec-Golink` was sent.
- `Save` without `overwrite` refuses an existing name with kind `exists`,
  including a different-case spelling.
- `Links` parses the export of several links.

Cases against stub handlers: HTTPS upgrade (and link redirects that must not
be treated as one), redirects never followed, the raw request URI preserved,
query bytes escaped, malformed `Location`, 500 gives kind `http` with a bounded
body, slow handler gives kind `timeout`, transport errors give `unreachable`,
malformed hosts and fragments rejected, response bodies closed.

`GOOS=js GOARCH=wasm go test ./wasm` runs under Go's `go_js_wasm_exec`: the
state store copies values and reports writes, invalid base64 is rejected, and a
throwing JS callback reports exactly one fatal.

### JS (`node --test`, no npm dependencies)

`tests/` covers every `ext/` module with fake Chrome APIs:

- `lib.js`: parsing omnibox input or a URL into a path, fragments, filtering
  and ranking suggestions, escaping, the crash-loop limiter (2 within 60 s);
- `state.js`: serializing and acknowledging `stateWrite`s, including
  concurrent keys and a late write after logout or reset;
- `lifecycle.js`: the hello handshake, worker restart reusing a live document,
  stale epochs, crashes and the crash limit, auth-key restarts, logout, reset;
- `background.js`: omnibox, redirect rule repair, page sender validation
  (including framed pages and the popup), login tab handling, links cache,
  resolve hops;
- `status.js`: pending, create, golinkUI, and direct-capture modes, polling,
  actions, settings, and error display.

### WASM smoke test

`scripts/wasm-smoke.cjs` loads `ext/wasm_exec.js` into Node, runs `main.wasm`,
checks that `golinkExt` has all seven functions, and checks that each call other
than `start` returns a Promise that rejects with "node is not started". No
network.

### CI (`.github/workflows/build.yml`)

- push / PR: `go test ./...`, the js/wasm Go tests, `./build.sh`, the WASM
  smoke test, `node --test`, and a check that `go list -deps ./wasm` contains
  neither golink nor `modernc.org/sqlite`.
- weekly schedule (Monday 09:23 UTC): a matrix of the pinned dependencies and
  `go get tailscale.com@latest && go mod tidy`, then the same steps. A
  `latest` failure means the copied setup code needs updating; the job never
  commits the bump.

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
