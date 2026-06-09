# Changelog

## 0.0.23

- Read past context-only AGENTS/environment prelude user messages when local
  Codex metadata needs the first meaningful prompt for delegated-worker lineage
  classification.
- Keep `hasUserMessage` true for any user record while preserving ordinary
  single-prompt sessions and canonical MACO `ROLE` prefix precedence.

## 0.0.22

- Hide generic delegated Codex worker sessions from the default tree when their
  first prompt self-identifies as a delegated worker but lacks structured
  lineage metadata.
- Preserve canonical MACO `ROLE` prefix precedence for O2/O1/Other lineage
  classification.

## 0.0.21

- Parse numeric Codex `completed_at` values as Unix seconds when appropriate.
- Keep completed local Codex sessions from falling back to stale or inactive
  status when terminal timestamps are present.
- Show stale local Codex sessions and sessions without a recent terminal event
  as Inactive instead of Stopped.

## 0.0.20

- Replace separate lineage role toolbar actions with one filter picker that
  includes default, O2 root/top-supervisor, O1 MACO child-orchestrator,
  spawned/delegated, and source-lineage choices.
- Refresh local Codex metadata before applying lineage filters so stale saved
  sessions can be reclassified from current session files.
- Give canonical MACO role metadata precedence in lineage classification while
  keeping delegated/native subagent sessions under spawned/delegated agents.

## 0.0.19

- Hide delegated/MACO spawned local Codex sessions from the default tree by
  classifying explicit delegated session metadata as Other lineage sessions.
- Detect MACO lineage metadata even when the role block appears after an early
  prompt preamble.

## 0.0.18

- Use strict Multi-Agent_Coding_Orchestrator role-prefix classification for
  O2/O1/Other filters.
- Treat `AGENT_LABEL` and display nicknames as metadata only, so they no longer
  control O2/O1/Other classification.
- Keep worker, researcher, auditor, and expert-* terminal roles classified as
  Other.
- Make local Codex running, failed, aborted, and completed detection less eager
  by using semantic event order plus an mtime:size status cache.

## 0.0.17

- Fix O2 role filtering so explicit O2/root session signals take precedence
  over broader O1/orchestrator markers.

## 0.0.16

- Fix local Codex O2/root role classification so root sessions stay in O2 and
  auxiliary sessions classify more accurately.
- Make New Session reflection robust with repeated follow-up imports and a
  bounded recent local session lookup.
- Make Project Chats Refresh perform an on-demand full local metadata resync
  for the current workspace so older sessions can pick up Codex summary titles
  from `session_index.jsonl` without enabling recurring historical scans.
- Add workspace trust and file access hardening for local Codex session reads.
- Add package safety hardening with `.npmignore` exclusions and NOTICE inclusion
  in the VSIX.

## 0.0.15

- Disable automatic local Codex session scanning by default while preserving
  manual import and opt-in automatic scans.
- Refresh saved local Codex session status from tracked files independently of
  automatic local import.
- Resolve open local Codex tabs to matching local session files with bounded
  ID-targeted lookup and mtime-cached status refreshes.
- Use the latest semantic status event after the latest `task_started` event
  for local Codex running, completed, aborted, and failed indicators.
- Add global O2, O1, and Other Codex lineage role filters.

## 0.0.14

- Added Codex lineage filtering from a selected source session with Full, O2,
  O1, and Other views.
- Store local subagent/delegated-worker sessions with lineage metadata and hide
  them from the default tree until lineage filtering is active.
- Added local Codex session metadata support for parent session, depth, agent
  role, and agent nickname.
- Include local Codex status icons for running sessions and completed unread
  sessions.

## 0.0.13

- Added a storage fallback for the date basis picker when VS Code has not
  loaded the new contributed setting yet.
- Skip Codex subagent/delegated-worker session files during local session
  import and open-tab import, and drop previously auto-imported subagent
  shortcuts on rescan.

## 0.0.12

- Added a selectable date basis for session grouping and sorting: latest
  activity or original session creation time.

## 0.0.11

- Show a spinning icon for local Codex sessions that are currently running.
- Show an unread indicator when a tracked running Codex session completes, and
  clear it after opening the session.

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
