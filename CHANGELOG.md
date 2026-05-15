# Changelog

## 0.0.10

- Open the workspace project home URL from `New Session` when one is configured.
- Fixed `Set View Location` to use VS Code's supported Move View workflow
  instead of an unsupported direct secondary-sidebar contribution.
- Throttle automatic local Codex session scans and allow the manual import
  command to force a rescan.
- Refresh imported local session timestamps when Codex metadata changes.
- Keep private `.agent` context ignored by the repository-level `.gitignore`.
- Add a checked-in VSIX and README download link for direct installation.

## 0.0.9

- Added a storage fallback for the view location command when VS Code reports
  the user setting as unavailable.

## 0.0.8

- Replaced the Marketplace icon asset.

## 0.0.7

- Prefer Codex `thread_name` values from the local session index for imported
  session titles.

## 0.0.6

- Removed local absolute paths from public documentation.
- Added selectable Activity Bar and secondary sidebar view locations.

## 0.0.5

- Open saved Codex sessions through the Codex sidebar deeplink when available,
  with editor-tab fallback.

## 0.0.4

- Used the first local user message plus the session timestamp for local Codex
  session titles, while preserving manually renamed titles.

## 0.0.3

- Initial standalone project setup.
- Added workspace-scoped session storage.
- Added best-effort auto-import for open VS Code Codex conversation tabs.
- Added Marketplace metadata and icon assets.
- Improved Codex tab URI detection across VS Code tab input variants.
- Added metadata-only import for local Codex CLI sessions whose `cwd` matches
  the current workspace.
- Skipped local Codex sessions that have no user-message marker and fixed
  session removal persistence.
