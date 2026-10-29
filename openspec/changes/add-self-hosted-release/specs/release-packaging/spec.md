# Spec Delta

## Purpose

Defines what a release of the extension contains and how it is signed, identified, and verified, so that people and device-management tools can install it without the Chrome Web Store.

## ADDED Requirements

### Requirement: Release asset set
Each release SHALL publish the signed CRX, the update XML, an unpacked zip of the extension, `THIRD_PARTY_NOTICES.md`, and a SHA-256 checksum file covering every other asset.

#### Scenario: Complete release
- **WHEN** a release is published
- **THEN** its assets include the `.crx`, the update XML, the unpacked zip, the notices file, and checksums for all of them

#### Scenario: Checksum verification
- **WHEN** a user runs a SHA-256 check against the checksum file for a downloaded asset
- **THEN** the digest matches the published asset

### Requirement: Stable extension ID
The extension SHALL have one extension ID across every release and across packed and unpacked installs, derived from a public key declared in the manifest.

#### Scenario: Same ID in every form
- **WHEN** the CRX is installed and the unpacked zip is loaded in separate profiles
- **THEN** both show the same extension ID

#### Scenario: ID survives a version bump
- **WHEN** a new release is installed over an older one
- **THEN** Chrome treats it as an update to the same extension, not a new one

### Requirement: Signing with a separately held key
The CRX SHALL be signed with the private key that matches the manifest's public key, and that private key SHALL NOT be present in the repository, its history, build logs, or any release asset.

#### Scenario: Signature matches the declared key
- **WHEN** the CRX's embedded public key is compared with the manifest's `key`
- **THEN** they identify the same key

#### Scenario: Key never published
- **WHEN** the repository, a release's assets, and the release workflow's logs are searched for the private key
- **THEN** no copy is found

### Requirement: Update manifest
Each release SHALL publish an update XML that names the release's version and the HTTPS download URL of its CRX for the extension's ID, and the manifest's `update_url` SHALL resolve to the update XML of the latest release.

#### Scenario: Latest release is advertised
- **WHEN** Chrome fetches the manifest's `update_url`
- **THEN** it receives an update XML for the extension's ID whose version equals the latest release's version

#### Scenario: Download URL serves an installable file
- **WHEN** Chrome follows the update XML's download URL
- **THEN** the response is the release's CRX, served over HTTPS in a form Chrome accepts for installation

### Requirement: License notices for compiled-in code
The notices shipped with a release SHALL list the license of the adapted Tailscale code and of every Go module compiled into the WASM binary.

#### Scenario: Notices cover the binary
- **WHEN** the module list compiled into `main.wasm` is compared with the shipped notices
- **THEN** every module appears with its license text or a pointer to it

### Requirement: Release contents match the tag
The files inside the CRX and the unpacked zip SHALL be built from the tagged commit, with the WASM binary produced by the repository's build, and the version in the packaged manifest SHALL equal the release version.

#### Scenario: Version agreement
- **WHEN** the packaged manifest's `version` is compared with the release tag
- **THEN** they are the same version
