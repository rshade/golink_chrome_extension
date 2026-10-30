# Design

## Context

See proposal.md for why. Today `ext/` is the whole extension, `main.wasm` and `wasm_exec.js` inside it are gitignored build outputs, and `ext/manifest.json` is at `0.1.0` with no `key` or `update_url`. CI (`build.yml`) runs `mise run ci` and the test bundle. The repo already uses conventional commits and signed commits, and has a `renovate.json`. The repo has no `LICENSE`.

Chrome facts this design rests on (from the release research, not yet verified here):

- An extension's ID is derived from its public key; a CRX is signed with the matching private key. A manifest `key` gives unpacked installs the same ID.
- Off-store installs are limited to managed devices on Windows and macOS. Linux is the exception, which makes Linux the one platform CI can test end to end.
- A force-installed extension reads its update source from its own manifest unless the policy sets `override_update_url`, so `update_url` must be right from the first release.

## Goals / Non-Goals

**Goals:**

- A release is one reviewed merge plus one approval click.
- The signing key is never available to untrusted code and never appears in the repo or a log.
- The CRX, update XML, and policy docs are checked by an automated install, not only by reading.

**Non-Goals:**

- The Chrome Web Store, Edge, Brave, and Firefox. Other browsers become follow-up issues.
- Auto-publishing or promoting prereleases; managing a fleet's rollout percentage.
- Migrating `docs/superpowers/specs/` into `openspec/specs/`.

## Decisions

**1. Generate the key once, outside CI.** The maintainer creates a 2048-bit RSA key locally. The private key goes into a GitHub environment secret; the public key goes into `manifest.json` as `key`. A script derives the extension ID from the public key (SHA-256 of the DER key, first 16 bytes, hex digits mapped to `a`-`p`) and the docs print it. Alternative: let Chrome generate the key on first pack. Rejected: that hides where the key lives and makes the ID depend on a build machine.

**2. Pack the CRX with a small Node script, not Chrome.** CRX3 is a short binary format: the `Cr24` magic, a protobuf header holding the public key, a signature and the extension ID, then the zip. `scripts/pack-crx.cjs` uses only `node:crypto`, matching the repo's no-dependency scripts. Alternative: `chrome --pack-extension`. Rejected because the research found it needs an X display on Linux and ignores `--headless`, which makes CI flaky. The cost of the script is that we own the format; decision 7 covers how that is checked.

**3. GitHub Releases host everything.** The manifest's `update_url` is `https://github.com/rshade/golink_chrome_extension/releases/latest/download/update.xml`, and the XML's `codebase` is the versioned CRX asset URL. This matches the maintainer's choice. Two risks follow from it and are handled below: whether Chrome accepts GitHub's redirect and content type, and that `latest` skips prereleases.

**4. release-please owns the version.** The config uses the `simple` release type with `ext/manifest.json` as an `extra-files` JSON target on `$.version`, and `bump-minor-pre-major`. Manifest versions must be plain dotted integers, so prerelease suffixes are not used. Alternative: the `node` release type driven by `package.json`. Rejected: `package.json` is a private dev-dependency file, not the product's version.

**5. One workflow, gated jobs.** Tags created with the default `GITHUB_TOKEN` do not trigger other workflows, so building cannot be a separate tag-triggered workflow. release-please creates the Release as a draft with its tag (`draft` and `force-tag-creation`), and the `package` job publishes it after attaching the assets, so `releases/latest` never points at a release without them. `release.yml` runs release-please, then, when `release_created` is true, a `checks` job (the full `mise run ci`, no secrets), then a `package` job that depends on it. Release PRs opened with `GITHUB_TOKEN` also do not trigger `build.yml`, so the `checks` job on the tagged commit is what stands in for PR checks.

**6. The key lives in a protected environment.** Only the `package` job declares `environment: release-signing`, with required reviewers and deployment limited to the main branch. Pull requests, including forks, never reach it. The job writes the key to a temporary file with mode 600, packs, and deletes it; nothing prints it.

**7. Verify by installing.** A CI test on Linux force-installs the built CRX into Chrome with a managed policy file, a local HTTP server standing in for GitHub serving `update.xml` and the CRX, and checks the loaded ID. This is the only way to catch a wrong CRX header or update XML, and it is the check that lets the Linux snippet be labeled tested. Windows and macOS snippets stay untested until someone runs them on a managed device.

**8. License report from the build's module list.** `scripts/licenses.sh` lists the modules in `GOOS=js GOARCH=wasm go list -deps ./wasm`, copies each module's license file, and appends them to the shipped notices. A test fails when a module has no license file. Alternative: a license scanner tool. Rejected for now to avoid another dependency; revisit if the report is noisy.

## Risks / Trade-offs

- **GitHub's redirect or headers break Chrome's update fetch** → Before the first release that will be distributed, publish a throwaway prerelease and verify install and update against the real URLs. Because `update_url` cannot change for installed copies, a fallback (GitHub Pages for `update.xml`) must be chosen before then, not after.
- **Own CRX packer is subtly wrong** → Decision 7's install test, plus comparing the output's structure against Chrome's own `--pack-extension` once, offline.
- **Signing key loss or leak** → Loss means a new ID and a reinstall for every device. A leak lets an attacker push updates. Keep an offline backup, restrict reviewers, and document the rotation procedure, which is a new-ID release.
- **One-time ID change** → Adding `key` changes the ID of existing path-derived unpacked installs and resets their stored login. Acceptable before any distribution; `docs/testing-on-a-test-tailnet.md` gets a note.
- **Single maintainer approves their own release** → Weaker than two-person review, but the gate still keeps untrusted workflows away from the key. Revisit when there is a second maintainer.
- **Managed-device rules unverified for Windows and macOS** → Documented as untested rather than assumed.

## Migration Plan

1. Land the packer, license script, and Linux install test behind CI with no release created.
2. Generate the key, create the environment and secret, add `key` and `update_url` to the manifest.
3. Cut a prerelease and run the real-URL install and update check (see Risks).
4. Decide the `LICENSE`, then cut the first distributed release.
5. Rollback: delete the release and tag; installed copies stay on their version. A bad update is fixed by a newer release, since Chrome only moves forward.

## Open Questions

- Which `LICENSE` the public repo carries. It blocks the first distributed release but changes no spec or task here.
- Whether to add GitHub build-provenance attestations to the release assets. Cheap on a public repo, and deferrable.
