# Project Chat Sessions

Workspace-scoped shortcuts for ChatGPT/Codex conversation URLs.

This extension adds a `Project Chats` view for workspace-scoped chat shortcuts.
The view only shows sessions saved for the currently opened workspace root, so
separate repositories can keep separate ChatGPT/Codex conversation lists even
when the official ChatGPT/Codex history remains account-wide.

## Features

- Add a ChatGPT/Codex conversation URL to the current workspace.
- Automatically import open Codex conversation tabs for the current workspace.
- Manually import local Codex CLI sessions whose metadata points at the current
  workspace, with opt-in automatic local import.
- Show a spinner for active local Codex sessions, completed/failed/aborted
  status in session tooltips, and an unread indicator when a tracked local
  session reaches a new terminal state.
- Choose whether session grouping and sorting use latest activity time or the
  original session creation time.
- Show only sessions saved for the active workspace root.
- Filter local Codex sessions with one lineage filter menu: default view,
  user/direct sessions, explicit O2 roots/top supervisors, O1 MACO child
  orchestrators, spawned/delegated agents, or a full lineage from a selected
  source session.
- Open a saved session in the same VS Code window's right Codex sidebar by
  clicking it in the Activity Bar view. If the sidebar deeplink is unavailable,
  the extension shows a warning instead of opening a center editor tab.
- Rename, copy, and remove saved session shortcuts.
- Set a workspace-specific project home URL for the `New Session` button.
- Use VS Code's built-in Move View picker to place `Project Chats` in the
  Activity Bar or Secondary Side Bar.
- Open links in the system browser or VS Code Simple Browser.

## Install

Download the latest VSIX:

