# Tasks

## 1. Extension ID from a manifest key

- [x] 1.1 Write a failing test in `tests/` that derives an extension ID from a known public key and compares it with a fixed expected ID, then add `scripts/extension-id.cjs` and verify `node --test` passes
- [x] 1.2 Generate the signing key locally (outside the repo, never committed), add its public half as `key` in `ext/manifest.json`, and verify `node scripts/extension-id.cjs ext/manifest.json` prints a 32-character ID in `a`-`p`
- [x] 1.3 Add a test that fails if `ext/manifest.json` lacks `key`, then verify `mise run test-browser` still passes and prints the same ID the script derives
- [x] 1.4 Note in `docs/testing-on-a-test-tailnet.md` that existing unpacked installs change ID once and must log in again, and verify `markdownlint` reports nothing new

## 2. CRX packer

- [x] 2.1 Write failing tests for `scripts/pack-crx.cjs` using a throwaway key generated in the test: the output starts with `Cr24`, declares version 3, carries the key's ID, and its signature verifies over the zip; verify they fail before the script exists
- [x] 2.2 Implement `scripts/pack-crx.cjs` with `node:crypto` only (key from a path argument, never printed) and verify the tests from 2.1 pass
- [x] 2.3 Add a test that the packaged manifest `version` equals the version argument and the zip holds `main.wasm` and `wasm_exec.js`, and verify it passes against a real `./build.sh` output
- [x] 2.4 Add a `mise` task `package` that builds and packs, and verify `mise run package` produces a `.crx` and `.zip` from a copy of `ext/` carrying a throwaway key (the packer rejects a key that does not match the manifest)

## 3. Update XML, checksums, and release assets

- [x] 3.1 Write a failing test for `scripts/update-xml.cjs`: given an ID, version, and CRX URL it emits a `gupdate` document with that `appid`, `codebase`, and `version`; then implement it and verify the test passes
- [x] 3.2 Add the unpacked-zip step and a `SHA256SUMS` file covering the CRX, update XML, zip, and notices; verify `sha256sum -c SHA256SUMS` passes on the assembled `dist/release/` directory
- [x] 3.3 Add `update_url` to `ext/manifest.json` pointing at `releases/latest/download/update.xml`, and add a test that it is an HTTPS URL on this repository, then verify `node --test` passes

## 4. License report

- [x] 4.1 Write a failing test that every non-standard-library module in `GOOS=js GOARCH=wasm go list -deps ./wasm` has a license file found by `scripts/licenses.sh`; verify it fails before the script exists
- [x] 4.2 Implement `scripts/licenses.sh` to append each module's license to a generated notices file alongside `THIRD_PARTY_NOTICES.md`, and verify the test passes and the output names `tailscale.com`
- [x] 4.3 Wire the notices file into the release asset set and verify it is present in `dist/release/`

## 5. Install test on Linux

- [x] 5.1 Write a script that serves a built `update.xml` and CRX from localhost, writes a managed `ExtensionSettings` policy for the extension ID, starts Chrome with it, and asserts the extension loads with that ID; verify it passes locally on this machine's Chrome or Chromium
- [x] 5.2 Extend it to publish a higher version and assert Chrome updates to it, and verify the version changes without user action
- [x] 5.3 Add `mise run test-install` and run it as a job in `build.yml`; verify the job passes on a pull request and that the policy file is written only inside the test's private mount namespace, never to the host's /etc

## 6. Release automation

- [x] 6.1 Add `release-please-config.json` and `.release-please-manifest.json` (`simple` type, `ext/manifest.json` on `$.version`, `bump-minor-pre-major`) and verify `npx release-please` dry-run, or the JSON schema check, accepts them
- [x] 6.2 Add `.github/workflows/release.yml`: release-please, then a `checks` job running `mise run ci`, then a `package` job in the `release-signing` environment that packs, writes the key only to a mode-600 temporary file, uploads the assets, and removes the key; verify with `actionlint` and by reading the job for any step that echoes the key
- [x] 6.3 Document the one-time repository setup in `docs/releasing.md`: create the environment with required reviewers and a main-branch restriction, add the `EXTENSION_SIGNING_KEY` secret, enable "Allow GitHub Actions to create and approve pull requests", and keep an offline key backup; verify `markdownlint` passes
- [ ] 6.4 Perform that setup on the repository and verify a `docs:` commit alone opens no release PR while a `fix:` commit opens one

## 7. Deployment documentation

- [x] 7.1 Write `docs/deploying.md` for Chrome only: the extension ID, the policy for Linux, Windows, and macOS (Jamf configuration profile), the load-unpacked fallback and how to update it, and the stated managed-device requirements per OS; verify `markdownlint` passes
- [x] 7.2 Label each snippet tested or untested, naming OS, Chrome version, and management method for tested ones, and verify the Linux snippet is the policy file used by `mise run test-install`
- [x] 7.3 Add a short install section to `README.md` and a release note in `CLAUDE.md` pointing at `docs/releasing.md` and `docs/deploying.md`; verify `markdownlint` passes

## 8. Rehearsal and first release

- [ ] 8.1 Publish a throwaway prerelease and verify Chrome installs from, and updates against, the real GitHub URLs; if the redirect or content type fails, move only `update.xml` to GitHub Pages and re-verify before any distribution
- [x] 8.2 Decide the repository `LICENSE` with the maintainer and verify `LICENSE` exists and the notices reference it
- [x] 8.3 Merge the first release PR, approve the signing job, and verify the Release holds all five assets and `sha256sum -c` passes on a fresh download
- [x] 8.4 File follow-up issues for Edge, Brave, and Firefox support, and verify they are linked from `docs/deploying.md`

## Workflow follow-up

- Archive the change after the first release is verified.
- Verify the archived specs describe the shipped behavior.
