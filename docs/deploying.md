# Deploying

The extension is not on the Chrome Web Store. You install it from a GitHub
Release, either pushed to managed machines by policy or loaded by hand.

- Extension ID: `mdfffmleleklegallldnnbmbicdhflco`. It is fixed by the `key` in
  `ext/manifest.json` and does not change between releases.
- Update URL:
  `https://github.com/rshade/golink_chrome_extension/releases/latest/download/update.xml`

Each snippet below is labeled **tested** or **untested**. Tested means
`mise run test-install` runs it against a real Chrome build in CI. Untested
means it follows Chrome's documented policy format but nobody has run it on
that platform.

## Other browsers

Only Chrome is supported. Work on the others is tracked in
[Edge (#11)](https://github.com/rshade/golink_chrome_extension/issues/11),
[Brave (#12)](https://github.com/rshade/golink_chrome_extension/issues/12), and
[Firefox (#13)](https://github.com/rshade/golink_chrome_extension/issues/13).

## Managed devices

Force-installing an extension from outside the Chrome Web Store is honored
only on managed machines on Windows and macOS. Linux honors it on any
machine. The Windows and macOS requirements below come from Chrome's
enterprise documentation and are **unverified** here.

- Linux: nothing beyond write access to the policy directory.
- Windows: a device joined to a domain, or enrolled in Chrome Browser Cloud
  Management.
- macOS: a device managed by MDM (Jamf, for example), or enrolled in Chrome
  Browser Cloud Management.

On an unmanaged Windows or macOS machine, use the load-unpacked fallback
below.

## Policy

All platforms use the `ExtensionSettings` policy with this value:

```json
{
  "ExtensionSettings": {
    "mdfffmleleklegallldnnbmbicdhflco": {
      "installation_mode": "force_installed",
      "update_url": "https://github.com/rshade/golink_chrome_extension/releases/latest/download/update.xml"
    }
  }
}
```

Chrome installs the version named in the update XML, then checks the same URL
for newer versions on its own schedule. A release becomes visible to installed
copies only once it is the repository's latest non-prerelease release.

### Linux (tested)

Tested on Linux with Chrome for Testing 156, using a managed policy file.
`test-install` writes this policy for Chrome for Testing at
`/etc/opt/chrome_for_testing/policies/managed/`, force-installs a signed CRX,
checks the loaded ID, publishes a newer version, and checks that Chrome
updates. It points `update_url` at a local server instead of GitHub and sets
`override_update_url` so the test URL wins over the manifest.

The GitHub URL itself was checked once, by hand, against the v0.1.0 release:
Chrome for Testing 156 force-installed the extension from the real
`update_url` through GitHub's redirects. Updating from a later release against
GitHub has not been checked yet.

For Google Chrome, put the same JSON in
`/etc/opt/chrome/policies/managed/golink.json`. For Chromium, use
`/etc/chromium/policies/managed/golink.json`. Those two paths are **untested**.

### Windows (untested)

Set the registry value `ExtensionSettings` under
`HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome` as a string holding the
JSON above on one line. Deploy it with Group Policy or your management tool.

### macOS with Jamf (untested)

Create a configuration profile with a custom settings payload for the
preference domain `com.google.Chrome`. Add `ExtensionSettings` as a
dictionary keyed by the extension ID, with the two string values from the JSON
above.

### Check that it worked

Open `chrome://extensions` and look for "Golink over Tailscale" marked as
installed by your organization. `chrome://policy` shows whether the policy was
read, and `chrome://extensions-internals` lists the ID, version, and install
location.

## Load unpacked (fallback)

1. Download `golink-ext-X.Y.Z.zip` and `SHA256SUMS` from the latest release
   and check the zip with `sha256sum -c SHA256SUMS --ignore-missing`.
2. Unzip it to a directory you will keep.
3. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked",
   and select that directory.

Unpacked installs do not update themselves. Replace the directory contents
and reload the extension to move to a new version. They get the same extension
ID because the manifest carries the `key`.

Chrome 137 and later branded builds no longer accept the `--load-extension`
command-line flag. Loading through the extensions page still works.

## Notices

`THIRD_PARTY_NOTICES.md` in each release lists the licenses of every module
compiled into the extension.
