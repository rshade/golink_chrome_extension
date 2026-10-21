# Golink over Tailscale for Chrome

A Chrome extension that embeds a Tailscale node in WebAssembly to resolve and save links on an existing [golink server](https://github.com/tailscale/golink). The extension can reach that server without native Tailscale on the computer. Chrome still loads each resolved destination through its normal network connection.

## Build and load

Use Linux or another environment supported by Go, Go 1.27.3 as specified in `go.mod`, Node.js 22, and Chrome 116 or later. Chrome 156 was used for the browser checks below. There are no npm dependencies. The local verification environment used Node 18.19.1; Node 22 is recommended and configured in CI.

From the repository root:

```bash
go version
node --version
./build.sh
go test ./...
node --test
node scripts/wasm-smoke.cjs
```

The build writes `ext/main.wasm` and copies the matching Go runtime to `ext/wasm_exec.js`. Both are ignored by Git. Rebuild after Go changes or a Go toolchain update. The smoke test checks the seven Promise API functions without starting a network node. Go tests use a real golink server and SQLite locally; neither is part of the WASM dependency graph.

1. Run an existing golink server in your tailnet. Give this extension device permission to reach its HTTP service on TCP port 80.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `ext/` directory.
3. Open the extension popup and click **Log in**. Complete the Tailscale login in the new tab. Approve the device in the admin console if your tailnet requires it. When the node reaches `Running`, the login tab closes and the popup shows its user, tailnet, hostname, and golink reachability.
4. If golink's bare name `go` fails, open **Connection settings**, set **Golink host** to the full MagicDNS name such as `go.example.ts.net`, and save. Enter a hostname, optionally with a port, rather than a URL. The optional control URL defaults to `https://controlplane.tailscale.com`. Saving settings reconnects with the existing identity. Blank fields restore defaults; the form does not display the currently saved settings.

Use the omnibox by typing `go`, pressing Tab or Space to activate the keyword, and entering a short name such as `handbook`. Paths and queries can follow the name. You can also open `http://go/handbook` directly. The direct capture rule remains `http://go/*` even when you configure a full MagicDNS backend hostname. Typing `go/handbook` without a scheme may become a search; this behavior is still pending browser verification. Use the explicit HTTP URL or the omnibox keyword.

To save the current tab, open the popup on an ordinary web page, enter a short name, check the prefilled target URL, and save. An unknown link opens a save form with the missing name prefilled. A name ending in `+` shows the cached link and explains how to use golink's web UI. Autocomplete ranks prefixes before substrings using a local cache. Typing does not initiate tailnet traffic. The cache becomes stale after five minutes and refreshes during node activity and after a successful save. If a refresh fails after saving, the UI reports that warning separately from the successful save.

## Tailnet access and identity

For demos, a tagged auth key gives the extension a predictable policy identity. In `NeedsLogin`, paste the key into the popup's auth-key field and submit it. Use tags and `tagOwners` appropriate to your tailnet. For example, merge a grant like this into your existing policy:

```json
{"grants":[{"src":["tag:golink-ext"],"dst":["tag:golink"],"ip":["tcp:80"]}]}
```

This assumes the extension device has `tag:golink-ext` and the server has `tag:golink`. Define appropriate owners for both tags in `tagOwners`, and authorize the key's tags. An interactive login needs the equivalent source grant for that user or group. Follow your server's golink authorization policy too. A tagged device creates links under its tag identity; interactive login creates links under the person's identity.

An ordinary interactive login persists its device identity. A non-ephemeral auth key also creates an identity that can persist across browser restarts. An ephemeral key causes Tailscale to clean up the device after it has been offline for a while, so it is useful for disposable demos but unsuitable for durable registration.

**Log out** expires the backend device key, clears local node values and the links cache, and starts a logged-out node. A non-ephemeral device remains in the admin console until an administrator deletes it. Ephemeral devices are cleaned up by Tailscale.

**Reset device** attempts logout, closes the node document, clears node values and cached links, clears the crash retry limit, and starts a new logged-out node. It keeps the generated hostname and connection settings. Use it when login or node recovery is stuck. Reset advances a persisted epoch so late writes from the old document cannot restore the cleared identity. It cannot guarantee removal of a device from the admin console if backend logout fails.

## Runtime and privacy

The service worker owns browser routing, settings, and `chrome.storage.local`. An offscreen document owns the long-running Go WASM node and uses only `chrome.runtime` among extension APIs. A worker restart can reuse the live node document. After the browser exits, the next request loads and compiles WASM and reconnects, which can take several seconds. A pending status page appears during startup.

Local extension storage contains base64-encoded Tailscale state, including sensitive device identity material and a log-policy identity, the generated `golink-ext-<6 hex>` hostname, connection settings, and cached exported link names, targets, and owners. Base64 is an encoding, not encryption. Treat access to the Chrome profile as access to that device identity. Identity writes must reach storage before the extension publishes `Running` or completes identity-changing operations.

Auth keys pass through memory for registration. The extension clears the input on submission and does not persist or log the key. Ordinary operation contacts Tailscale's control service, DERP relays, and the configured golink server. The copied Tailscale log uploader also sends node diagnostic logs to Tailscale's logging service. The extension does not proxy tab traffic. It reads the active tab URL to prefill the popup save form; golink requests travel through Go's netstack HTTP transport rather than browser `fetch`.

## Limits and upstream maintenance

- The browser node uses DERP relays over WebSocket only, without direct UDP paths. Lookups can be slower than native Tailscale.
- A destination available only inside the tailnet still requires native Tailscale to load in a normal browser tab. Golink's browse, edit, and delete web UI also requires native Tailscale. The extension provides resolve, save, and cached suggestions.
- Browser navigation accepts HTTP and HTTPS targets. The Go client preserves redirect `Location` values and path/query escaping, but other destination schemes are rejected at the navigation boundary.
- After two fatal node exits within 60 seconds, automatic recovery stops. Use **Reset device** to permit immediate recovery or retry after the window expires.
- `tailscale.com` is pinned to `v1.104.2`. It predates upstream fix [`0f3c767d1`](https://github.com/tailscale/tailscale/commit/0f3c767d1) for devices deleted from the admin console. A deleted or cleaned-up ephemeral device can still appear `Running` while golink is unreachable. Use **Reset device** to return to `NeedsLogin`, then register again.
- Bare `go` resolution inside the node and scheme-less `go/<name>` navigation remain pending real tailnet/browser checks. Configure the full MagicDNS name and use an explicit `http://go/<name>` URL when needed.
- This repository supports loading an unpacked extension. It has no Chrome Web Store publishing pipeline.

The node setup and Promise helpers adapt `cmd/tsconnect/wasm/wasm_js.go` from the pinned Tailscale release, with SSH removed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source attribution and the BSD license. The real-server test dependency is pinned to golink commit `8b59870` through `v1.0.1-0.20261021144816-8b59870a054f`.

## CI

[build.yml](.github/workflows/build.yml) runs Go tests, the WASM build and smoke test, Node tests, and a WASM dependency check on pushes and pull requests. It uses Go from `go.mod` and Node 22. Monday at 09:23 UTC, the scheduled matrix checks both pinned dependencies and `tailscale.com@latest` with `go mod tidy`. Both modes run the same checks. The latest mode changes only its job checkout and does not commit dependency updates. Manual dispatch checks the pinned dependencies.

The schedule starts only after the workflow exists on the default branch. Enable GitHub Actions failure notifications for this repository in your GitHub notification settings and inspect the Actions tab after scheduled runs. Check that schedules remain enabled, especially after repository inactivity. A latest failure calls for reviewing upstream internals and the copied setup code; it does not automatically update the pin. Review action versions when updating this workflow, and use full action SHAs if repository policy requires them. Local checks do not establish that GitHub CI or the latest-dependency job has run.

## Observed browser checks

On 2026-10-21, Chrome 156.0.8078.47 on headless Linux loaded the unpacked extension using Chrome DevTools Protocol `Extensions.loadUnpacked`. The real built WASM, offscreen document, and worker reached `NeedsLogin` without an injected node. The observed checks passed:

| Check | Observation |
|---|---|
| Full status tab | Login/auth controls visible, empty error, centered content width 640px in a 780px viewport; all five inputs had native labels |
| Actual action popup | Opened through `chrome.action.openPopup()`; viewport, content, and scroll width were 360px with no horizontal overflow; auth key used a password input with autocomplete off |
| Keyboard | Tab reached auth key, submit button, and Connection settings in order with visible focus outlines; Enter opened settings |
| Settings validation | Submitting `bad/host` through the real form showed the worker's hostname validation error and enabled recovery controls |
| Reset | Clicking Reset returned the real node to `NeedsLogin` with login/auth controls enabled and no error |
| Page/popup console | Runtime/Log observation reported no error events |

The temporary Node 18 CDP helper emitted an experimental Undici WebSocket warning. That warning came from the helper, not the extension. These checks used no tailnet credentials and do not establish successful login, remote operations, or identity retention after browser restart.

## Manual tailnet acceptance

Run the following on a test tailnet whose golink server you can edit for fixtures. Record the date, Chrome version, OS, and which golink hostname worked beside the completed results. Never put auth keys in this record. The results below remain `not run` because they require additional observed acceptance; automated controller tests and the headless checks above do not substitute for them.

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
