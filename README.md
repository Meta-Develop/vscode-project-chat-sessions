# Project Chat Sessions

Workspace-scoped shortcuts for ChatGPT/Codex conversation URLs.

This extension adds a `Project Chats` view for workspace-scoped chat shortcuts.
The view only shows sessions saved for the currently opened workspace root, so
separate repositories can keep separate ChatGPT/Codex conversation lists even
when the official ChatGPT/Codex history remains account-wide.

## Features

- Add a ChatGPT/Codex conversation URL to the current workspace.
- Automatically import open Codex conversation tabs for the current workspace.
- Automatically import local Codex CLI sessions whose metadata points at the
  current workspace.
- Show a spinner for running local Codex sessions and an unread indicator when
  a tracked running session completes.
- Choose whether session grouping and sorting use latest activity time or the
  original session creation time.
- Show only sessions saved for the active workspace root.
- Open a saved session in the Codex sidebar by clicking it in the Activity Bar
  view, with editor-tab fallback when the Codex sidebar deeplink is unavailable.
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

Automatic import only works for Codex conversations that are open as VS Code
editor tabs in the same window as the workspace. If nothing appears, run
`Project Chat Sessions: Import Open Codex Tabs` from the Command Palette after
opening the Codex conversation tab.

The extension also scans local Codex CLI session metadata under
`$CODEX_HOME/sessions` or `~/.codex/sessions`. It reads each JSONL file's
initial `session_meta` record, checks for a user-message record, and uses the
Codex `thread_name` from `session_index.jsonl` as the session title when
available. It then imports sessions whose `cwd` matches the current workspace.
Sessions that were opened but never sent a user message are skipped, as are
Codex subagent/delegated-worker session files. If an earlier version saved one
of those local subagent shortcuts, the next local scan drops it from the
workspace list.
Automatic local scans are throttled to avoid repeatedly walking large session
directories during normal editor activity. Use
`Project Chat Sessions: Import Local Codex Sessions` to force an immediate
rescan. For performance, the importer reads the beginning of each session file
and the beginning of `session_index.jsonl`; unusually large or differently
ordered Codex metadata can require a manual title edit after import.

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

Local Codex import reads session ID, working directory, timestamp, and Codex
thread names from local Codex files. If no thread name exists yet, it can fall
back to the first user message excerpt for the local shortcut title. It does not
scrape Codex webviews, browser pages, private APIs, hidden account data, or
account-wide history, and it does not send message text anywhere.
