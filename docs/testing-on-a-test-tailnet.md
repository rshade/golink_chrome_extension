# Testing the extension on a test tailnet

This guide walks through installing the extension on a machine with desktop
Chrome, running a throwaway golink server on a test tailnet, and checking
every behavior the design spec promises.

`scripts/test-bundle.sh` produces two archives in `dist/`:

- **`golink_chrome_extension-<commit>-full.tar.gz`**: the whole repository,
  with Git history, the built extension in `ext/`, and the test bundle below
  in `dist/`. Use this one to fix problems as you find them (see section 8).
- **`golink-ext-test-<commit>.tar.gz`**: only what testing needs. This guide
  is its `README.md`.

Paths below are relative to the test bundle. In the full repository they
are:

| Test bundle | Full repository |
|---|---|
| `extension/` | `ext/` (load this one, so rebuilds take effect) |
| `golink/` | `dist/golink-ext-test-<commit>/golink/` |
| `fixtures/` | `testdata/e2e/` |

```
extension/        the built extension; load this directory unpacked
golink/           golink server binaries, pinned to the commit the tests use
fixtures/
  links.jsonl     test links loaded into golink at startup
  policy.hujson   tailnet policy additions
  framed-check.html  page for the framing check (I1)
source.tar.gz     the extension source at the bundled commit
VERSION           extension commit and pinned golink/Tailscale versions
SHA256SUMS
```

Expect about an hour for a full pass. Sections A–C are the core; the rest can
be done in any order afterwards.

## 1. What you need

- A machine with desktop **Chrome 116 or later** (macOS, Linux, or Windows).
- A **test tailnet** you administer. A new personal tailnet is fine: sign up
  at <https://login.tailscale.com> with an identity you don't use for work.
- Somewhere to run golink on that tailnet. The same machine works: golink
  joins with its own embedded Tailscale node and doesn't need, or touch, a
  native Tailscale install.
- Native Tailscale on the Chrome machine is fine for everything except H2.
  The extension intercepts `http://go/*` before Chrome looks the name up, and
  it reaches golink through its own node, whatever the machine is joined to.

## 2. Set up the test tailnet

In the admin console of the **test** tailnet:

1. **DNS** page: check that **MagicDNS** is on, and turn on **HTTPS
   Certificates**. golink then serves HTTPS and redirects port 80 to it, which
   exercises the extension's HTTPS upgrade. (Leave it off if you want a plain
   HTTP pass; see G3.)
2. **Access controls**: merge the sections of `fixtures/policy.hujson` into
   the policy and save.
3. **Settings → Keys → Generate auth key**, twice:
   - for golink: tag `tag:golink`, not reusable, not ephemeral.
   - for the extension (used in section F): tag `tag:golink-ext`,
     pre-approved, not ephemeral.
4. If **Device approval** is turned on, either turn it off for the test
   tailnet or be ready to approve devices as they appear.

## 3. Run golink

Pick the binary for the machine that will run golink and start it from the
bundle directory. `golink.db` holds the links and `golink-state/` holds
golink's Tailscale identity.

```sh
# macOS (Apple silicon) and Linux; pick the right binary from golink/
TS_AUTHKEY=tskey-auth-... ./golink/golink-darwin-arm64 \
  -sqlitedb golink.db -snapshot fixtures/links.jsonl \
  -config-dir golink-state -verbose
```

```powershell
# Windows PowerShell
$env:TS_AUTHKEY = "tskey-auth-..."
.\golink\golink-windows-amd64.exe -sqlitedb golink.db -snapshot fixtures\links.jsonl -config-dir golink-state -verbose
```

The log should say `Restored 10 links.`, and a device named `go` tagged
`tag:golink` appears in the admin console. The auth key is only needed the
first time; later runs reuse `golink-state/`.

If macOS refuses to run a binary that arrived through a browser download,
clear the quarantine flag: `xattr -d com.apple.quarantine golink/golink-darwin-*`.

**To restore the fixtures** between passes, stop golink, delete `golink.db`,
and start it again. Keep `golink-state/` so it stays the same device.

## 4. Load the extension

Use a separate Chrome profile so testing doesn't touch your normal one:

```sh
# macOS
open -na "Google Chrome" --args --user-data-dir="$HOME/golink-ext-profile"
# Linux
google-chrome --user-data-dir="$HOME/golink-ext-profile"
# Windows (cmd)
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=%USERPROFILE%\golink-ext-profile
```

In that window: open `chrome://extensions`, turn on **Developer mode**,
choose **Load unpacked**, and select the bundle's `extension/` directory (in
the full repository, `ext/`). Pin
**Golink over Tailscale** to the toolbar. Note the extension ID shown on its
card; I1 needs it.

The manifest declares a `key`, so the extension ID is always
`mdfffmleleklegallldnnbmbicdhflco`, whichever directory you load it from. A
profile that loaded the extension before the key was added saw a different,
path-derived ID; remove that copy, load the extension again, and log in again.

**Logs**, if something goes wrong: on the extension's card, **service worker**
opens the worker's DevTools, and **Inspect views: offscreen.html** (present
once the node has started) opens the node's DevTools. Copy any red errors
into your results.

