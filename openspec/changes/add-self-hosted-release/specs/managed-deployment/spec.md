# Spec Delta

## Purpose

Defines how Chrome installs and updates the extension outside the Chrome Web Store, and what the project documents so administrators and individual users can do it correctly.

## ADDED Requirements

### Requirement: Force-install through policy
Chrome SHALL be able to install the extension without user action when an administrator sets the `ExtensionSettings` policy with `installation_mode` `force_installed` and the extension's ID and update URL.

#### Scenario: Managed device installs the extension
- **WHEN** a managed Chrome receives the documented policy
- **THEN** the extension appears installed and enabled with the key-derived ID, and the user cannot remove it

#### Scenario: Update through the update XML
- **WHEN** a newer release is published and Chrome next checks for updates
- **THEN** the extension updates to that version without user action

### Requirement: Update URL fixed from the first release
The `update_url` baked into the first distributed release SHALL be the URL all later releases keep, because an installed extension reads its update source from its own manifest.

#### Scenario: Later release keeps the URL
- **WHEN** any release after the first is built
- **THEN** its manifest's `update_url` equals the first release's

### Requirement: Load-unpacked fallback
The documentation SHALL describe installing the unpacked zip with developer mode as a fallback, and the extension loaded this way SHALL have the same ID as the packed one.

#### Scenario: Unpacked install works
- **WHEN** a user unzips the release asset and loads the directory in Chrome with developer mode on
- **THEN** the extension runs, resolves go links, and shows the same ID as a policy install

#### Scenario: No automatic updates
- **WHEN** a newer release is published
- **THEN** documentation states that an unpacked install does not update itself and how to update it

### Requirement: Managed-device requirements stated
The documentation SHALL state the device-management conditions under which Chrome honors an off-store force-install on Windows, macOS, and Linux, and SHALL say which of those conditions the project has verified.

#### Scenario: Requirements are findable
- **WHEN** an administrator reads the deployment guide before deploying
- **THEN** it names the management requirements per operating system and marks each as verified or unverified

### Requirement: Policy snippets marked by test status
Every policy snippet in the documentation SHALL be labeled tested or untested, and a snippet SHALL be labeled tested only after it installed the extension on a matching managed device.

#### Scenario: Untested snippet is labeled
- **WHEN** a snippet has not been run on a managed device
- **THEN** it is labeled untested

#### Scenario: Tested snippet names its environment
- **WHEN** a snippet is labeled tested
- **THEN** the documentation names the operating system, Chrome version, and management method used

### Requirement: Chrome only
The documentation SHALL state that only Google Chrome is supported for deployment and that other Chromium-based browsers are not covered.

#### Scenario: Scope stated
- **WHEN** a reader looks for supported browsers
- **THEN** the guide lists Chrome and says other browsers are unsupported for now