[Download project-chat-sessions.vsix](https://github.com/Meta-Develop/vscode-project-chat-sessions/releases/latest/download/project-chat-sessions.vsix)

The same VSIX is also checked in at the repository root:

[Download the checked-in VSIX](https://github.com/Meta-Develop/vscode-project-chat-sessions/raw/main/project-chat-sessions.vsix)

Then install it from VS Code with `Extensions: Install from VSIX...`, or from a
terminal:

```bash
code --install-extension project-chat-sessions.vsix
```

## Development

Clone this repository, open the repository folder in VS Code, then press `F5` to
launch an Extension Development Host.

No local absolute paths are required.

## Usage

1. Open the repository workspace you want to scope sessions to.
2. Open the `Project Chats` Activity Bar icon, or use
   `Project Chat Sessions: Set View Location` to open VS Code's Move View
   picker. Choose `Secondary Side Bar` there if you want it next to Codex.
3. Start or open a Codex conversation. Open Codex tabs are imported
   automatically into this workspace's list.
4. Use `Add Current Chat URL` for browser-based ChatGPT/Codex URLs that are not
   represented as VS Code Codex tabs.
5. Click a saved session to open it later.

Use `Set Project Home URL` to point `New Session` at a ChatGPT Project or other
preferred Codex entry URL for the current workspace. When a project home URL is
set, `New Session` opens that URL directly. Otherwise, it asks the Codex
extension to create a new panel and falls back to the default new-session URL.

## Codex Auto-Import

Automatic import watches Codex conversations that are open as VS Code editor
tabs in the same window as the workspace. It also performs a bounded recent
local-session lookup so newly created sidebar/local Codex sessions can appear
without enabling broad historical local scanning. If nothing appears, run
`Project Chat Sessions: Import Open Codex Tabs` from the Command Palette after
opening the Codex conversation tab. For open local Codex tabs, the extension can
attach the matching local session file by session ID with a bounded recent-date
lookup. Local Codex tabs backed by subagent session files or
Multi-Agent_Coding_Orchestrator child/worker sessions are stored when their
metadata is available, but they stay hidden in the default unfiltered tree.

The extension can also scan local Codex CLI session metadata under
`$CODEX_HOME/sessions` or `~/.codex/sessions`. Automatic local scanning is
disabled by default so VS Code startup does not walk large Codex session
directories. Use `Project Chat Sessions: Import Local Codex Sessions` to run a
manual import, or enable
`projectChatSessions.autoImportLocalCodexSessions` to opt in to throttled
automatic historical scans. The default recent lookup only checks a small number
of current date-based session directories and still filters sessions to the
current workspace. The Project Chats refresh button also runs an on-demand full
local metadata resync for the current workspace, so older saved local sessions
can pick up Codex summary titles from `session_index.jsonl` without enabling
recurring historical scans.

Local import reads each JSONL file's initial `session_meta` record, checks for
a user-message record, and uses the Codex `thread_name` from
`session_index.jsonl` as the session title when available. It then imports
sessions whose `cwd` matches the current workspace. Sessions that were opened
but never sent a user message are skipped. Local Codex subagent/delegated-worker
session files and Multi-Agent_Coding_Orchestrator child/worker sessions are
imported with lineage metadata when present, then hidden from the default tree
until a lineage filter is active. Multi-Agent_Coding_Orchestrator role filters
use the canonical `ROLE:` or `ROLE=` prefix first; `AGENT_LABEL`/nickname is
display metadata and does not affect User/direct, O2, O1, or spawned/delegated
classification. Parentless local Codex sessions without explicit O1, O2, or
delegated-worker signals are classified as User/direct, not O2. For performance,
the importer reads the beginning of each session file. Background imports read the
beginning of `session_index.jsonl`; manual refresh/import paths also read the
tail of that append-only index so newer title updates in large indexes are more
likely to be applied. Unusually large or differently ordered Codex metadata can
still require a manual title edit after import.
Tracked local sessions show as running only while their JSONL file has recent
file activity after the latest Codex start or activity record. Completed turns
use the normal session icon after they are read, while unread completed, failed,
or aborted terminal states use the unread indicator until the session is opened.
Aborted turns show as aborted, failed turns show as failed, and sessions with no
terminal event stop spinning after a short inactivity window. Status detection
uses Codex task events, final assistant answers, patch-apply results, explicit
failed/error-like status fields, and command outputs that report a non-zero
process exit code. Older error/abort/command-failure records are not treated as
terminal when newer records show a later active or completed turn. Status
refresh for already imported local sessions does not require automatic local
import to be enabled and does not scan the Codex sessions directory.

Use the `Filter by Codex Lineage` funnel in the `Project Chats` view title to
choose the default view, user/direct sessions, explicit O2 root/top-supervisor
sessions, O1 MACO child orchestrators, spawned/delegated agents, or a full
lineage from a selected source session. Role and source filters apply
immediately to saved sessions without scanning local metadata. Use the Project
Chats Refresh button for an on-demand local metadata resync when saved local
sessions need reclassification. O2 only means explicit MACO top-supervisor/root
sessions, and O1 only means explicit MACO child orchestrators; native Codex
subagents, explorers, workers, researchers, and auditors appear under
spawned/delegated agents. You can also run the direct User/direct, O2, O1,
spawned/delegated, and source-lineage commands from the Command Palette or
right-click a session and choose `Filter Lineage from This Session`. The active
filter is shown in the tree message; use `Clear Lineage Filter` to return to the
normal view.

If your Codex sessions live somewhere else, set
`projectChatSessions.localCodexSessionsPath` to that `sessions` directory.
For browser-only ChatGPT conversations, copy the conversation URL and use
`Project Chat Sessions: Add Current Chat URL`.

## Privacy and Limits

This extension does not read or modify OpenAI's account-wide chat history. It
stores local shortcuts in VS Code global extension storage under a separate key
per workspace root. Automatic import watches VS Code Codex conversation editor
tabs whose URI uses `openai-codex://route/local/<conversationId>` or
`openai-codex://route/remote/<conversationId>`.

Local Codex import reads session ID, working directory, timestamp, parent thread
ID, thread depth, agent role, agent kind, no-further-delegation flag, display
nickname/label, and Codex thread names from local Codex files when present.
If no thread name exists yet, it can fall back to the
first user message excerpt for the local shortcut title. It does not scrape
Codex webviews, browser pages, private APIs, hidden account data, or
account-wide history, and it does not send message text anywhere.