"Quit Chrome" below means closing every window of this profile (on macOS,
**Chrome → Quit** in that instance), then starting it again with the same
command.

## 5. Checks

Record **pass**, **fail** (with what you saw), or **skip** for each. Exact
on-screen text is quoted where it matters.

### A. Login

| ID | Steps | Expected | Result |
|---|---|---|---|
| A1 | Click the toolbar icon. | Popup shows `Log in to Tailscale`, a **Log in** button, and an auth-key field. | |
| A2 | Click **Log in**. Sign in with the test tailnet identity in the tab that opens. | Tab closes by itself. Popup shows `Connected`, a line with your login, the tailnet name, and `golink-ext-xxxxxx`, and `Golink is reachable.` | |
| A3 | Admin console → Machines. | One new device `golink-ext-xxxxxx`, owned by you. | |

### B. Resolving links

Open each URL in the address bar (type `http://` explicitly). For omnibox
rows, type `go`, press Tab or Space so the box shows the extension's name,
then type the rest.

| ID | Steps | Expected | Result |
|---|---|---|---|
| B1 | `http://go/ext-simple` | Lands on `https://example.com/`. | |
| B2 | `http://go/ext-simple/a/b?x=1&x=2` | `https://example.com/a/b?x=1&x=2` | |
| B3 | Omnibox: `go` Tab `ext-search/hello world` | DuckDuckGo search for `hello world` (`?q=hello+world`). | |
| B4 | `http://go/ext-user` | `https://example.com/u/<your login>`. Proves golink sees your identity. | |
| B5 | `http://go/ext-alias` (target `/ext-simple`) | `https://example.com/` | |
| B6 | `http://go/ext-alias-abs` (target `http://go/ext-simple`) | `https://example.com/` | |
| B7 | `http://go/ext-loop-a` (a → b → a) | Error page: `too many go link aliases`, with **Try again** and **Reset device**. | |
| B8 | `http://go/ext-page#section` | `https://example.com/page#section` (fragment kept). | |
| B9 | `http://go/EXT-MIXED-CASE` | `https://example.com/mixed` | |
| B10 | `http://go/ext-simple+` | Page headed `Open golink's web UI`, explaining it needs native Tailscale, with a **Cached link** box: short `ext-simple`, target `https://example.com/`. | |
| B11 | After B1, press Back. | Returns to the page before, not to a `Connecting…` page that resolves again. | |
| B12 | `http://go/` | The `Open golink's web UI` page for path `/`. | |

### C. Saving links

| ID | Steps | Expected | Result |
|---|---|---|---|
| C1 | `http://go/ext-new-1` | Save form with `Link not found. Enter a target URL to create it.` and short name `ext-new-1` filled in. | |
| C2 | Enter `https://example.org/` and **Save link**. | `Link saved.` Then `http://go/ext-new-1` lands on `https://example.org/`. | |
| C3 | Open `https://example.net/`, click the toolbar icon, enter short name `ext-new-2`, **Save link**. | Target was filled in with `https://example.net/`. `Link saved.` `http://go/ext-new-2` works. | |
| C4 | In the popup, save `ext-replace` → `https://example.com/new`. | Warning: `go/ext-replace already points to https://example.com/old. Replace it for everyone in the tailnet?` and a **Replace existing link** button. Nothing changed yet: `http://go/ext-replace` still goes to `/old`. | |
| C5 | Click **Replace existing link**. | `Link saved.` `http://go/ext-replace` now goes to `/new`. | |
| C6 | `http://go/ext-new-1+` | Cached link shows **Owner** = your login. | |
| C7 | Click the toolbar icon, type `ext-new` in **Filter links**. | **All go links** lists `ext-new-1` and `ext-new-2` with targets and owner; typing sends no request. Clicking a name opens `http://go/<name>`. | |

### D. Autocomplete

| ID | Steps | Expected | Result |
|---|---|---|---|
| D1 | Omnibox: `go` Tab `ext-` | Up to five suggestions: the first `ext-*` links alphabetically, ignoring case (`ext-alias`, `ext-alias-abs`, `ext-loop-a`, …), each with its target. | |
| D2 | Omnibox: `go` Tab `loop` | `ext-loop-a` and `ext-loop-b` (substring match). | |
| D3 | Omnibox: `go` Tab `ext-new` right after C2 | `ext-new-1` is suggested (cache refreshed after the save). | |

### E. Persistence and lifecycle

