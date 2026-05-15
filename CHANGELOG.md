# Changelog

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
