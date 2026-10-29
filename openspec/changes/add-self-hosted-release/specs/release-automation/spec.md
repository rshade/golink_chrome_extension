# Spec Delta

## Purpose

Defines how a release is produced from the repository: versioning from conventional commits, the release pull request, tagging, publishing, and the approval that guards the signing key.

## ADDED Requirements

### Requirement: Versioning from commits
The next version SHALL be derived from the conventional commits since the last release, and while the major version is 0 a breaking change SHALL raise the minor version, not the major.

#### Scenario: Fix raises the patch version
- **WHEN** the only releasable commits since the last release are `fix:` commits
- **THEN** the proposed version raises the patch number

#### Scenario: Breaking change before 1.0
- **WHEN** a commit marked as breaking lands while the version is below 1.0.0
- **THEN** the proposed version raises the minor number and stays below 1.0.0

#### Scenario: Nothing releasable
- **WHEN** the only commits since the last release are `docs:`, `test:`, or `ci:` commits
- **THEN** no release is proposed

### Requirement: Release pull request
The system SHALL keep one open release pull request that updates the changelog and the version in `ext/manifest.json` together, and merging it SHALL be the only action that creates a release.

#### Scenario: Version and changelog agree
- **WHEN** the release pull request is open
- **THEN** the manifest version and the changelog's newest entry name the same version

#### Scenario: Merge creates the release
- **WHEN** the release pull request is merged
- **THEN** a tag and a GitHub Release for that version exist

#### Scenario: Ordinary push creates no release
- **WHEN** a commit that is not the release pull request lands on the main branch
- **THEN** no tag or GitHub Release is created

### Requirement: Build and publish on release
When a release is created, the system SHALL build the extension from the tagged commit, package it, and attach the release assets to that GitHub Release.

#### Scenario: Assets attached
- **WHEN** a release is created
- **THEN** its assets are attached without a manual step

#### Scenario: Failed build leaves no partial release
- **WHEN** building or packing fails
- **THEN** the release is not announced as complete, and rerunning the job after the cause is fixed attaches the assets

### Requirement: Approval before the signing key is used
The signing key SHALL be available only to the job that packs the CRX, and that job SHALL NOT start until a designated reviewer approves it.

#### Scenario: Waiting for approval
- **WHEN** a release is created and the packing job is waiting
- **THEN** no job has access to the signing key

#### Scenario: Pull requests cannot reach the key
- **WHEN** a workflow runs for a pull request, including one from a fork
- **THEN** the signing key is not available to it

### Requirement: Release checks
A release SHALL NOT be published unless the repository's test pipeline passes on the tagged commit.

#### Scenario: Failing checks block publishing
- **WHEN** the test pipeline fails on the commit to be released
- **THEN** no assets are attached and the failure is visible on the release workflow