| ID | Steps | Expected | Result |
|---|---|---|---|
| E1 | Quit Chrome and start it again. Without opening the popup, open `http://go/ext-simple`. | `Connecting…` for a few seconds, then `https://example.com/`. No login prompt. Admin console still shows one `golink-ext-` device. | |
| E2 | Open `chrome://serviceworker-internals`, find the extension, click **Stop**. Then open `http://go/ext-simple`. | Resolves quickly, no reconnect delay, no new device. | |
| E3 | Popup → **Log out**. | Popup returns to `Log in to Tailscale`. In the admin console the device shows as logged out or expired (it isn't deleted). | |
| E4 | Quit and restart Chrome; open the popup. | Still `Log in to Tailscale`; it did not log back in. | |
| E5 | Log in again (as A2), then **Reset device**. | Returns to `Log in to Tailscale`. Same hostname is used at the next login. | |

### F. Auth key

| ID | Steps | Expected | Result |
|---|---|---|---|
| F1 | In `Log in to Tailscale`, paste the `tag:golink-ext` key and **Use auth key**. | `Connected`. Admin console shows the device tagged `tag:golink-ext`. | |
| F2 | `http://go/ext-user` | `https://example.com/u/tagged-devices` (golink sees the tag, not a person). | |
| F3 | Save `ext-new-3` → `https://example.org/3`, then `http://go/ext-new-3+`. | **Owner** is `tagged-devices`. | |
| F4 | Open the **service worker** DevTools and run `chrome.storage.local.get(null).then(v => JSON.stringify(v).includes('tskey'))` | `false`: the key wasn't stored. | |
| F5 | Quit and restart Chrome; open the popup. | Still `Connected` with the tag. | |
| F6 | **Reset device**, then submit `tskey-auth-invalid` as the key. | `Auth-key login failed. Check the key and try again.` and the login controls come back. | |

### G. Network and ACLs

| ID | Steps | Expected | Result |
|---|---|---|---|
| G1 | While logged in with the auth key (F1), delete the `tag:golink-ext` grant from the policy. Wait a minute, reopen the popup, then open `http://go/ext-simple`. | Popup: `Golink is unreachable. Check ACL access to the golink server.` Resolve page: `Golink is unreachable. Check that ACLs allow this device to reach the golink server on port 80, and on 443 if it serves HTTPS.` (or a timeout). Restore the grant afterwards. | |
| G2 | Popup → **Connection settings**: leave **Golink host** blank (the default `go`). Record whether B1 worked with it. If B1 failed, set the host to `go.<tailnet>.ts.net`, save, and retry. | Record which host worked. `Settings saved. Reconnecting…` after saving, without a new login. | |
| G3 | Optional: turn **HTTPS Certificates** off, restart golink, repeat B1 and C2. | Same results over plain HTTP. | |

### H. Browser behavior

| ID | Steps | Expected | Result |
|---|---|---|---|
| H1 | Type `go/ext-simple` in the address bar with **no** `http://` and press Enter. | Record what happens: lands on example.com, or runs a search. Either is acceptable; this is the open question in the spec. | |
| H2 | With native Tailscale **off** on this machine, save a link to a device that only exists on the test tailnet (e.g. `https://go.<tailnet>.ts.net/.help`), then open it. | The extension resolves it, but the tab can't load it. This is the documented limitation. | |

### I. Security

| ID | Steps | Expected | Result |
|---|---|---|---|
| I1 | In `fixtures/`, run `python3 -m http.server 8000`. Open `http://localhost:8000/framed-check.html?id=<extension ID>`. | The dashed box shows only `This page cannot be embedded in another site.` | |
| I2 | In that tab's DevTools console, switch the context dropdown to the extension frame and run `chrome.runtime.sendMessage({channel: 'golink', target: 'worker', method: 'status', args: []}).then(r => console.log(JSON.stringify(r)))` | `{"ok":false,"error":{"kind":"unauthorized","message":"Extension page must not be framed"}}` | |

### J. Deleted device (known limitation)

| ID | Steps | Expected | Result |
|---|---|---|---|
| J1 | While logged in, delete the `golink-ext-` device in the admin console, then open `http://go/ext-simple` and the popup. | The documented limitation: the popup may still say `Connected` while golink is unreachable, or requests time out. | |
| J2 | **Reset device**. | `Log in to Tailscale`; logging in again works. | |

## 6. Reporting results

Send back:

- the filled tables (or just the failures and skips);
- Chrome version (`chrome://version`), OS, and the bundle's `VERSION` file;
- whether HTTPS certificates were on, and which golink host worked (G2);
- what H1 did;
- console errors from the service worker and offscreen DevTools for any
  failure.

Never paste auth keys into results.

## 7. Clean up

- `chrome://extensions` → **Remove** the extension; delete the
  `golink-ext-profile` directory.
- Stop golink; delete `golink.db` and `golink-state/`.
- Admin console: delete the `golink-ext-` and `go` devices and revoke unused
  auth keys.

## 8. Making changes (full repository)

Fixing problems on the test machine needs Go (any version from 1.21 on
fetches the 1.27.3 toolchain that `go.mod` asks for) and Node.js 26, plus
network access for Go modules. `CLAUDE.md` at the repository root has the
commands and layout for Claude Code.

After a change:

1. **Go changes** (`golinkclient/`, `wasm/`): run `./build.sh`.
   **JS, HTML, CSS, or manifest changes** in `ext/`: no build needed.
2. `chrome://extensions` → the extension's reload button. Reloading closes the
   node, so the next request starts it again. Its identity is kept, so no new
   login.
3. Rerun the failed check, then the checks in the same section.
4. Run the automated tests (see `CLAUDE.md`) and commit. To take the fixed
   code back to another machine, rerun `scripts/test-bundle.sh` or use Git.
