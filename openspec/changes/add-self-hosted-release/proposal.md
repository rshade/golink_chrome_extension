# Proposal

## Why

The extension has no way to reach users. It will not be listed on the Chrome Web Store, so people get it by downloading it or through managed deployment (Jamf, a software center, Windows policy). That needs a versioned, signed, self-updating package, and today the repo produces only a gitignored `ext/` directory that must be built by hand.

## What Changes

- release-please opens a release PR from conventional commits. It bumps `ext/manifest.json` and `CHANGELOG.md`; merging it creates the tag and the GitHub Release.
- On release, CI builds the WASM extension and packs a signed CRX. The private key lives in an approval-gated GitHub Actions environment secret, never in the repo.
- `ext/manifest.json` gains a `key` field so every build, packed or unpacked, has the same extension ID, and an `update_url` that points at an update XML on GitHub Releases.
- Each release publishes the `.crx`, the update XML, an unpacked zip, `THIRD_PARTY_NOTICES.md` with a license report for everything compiled into `main.wasm`, and SHA-256 checksums.
- Documentation for Chrome only: force-install through the `ExtensionSettings` policy (Jamf and Windows) and a download-and-load-unpacked fallback. It states the managed-device requirements and gives policy snippets marked tested or untested.
- Other browsers (Edge, Brave, Firefox) are out of scope and tracked as follow-up issues.
- `LICENSE` for the public repo is an open question: the repo has none today, and a release should not ship before the owner decides.

## Capabilities

### New Capabilities

- `release-packaging`: what a release artifact set contains and how it is signed, identified, and verified: signed CRX, stable extension ID, update XML, unpacked zip, notices and license report, checksums.
- `release-automation`: how a release happens: versioning from conventional commits, release PR, tagging, GitHub Release, and the approval gate around the signing key.
- `managed-deployment`: how Chrome installs and updates the extension: force-install policy, update behavior, the load-unpacked fallback, and the documented managed-device requirements.

### Modified Capabilities

None. `openspec/specs/` is empty; the existing design spec in `docs/superpowers/specs/` has not been migrated.

## Impact

- `ext/manifest.json`: new `key` and `update_url`; the `version` becomes release-managed. Existing unpacked installs keep working, but their extension ID changes once, from a path-derived ID to the key-derived ID, which resets their stored state.
- New files: `release-please-config.json`, `.release-please-manifest.json`, a release workflow, a CRX packing script, an update-XML generator, and deployment docs.
- `.github/workflows/build.yml` is unchanged; the release workflow is separate.
- New secret and environment in the repo: the signing key, behind required reviewers.
- `scripts/test-bundle.sh` and `docs/testing-on-a-test-tailnet.md` mention loading `ext/`; the docs need a pointer to the key-derived ID.
- Dependencies: release-please and a Chrome binary in CI for packing.
- Not changed: extension behavior, the WASM node, and the Go client.
