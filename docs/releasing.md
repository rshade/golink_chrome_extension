# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please)
from conventional commits. One merge and one approval click publish a signed
extension. The extension is not published to the Chrome Web Store; see
`docs/deploying.md` for how it reaches machines.

## How a release happens

1. Commits land on `main` as `fix:`, `feat:`, and so on. `docs:`, `test:`,
   `ci:`, and `chore:` commits do not open a release.
2. `.github/workflows/release.yml` keeps a release PR open. It bumps
   `ext/manifest.json` and `.release-please-manifest.json` and writes
   `CHANGELOG.md`.
3. Merging the release PR creates the tag (`vX.Y.Z`) and the GitHub Release.
4. The same workflow then runs the `checks` job (`mise run ci`, no secrets) on
   the tagged commit, and then the `package` job.
5. The `package` job waits for approval in the `release-signing` environment.
   After you approve it, it builds, signs, and uploads the assets.

Everything lives in one workflow because tags and PRs created with the default
`GITHUB_TOKEN` do not trigger other workflows.

Versions are plain dotted integers, because Chrome rejects any other
manifest version. Until 1.0.0, `feat:` bumps the minor version and `fix:`
bumps the patch.

## Release assets

| Asset | Purpose |
| --- | --- |
| `golink-ext-X.Y.Z.crx` | Signed CRX that Chrome installs and updates from |
| `update.xml` | Update manifest the extension's `update_url` points at |
| `golink-ext-X.Y.Z.zip` | Unpacked extension for the load-unpacked fallback |
| `THIRD_PARTY_NOTICES.md` | Licenses of every module compiled into the WASM |
| `SHA256SUMS` | Checksums of all other assets |

The manifest's `update_url` is
`https://github.com/rshade/golink_chrome_extension/releases/latest/download/update.xml`.
Installed copies read it from their own manifest, so it cannot change after the
first distributed release without stranding them.

`latest` skips prereleases. A prerelease is therefore never offered to
installed extensions.

## One-time repository setup

1. Create the environment `release-signing` with yourself as a required
   reviewer, and restrict deployments to the `main` branch.
2. Add the environment secret `EXTENSION_SIGNING_KEY`, holding the private key
   in PEM form.
3. In Settings, Actions, General, enable "Allow GitHub Actions to create and
   approve pull requests".

The secret belongs to the environment, not the repository, so pull requests
and forks never see it.

## The signing key

The key is an RSA 2048-bit private key. Its public half is the `key` field in
`ext/manifest.json`, and the extension ID is derived from it:

```sh
node scripts/extension-id.cjs ext/manifest.json
```

Keep a backup outside GitHub. `scripts/pack-crx.cjs` refuses to sign with a
key that does not match the manifest, and it never prints the key.

To compare a backup against the manifest without printing the key, compare the
SHA-256 of the DER public key from both sources.

### Rotation

Losing the key means a new extension ID, so every installed copy must be
reinstalled and its stored login is lost. A leaked key lets an attacker push
updates that Chrome will accept. Treat both the same way: generate a new key,
replace `key` in the manifest, update the secret, release, and redeploy the new
ID in your policy.

## Packaging locally

`mise run package` needs `RELEASE_KEY_FILE` pointing at a PEM file and writes
to `dist/release`. Use a throwaway key for experiments: a key that does not
match the manifest is rejected.

`mise run test-install` force-installs a CRX signed with a throwaway key into
Chrome for Testing by policy, then updates it. It runs in a private mount
namespace, so the policy file never touches the host.
