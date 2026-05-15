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
- Show only sessions saved for the active workspace root.
- Open a saved session in the Codex sidebar by clicking it in the Activity Bar
  view, with editor-tab fallback when the Codex sidebar deeplink is unavailable.
- Rename, copy, and remove saved session shortcuts.
- Set a workspace-specific project home URL for the `New Session` button.
- Choose whether the `Project Chats` view appears in the Activity Bar, the
  secondary sidebar next to Codex, or both.
- Open links in the system browser or VS Code Simple Browser.

## Development

Clone this repository, open the repository folder in VS Code, then press `F5` to
launch an Extension Development Host.

No local absolute paths are required.

## Usage

1. Open the repository workspace you want to scope sessions to.
2. Open the `Project Chats` Activity Bar icon, or use
   `Project Chat Sessions: Set View Location` to show it in the secondary
   sidebar next to Codex.
3. Start or open a Codex conversation. Open Codex tabs are imported
   automatically into this workspace's list.
4. Use `Add Current Chat URL` for browser-based ChatGPT/Codex URLs that are not
   represented as VS Code Codex tabs.
5. Click a saved session to open it later.

Use `Set Project Home URL` to point `New Session` at a ChatGPT Project or other
preferred Codex entry URL for the current workspace.

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
Sessions that were opened but never sent a user message are skipped.

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
