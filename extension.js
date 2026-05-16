const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SESSIONS_STATE_KEY = 'projectChatSessions.sessionsByWorkspace';
const HOME_URLS_STATE_KEY = 'projectChatSessions.homeUrlsByWorkspace';
const SESSION_WORKSPACE_KEY_PREFIX = 'projectChatSessions.sessions.';
const HOME_URL_WORKSPACE_KEY_PREFIX = 'projectChatSessions.homeUrl.';
const VIEW_LOCATION_STATE_KEY = 'projectChatSessions.viewLocation';
const DATE_BASIS_STATE_KEY = 'projectChatSessions.dateBasis';
const SESSION_DATE_BASIS_LAST_ACTIVITY = 'lastActivity';
const SESSION_DATE_BASIS_CREATED_AT = 'createdAt';
const CODEX_SCHEME = 'openai-codex';
const CODEX_AUTHORITY = 'route';
const CODEX_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const LOCAL_CODEX_SCAN_MIN_INTERVAL_MS = 60000;
const LOCAL_CODEX_STATUS_REFRESH_INTERVAL_MS = 5000;
const LOCAL_CODEX_STATUS_SUFFIX_BYTES = 524288;
const LOCAL_CODEX_RUNNING_STALE_MS = 2 * 60 * 60 * 1000;

const localCodexDiscoveryCache = {
  key: undefined,
  scannedAt: 0,
  candidates: []
};
let extensionContext;

class SessionTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.type === 'empty') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = new vscode.ThemeIcon('info');
      item.contextValue = 'empty';
      return item;
    }

    if (element.type === 'group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(element.sessions.length);
      item.contextValue = 'group';
      return item;
    }

    const item = new vscode.TreeItem(element.session.title, vscode.TreeItemCollapsibleState.None);
    item.description = formatRelativeTime(getSessionDateValue(element.session));
    item.tooltip = getSessionTooltip(element.session);
    item.iconPath = getSessionIcon(element.session);
    item.contextValue = 'session';
    item.command = {
      command: 'projectChatSessions.openSession',
      title: 'Open Session',
      arguments: [element.session]
    };
    return item;
  }

  getChildren(element) {
    const workspaceKey = getWorkspaceKey();
    if (!workspaceKey) {
      return [
        {
          type: 'empty',
          label: 'Open a workspace folder',
          description: 'Sessions are scoped by workspace root.'
        }
      ];
    }

    if (element && element.type === 'group') {
      return element.sessions.map((session) => ({ type: 'session', session }));
    }

    const sessions = getSessions(this.context, workspaceKey);
    if (sessions.length === 0) {
      return [
        {
          type: 'empty',
          label: 'No sessions for this workspace',
          description: 'Use + to add a ChatGPT/Codex URL.'
        }
      ];
    }

    return groupSessions(sessions);
  }
}

async function activate(context) {
  extensionContext = context;
  const provider = new SessionTreeProvider(context);

  await updateViewLocationContext(context);
  const treeOptions = {
    treeDataProvider: provider,
    showCollapseAll: true
  };
  const activityBarTree = vscode.window.createTreeView('projectChatSessions.sessionsView', treeOptions);

  context.subscriptions.push(
    activityBarTree,
    vscode.commands.registerCommand('projectChatSessions.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('projectChatSessions.setViewLocation', async () => {
      await setViewLocation(context);
    }),
    vscode.commands.registerCommand('projectChatSessions.setDateBasis', async () => {
      await setDateBasis(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand('projectChatSessions.addSession', async () => {
      await addSession(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand('projectChatSessions.importOpenCodexTabs', async () => {
      if (!requireWorkspaceKey()) {
        return;
      }

      const count = await importOpenCodexTabs(context);
      provider.refresh();
      if (count === 0) {
        vscode.window.showWarningMessage('No open Codex conversation tabs were detected in this VS Code window.');
        return;
      }
      vscode.window.showInformationMessage(`Imported ${count} open Codex session${count === 1 ? '' : 's'}.`);
    }),
    vscode.commands.registerCommand('projectChatSessions.importLocalCodexSessions', async () => {
      if (!requireWorkspaceKey()) {
        return;
      }

      const count = await importLocalCodexSessions(context, { force: true });
      provider.refresh();
      if (count === 0) {
        vscode.window.showWarningMessage('No local Codex session changes were found for this workspace.');
        return;
      }
      vscode.window.showInformationMessage(`Updated ${count} local Codex session${count === 1 ? '' : 's'}.`);
    }),
    vscode.commands.registerCommand('projectChatSessions.newSession', async () => {
      await openNewSession(context, provider);
    }),
    vscode.commands.registerCommand('projectChatSessions.setProjectHome', async () => {
      await setProjectHome(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand('projectChatSessions.openSession', async (input) => {
      const session = unwrapSession(input);
      if (session) {
        await openUrl(session.url);
        await touchSession(context, session.id);
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('projectChatSessions.renameSession', async (input) => {
      const session = unwrapSession(input);
      if (session) {
        await renameSession(context, session);
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('projectChatSessions.copySessionUrl', async (input) => {
      const session = unwrapSession(input);
      if (session) {
        await vscode.env.clipboard.writeText(session.url);
        vscode.window.showInformationMessage('Session URL copied.');
      }
    }),
    vscode.commands.registerCommand('projectChatSessions.removeSession', async (input) => {
      const session = unwrapSession(input);
      if (session) {
        await removeSession(context, session);
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('projectChatSessions.viewLocation')) {
        updateViewLocationContext(context);
      }
      if (event.affectsConfiguration('projectChatSessions.dateBasis')) {
        provider.refresh();
      }
    })
  );

  startAutoImport(context, provider);
}

function deactivate() {}

async function setViewLocation(context) {
  const current = getViewLocation(context);
  const options = [
    {
      label: 'Secondary Sidebar',
      value: 'secondarySidebar',
      description: 'Open VS Code\'s Move View picker; choose Secondary Side Bar.'
    },
    {
      label: 'Activity Bar',
      value: 'activityBar',
      description: 'Open VS Code\'s Move View picker; choose Primary Side Bar.'
    }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Project Chats Location',
    placeHolder: 'Choose where Project Chats appears',
    activeItem: options.find((option) => option.value === current)
  });

  if (!selected) {
    return;
  }

  await setStoredViewLocation(context, selected.value);
  await updateViewLocationContext(context);
  await moveProjectChatsView(selected.value);
}

async function setDateBasis(context) {
  const current = getSessionDateBasis(context);
  const options = [
    {
      label: 'Last Activity',
      value: SESSION_DATE_BASIS_LAST_ACTIVITY,
      description: 'Group and sort by the latest conversation activity.'
    },
    {
      label: 'Created Time',
      value: SESSION_DATE_BASIS_CREATED_AT,
      description: 'Group and sort by when the session was first created.'
    }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Project Chats Date Basis',
    placeHolder: 'Choose which timestamp groups and sorts sessions',
    activeItem: options.find((option) => option.value === current)
  });

  if (!selected) {
    return;
  }

  await setStoredDateBasis(context, selected.value);
}

async function setStoredDateBasis(context, value) {
  try {
    await vscode.workspace
      .getConfiguration('projectChatSessions')
      .update('dateBasis', value, vscode.ConfigurationTarget.Global);
    await context.globalState.update(DATE_BASIS_STATE_KEY, undefined);
  } catch {
    await context.globalState.update(DATE_BASIS_STATE_KEY, value);
  }
}

async function setStoredViewLocation(context, value) {
  try {
    await vscode.workspace
      .getConfiguration('projectChatSessions')
      .update('viewLocation', value, vscode.ConfigurationTarget.Global);
    await context.globalState.update(VIEW_LOCATION_STATE_KEY, undefined);
  } catch (error) {
    await context.globalState.update(VIEW_LOCATION_STATE_KEY, value);
  }
}

async function updateViewLocationContext(context) {
  const location = getViewLocation(context);
  await vscode.commands.executeCommand(
    'setContext',
    'projectChatSessions.showActivityBar',
    location === 'activityBar' || location === 'both'
  );
  await vscode.commands.executeCommand(
    'setContext',
    'projectChatSessions.showSecondarySidebar',
    location === 'secondarySidebar' || location === 'both'
  );
}

async function moveProjectChatsView(location) {
  const target = location === 'secondarySidebar' ? 'Secondary Side Bar' : 'Primary Side Bar';
  await vscode.commands.executeCommand('projectChatSessions.sessionsView.focus');
  vscode.window.showInformationMessage(
    `VS Code controls final view placement. In the next picker, choose "${target}".`
  );

  try {
    await vscode.commands.executeCommand('workbench.action.moveFocusedView');
  } catch {
    vscode.window.showInformationMessage(
      `If the move picker did not open, run "View: Move Focused View" and choose "${target}".`
    );
  }
}

function getViewLocation(context) {
  const storedValue = context && context.globalState.get(VIEW_LOCATION_STATE_KEY);
  if (isViewLocation(storedValue)) {
    return storedValue;
  }

  const value = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('viewLocation', 'activityBar');
  return isViewLocation(value) ? value : 'activityBar';
}

function isViewLocation(value) {
  return ['activityBar', 'secondarySidebar', 'both'].includes(value);
}

async function addSession(context) {
  const workspaceKey = requireWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const clipboard = (await vscode.env.clipboard.readText()).trim();
  const defaultUrl = looksLikeChatUrl(clipboard) ? clipboard : '';
  const url = await vscode.window.showInputBox({
    title: 'Add ChatGPT/Codex Session',
    prompt: 'Paste a ChatGPT/Codex conversation URL for this workspace.',
    value: defaultUrl,
    validateInput: validateUrlInput
  });

  if (!url) {
    return;
  }

  const defaultTitle = titleFromUrl(url);
  const title = await vscode.window.showInputBox({
    title: 'Session Title',
    prompt: 'Name this session in the workspace list.',
    value: defaultTitle,
    validateInput: (value) => (value.trim() ? undefined : 'Title is required.')
  });

  if (!title) {
    return;
  }

  const sessions = getSessions(context, workspaceKey);
  const existing = sessions.find((session) => normalizeUrl(session.url) === normalizeUrl(url));
  const now = new Date().toISOString();

  if (existing) {
    existing.title = title.trim();
    existing.titleSource = 'manual';
    existing.updatedAt = now;
  } else {
    sessions.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      title: title.trim(),
      url: url.trim(),
      titleSource: 'manual',
      createdAt: now,
      updatedAt: now
    });
  }

  await setSessions(context, workspaceKey, sessions);
}

async function openNewSession(context, provider) {
  const workspaceKey = requireWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const configuredUrl = getHomeUrl(context, workspaceKey);
  if (configuredUrl) {
    await openUrl(configuredUrl);
    return;
  }

  try {
    await vscode.commands.executeCommand('chatgpt.newCodexPanel');
    setTimeout(async () => {
      await importOpenCodexTabs(context);
      provider.refresh();
    }, 1500);
    return;
  } catch {
    // Fall back to URL opening when the OpenAI Codex extension is unavailable.
  }

  const fallbackUrl = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('defaultNewSessionUrl', 'https://chatgpt.com/');

  await openUrl(fallbackUrl);
}

async function setProjectHome(context) {
  const workspaceKey = requireWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const homeUrl = getHomeUrl(context, workspaceKey);
  const url = await vscode.window.showInputBox({
    title: 'Set Project Home URL',
    prompt: 'Set the ChatGPT Project or Codex entry URL for this workspace.',
    value: homeUrl || '',
    validateInput: validateUrlInput
  });

  if (!url) {
    return;
  }

  await setHomeUrl(context, workspaceKey, url.trim());
}

async function renameSession(context, session) {
  const workspaceKey = requireWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const title = await vscode.window.showInputBox({
    title: 'Rename Session',
    value: session.title,
    validateInput: (value) => (value.trim() ? undefined : 'Title is required.')
  });

  if (!title) {
    return;
  }

  const sessions = getSessions(context, workspaceKey);
  const target = sessions.find((candidate) => candidate.id === session.id);
  if (target) {
    target.title = title.trim();
    target.titleSource = 'manual';
    target.updatedAt = new Date().toISOString();
    await setSessions(context, workspaceKey, sessions);
  }
}

async function removeSession(context, session) {
  const workspaceKey = requireWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Remove "${session.title}" from this workspace list?`,
    { modal: true },
    'Remove'
  );

  if (choice !== 'Remove') {
    return;
  }

  const sessions = getSessions(context, workspaceKey).filter((candidate) => candidate.id !== session.id);
  await setSessions(context, workspaceKey, sessions);
}

async function touchSession(context, sessionId) {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return;
  }

  const sessions = getSessions(context, workspaceKey);
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    return;
  }

  const now = new Date().toISOString();
  target.lastOpenedAt = now;
  target.lastReadAt = now;
  delete target.unreadAt;
  target.updatedAt = now;
  await setSessions(context, workspaceKey, sortSessions(sessions));
}

async function openUrl(url) {
  if (url.startsWith(`${CODEX_SCHEME}:`)) {
    await openCodexUrl(url);
    return;
  }

  const uri = vscode.Uri.parse(url);
  const mode = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('openMode', 'externalBrowser');

  if (mode === 'simpleBrowser') {
    try {
      await vscode.commands.executeCommand('simpleBrowser.show', uri);
      return;
    } catch {
      // Fall back to the system browser when the Simple Browser command is not available.
    }
  }

  await vscode.env.openExternal(uri);
}

async function openCodexUrl(url) {
  const parsed = parseCodexConversationUri(url);
  if (parsed && (await openCodexSidebarRoute(parsed))) {
    return;
  }

  const uri = vscode.Uri.parse(url);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR_VIEW_TYPE);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

async function openCodexSidebarRoute(parsed) {
  if (!parsed.kind || !parsed.conversationId) {
    return false;
  }

  try {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
  } catch {
    return false;
  }

  const routeUri = vscode.Uri.parse(
    `${vscode.env.uriScheme}://openai.chatgpt/${encodeURIComponent(parsed.kind)}/${encodeURIComponent(parsed.conversationId)}`
  );

  try {
    const externalUri = await vscode.env.asExternalUri(routeUri);
    return await vscode.env.openExternal(externalUri);
  } catch {
    try {
      return await vscode.env.openExternal(routeUri);
    } catch {
      return false;
    }
  }
}

function getSessions(context, workspaceKey) {
  const direct = context.globalState.get(workspaceStateKey(SESSION_WORKSPACE_KEY_PREFIX, workspaceKey));
  if (Array.isArray(direct)) {
    return sortSessions([...direct]);
  }

  const legacySessions = context.globalState.get(SESSIONS_STATE_KEY, {});
  return sortSessions([...(legacySessions[workspaceKey] || [])]);
}

async function setSessions(context, workspaceKey, sessions) {
  await context.globalState.update(workspaceStateKey(SESSION_WORKSPACE_KEY_PREFIX, workspaceKey), sortSessions([...sessions]));
}

function getHomeUrl(context, workspaceKey) {
  const direct = context.globalState.get(workspaceStateKey(HOME_URL_WORKSPACE_KEY_PREFIX, workspaceKey));
  if (typeof direct === 'string') {
    return direct;
  }

  const legacyHomeUrls = context.globalState.get(HOME_URLS_STATE_KEY, {});
  return legacyHomeUrls[workspaceKey];
}

async function setHomeUrl(context, workspaceKey, url) {
  await context.globalState.update(workspaceStateKey(HOME_URL_WORKSPACE_KEY_PREFIX, workspaceKey), url);
}

function workspaceStateKey(prefix, workspaceKey) {
  return `${prefix}${crypto.createHash('sha256').update(workspaceKey).digest('hex')}`;
}

function getWorkspaceKey() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const workspacePath = folders[0].uri.fsPath;
  try {
    return fs.realpathSync.native(workspacePath);
  } catch {
    return workspacePath;
  }
}

function requireWorkspaceKey() {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    vscode.window.showWarningMessage('Open a workspace folder before managing Codex project sessions.');
  }
  return workspaceKey;
}

function groupSessions(sessions) {
  const dateBasis = getSessionDateBasis();
  const buckets = [
    { id: 'today', label: 'Today', sessions: [] },
    { id: 'yesterday', label: 'Yesterday', sessions: [] },
    { id: 'thisWeek', label: 'This Week', sessions: [] },
    { id: 'older', label: 'Older', sessions: [] }
  ];

  for (const session of sessions) {
    const age = ageInDays(getSessionDateValue(session, dateBasis));
    if (age === 0) {
      buckets[0].sessions.push(session);
    } else if (age === 1) {
      buckets[1].sessions.push(session);
    } else if (age < 7) {
      buckets[2].sessions.push(session);
    } else {
      buckets[3].sessions.push(session);
    }
  }

  return buckets
    .filter((bucket) => bucket.sessions.length > 0)
    .map((bucket) => ({ type: 'group', ...bucket }));
}

function sortSessions(sessions) {
  const dateBasis = getSessionDateBasis();
  return sessions.sort((left, right) => {
    const leftTime = Date.parse(getSessionDateValue(left, dateBasis) || 0);
    const rightTime = Date.parse(getSessionDateValue(right, dateBasis) || 0);
    return rightTime - leftTime;
  });
}

function getSessionDateValue(session, dateBasis = getSessionDateBasis()) {
  if (dateBasis === SESSION_DATE_BASIS_CREATED_AT) {
    return session.createdAt || session.updatedAt;
  }

  return session.updatedAt || session.createdAt;
}

function getSessionDateBasis(context = extensionContext) {
  const storedValue = context && context.globalState.get(DATE_BASIS_STATE_KEY);
  if (isSessionDateBasis(storedValue)) {
    return storedValue;
  }

  const value = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('dateBasis', SESSION_DATE_BASIS_LAST_ACTIVITY);
  return isSessionDateBasis(value) ? value : SESSION_DATE_BASIS_LAST_ACTIVITY;
}

function isSessionDateBasis(value) {
  return value === SESSION_DATE_BASIS_LAST_ACTIVITY || value === SESSION_DATE_BASIS_CREATED_AT;
}

function ageInDays(value) {
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(0, Math.floor((startOfToday - startOfDate) / 86400000));
}

function formatRelativeTime(value) {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60000));

  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSessionIcon(session) {
  if (session.status === 'running') {
    return new vscode.ThemeIcon('sync~spin');
  }

  if (isSessionUnread(session)) {
    return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
  }

  return new vscode.ThemeIcon('comment-discussion');
}

function getSessionTooltip(session) {
  const state = session.status === 'running'
    ? 'Running'
    : isSessionUnread(session)
      ? 'Unread completed session'
      : undefined;
  return [session.title, state, session.url].filter(Boolean).join('\n');
}

function isSessionUnread(session) {
  return Boolean(session.unreadAt && !isDateAtOrAfter(session.lastReadAt, session.unreadAt));
}

function looksLikeChatUrl(value) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(value);
}

function validateUrlInput(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'URL is required.';
  }

  if (parseCodexConversationUri(trimmed)) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return 'Use an https URL or an openai-codex conversation URI.';
    }
  } catch {
    return 'Enter a valid URL.';
  }

  return undefined;
}

function normalizeUrl(value) {
  return value.trim().replace(/\/$/, '');
}

function titleFromUrl(value) {
  const codex = parseCodexConversationUri(value);
  if (codex) {
    return `Codex ${codex.conversationId.slice(0, 8)}`;
  }

  try {
    const parsed = new URL(value);
    const tail = parsed.pathname.split('/').filter(Boolean).pop();
    return tail ? `Chat ${tail.slice(0, 8)}` : 'Codex session';
  } catch {
    return 'Codex session';
  }
}

function unwrapSession(input) {
  if (!input) {
    return undefined;
  }

  return input.session || input;
}

function startAutoImport(context, provider) {
  const refreshWhenChanged = (changed) => {
    if (changed > 0) {
      provider.refresh();
    }
  };

  const runOpenTabs = debounce(async () => {
    if (!isAutoImportCodexTabsEnabled()) {
      return;
    }
    refreshWhenChanged(await importOpenCodexTabs(context));
  }, 500);

  const runLocalSessions = debounce(async (options = {}) => {
    if (!isAutoImportLocalCodexSessionsEnabled()) {
      return;
    }
    refreshWhenChanged(await importLocalCodexSessions(context, options));
  }, 500);

  const runLocalStatusRefresh = debounce(async () => {
    if (!isAutoImportLocalCodexSessionsEnabled()) {
      return;
    }
    refreshWhenChanged(await refreshLocalCodexSessionStatuses(context));
  }, 500);

  runOpenTabs();
  const localScanTimeout = setTimeout(runLocalSessions, 2000);
  const localScanInterval = setInterval(runLocalSessions, LOCAL_CODEX_SCAN_MIN_INTERVAL_MS);
  const localStatusInterval = setInterval(runLocalStatusRefresh, LOCAL_CODEX_STATUS_REFRESH_INTERVAL_MS);

  context.subscriptions.push(
    {
      dispose: () => {
        clearTimeout(localScanTimeout);
        clearInterval(localScanInterval);
        clearInterval(localStatusInterval);
      }
    },
    vscode.window.tabGroups.onDidChangeTabs(runOpenTabs),
    vscode.window.onDidChangeActiveTextEditor(() => {
      runOpenTabs();
      runLocalStatusRefresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateLocalCodexDiscoveryCache();
      runOpenTabs();
      runLocalSessions({ force: true });
      runLocalStatusRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('projectChatSessions.autoImportCodexTabs')) {
        runOpenTabs();
      }
      if (
        event.affectsConfiguration('projectChatSessions.autoImportLocalCodexSessions') ||
        event.affectsConfiguration('projectChatSessions.localCodexSessionsPath')
      ) {
        if (event.affectsConfiguration('projectChatSessions.localCodexSessionsPath')) {
          invalidateLocalCodexDiscoveryCache();
        }
        runLocalSessions({ force: true });
        runLocalStatusRefresh();
      }
    })
  );
}

async function importDetectedCodexSessions(context) {
  let changed = 0;

  if (isAutoImportCodexTabsEnabled()) {
    changed += await importOpenCodexTabs(context);
  }

  if (isAutoImportLocalCodexSessionsEnabled()) {
    changed += await importLocalCodexSessions(context);
  }

  return changed;
}

async function importOpenCodexTabs(context) {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  return importCodexSessionCandidates(context, workspaceKey, discoverOpenCodexSessions());
}

async function importLocalCodexSessions(context, options = {}) {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  const removed = await pruneImportedLocalCodexSubagentSessions(context, workspaceKey);
  const imported = await importCodexSessionCandidates(
    context,
    workspaceKey,
    discoverLocalCodexSessions(workspaceKey, options)
  );
  return removed + imported;
}

async function importCodexSessionCandidates(context, workspaceKey, discovered) {
  if (discovered.length === 0) {
    return 0;
  }

  const sessions = getSessions(context, workspaceKey);
  let changed = 0;

  for (const candidate of discovered) {
    const existing = sessions.find((session) => normalizeUrl(session.url) === normalizeUrl(candidate.url));
    const now = new Date().toISOString();

    if (existing) {
      let existingChanged = false;
      if (shouldUpdateExistingTitle(existing, candidate)) {
        existing.title = candidate.title;
        existing.titleSource = candidate.titleSource || existing.titleSource;
        existing.updatedAt = candidate.updatedAt || now;
        existingChanged = true;
      }
      if (candidate.kind && candidate.kind !== 'codex-local' && existing.kind !== candidate.kind) {
        existing.kind = candidate.kind;
        existing.updatedAt = candidate.updatedAt || now;
        existingChanged = true;
      }
      if (candidate.localFilePath && existing.localFilePath !== candidate.localFilePath) {
        existing.localFilePath = candidate.localFilePath;
        existingChanged = true;
      }
      if (mergeSessionStatus(existing, candidate)) {
        existingChanged = true;
      }
      if (candidate.updatedAt && isNewerDateString(candidate.updatedAt, existing.updatedAt || existing.createdAt)) {
        existing.updatedAt = candidate.updatedAt;
        existingChanged = true;
      }
      if (existingChanged) {
        changed += 1;
      }
      continue;
    }

    sessions.unshift({
      id: candidate.id || candidate.conversationId,
      title: candidate.title,
      url: candidate.url,
      kind: candidate.kind || 'codex',
      titleSource: candidate.titleSource || 'auto',
      createdAt: candidate.createdAt || now,
      updatedAt: candidate.updatedAt || now,
      localFilePath: candidate.localFilePath,
      status: candidate.status,
      lastStartedAt: candidate.lastStartedAt,
      lastCompletedAt: candidate.lastCompletedAt
    });
    changed += 1;
  }

  if (changed > 0) {
    await setSessions(context, workspaceKey, sessions);
  }

  return changed;
}

async function refreshLocalCodexSessionStatuses(context) {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  const sessions = getSessions(context, workspaceKey);
  let changed = 0;

  for (const session of sessions) {
    const parsed = parseCodexConversationUri(session.url);
    if (!parsed || parsed.kind !== 'local') {
      continue;
    }

    const filePath = session.localFilePath;
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    const status = readLocalCodexSessionStatus(filePath);
    if (!status.status) {
      continue;
    }

    if (mergeSessionStatus(session, status)) {
      changed += 1;
    }

    if (status.lastActivityAt && isNewerDateString(status.lastActivityAt, session.updatedAt || session.createdAt)) {
      session.updatedAt = status.lastActivityAt;
      changed += 1;
    }
  }

  if (changed > 0) {
    await setSessions(context, workspaceKey, sessions);
  }

  return changed;
}

function mergeSessionStatus(session, candidate) {
  let changed = false;
  const previousStatus = session.status;

  if (candidate.status && session.status !== candidate.status) {
    session.status = candidate.status;
    changed = true;
  }

  for (const field of ['lastStartedAt', 'lastCompletedAt']) {
    if (candidate[field] && session[field] !== candidate[field]) {
      session[field] = candidate[field];
      changed = true;
    }
  }

  if (
    (previousStatus === 'running' || previousStatus === 'stale') &&
    candidate.status === 'completed' &&
    candidate.lastCompletedAt &&
    !isDateAtOrAfter(session.lastReadAt, candidate.lastCompletedAt)
  ) {
    session.unreadAt = candidate.lastCompletedAt;
    changed = true;
  }

  if (session.unreadAt && isDateAtOrAfter(session.lastReadAt, session.unreadAt)) {
    delete session.unreadAt;
    changed = true;
  }

  return changed;
}

function shouldUpdateExistingTitle(existing, candidate) {
  if (!candidate.title || existing.title === candidate.title || existing.titleSource === 'manual') {
    return false;
  }

  if (candidate.titleSource === 'codex-thread-name') {
    return true;
  }

  if (candidate.titleSource === 'local-first-user-message') {
    return existing.titleSource === 'local-timestamp' || isGenericCodexTitle(existing.title);
  }

  return candidate.kind !== 'codex-local';
}

function isGenericCodexTitle(value) {
  return /^Codex(?: session| [0-9a-f]{8}| \d{4}-\d{2}-\d{2} \d{2}:\d{2})$/i.test(value || '');
}

async function pruneImportedLocalCodexSubagentSessions(context, workspaceKey) {
  const sessions = getSessions(context, workspaceKey);
  const retained = [];
  let removed = 0;

  for (const session of sessions) {
    if (isImportedLocalCodexSubagentSession(session)) {
      removed += 1;
      continue;
    }

    retained.push(session);
  }

  if (removed > 0) {
    await setSessions(context, workspaceKey, retained);
  }

  return removed;
}

function isImportedLocalCodexSubagentSession(session) {
  if (!session?.localFilePath) {
    return false;
  }

  const parsed = parseCodexConversationUri(session.url);
  if (!parsed || parsed.kind !== 'local') {
    return false;
  }

  const meta = readLocalCodexSessionMeta(session.localFilePath);
  return isLocalCodexSubagentSessionMeta(meta);
}

function isNewerDateString(candidate, current) {
  const candidateTime = Date.parse(candidate || '');
  const currentTime = Date.parse(current || '');
  if (Number.isNaN(candidateTime)) {
    return false;
  }
  return Number.isNaN(currentTime) || candidateTime > currentTime;
}

function isDateAtOrAfter(candidate, current) {
  const candidateTime = Date.parse(candidate || '');
  const currentTime = Date.parse(current || '');
  if (Number.isNaN(candidateTime) || Number.isNaN(currentTime)) {
    return false;
  }
  return candidateTime >= currentTime;
}

function latestDateString(values) {
  let latest;
  for (const value of values) {
    const normalized = dateStringOrUndefined(value);
    if (!normalized) {
      continue;
    }
    if (!latest || Date.parse(normalized) > Date.parse(latest)) {
      latest = normalized;
    }
  }
  return latest;
}

function discoverOpenCodexSessions() {
  const sessionsByUrl = new Map();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = getTabUri(tab);
      if (!uri) {
        continue;
      }

      const parsed = parseCodexConversationUri(uri.toString());
      if (!parsed) {
        continue;
      }

      sessionsByUrl.set(uri.toString(), {
        conversationId: parsed.conversationId,
        title: cleanTitle(tab.label) || `Codex ${parsed.conversationId.slice(0, 8)}`,
        url: uri.toString(),
        titleSource: 'codex-tab'
      });
    }
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const parsed = parseCodexConversationUri(activeUri.toString());
    if (parsed && !sessionsByUrl.has(activeUri.toString())) {
      sessionsByUrl.set(activeUri.toString(), {
        conversationId: parsed.conversationId,
        title: `Codex ${parsed.conversationId.slice(0, 8)}`,
        url: activeUri.toString(),
        titleSource: 'codex-tab'
      });
    }
  }

  return [...sessionsByUrl.values()];
}

function discoverLocalCodexSessions(workspaceKey, options = {}) {
  const sessionsDir = getLocalCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) {
    invalidateLocalCodexDiscoveryCache();
    return [];
  }

  const workspacePath = normalizePathForComparison(workspaceKey);
  const sessionsPath = normalizePathForComparison(sessionsDir);
  const cacheKey = `${workspacePath}\n${sessionsPath}`;
  const now = Date.now();
  if (
    !options.force &&
    localCodexDiscoveryCache.key === cacheKey &&
    now - localCodexDiscoveryCache.scannedAt < LOCAL_CODEX_SCAN_MIN_INTERVAL_MS
  ) {
    return localCodexDiscoveryCache.candidates.map((candidate) => ({ ...candidate }));
  }

  const sessionIndex = readLocalCodexSessionIndex(sessionsDir);
  const candidates = [];

  for (const file of collectJsonlFiles(sessionsDir)) {
    const meta = readLocalCodexSessionMeta(file.path);
    if (!meta || !meta.id || !meta.cwd || !meta.hasUserMessage) {
      continue;
    }

    if (isLocalCodexSubagentSessionMeta(meta)) {
      continue;
    }

    if (normalizePathForComparison(meta.cwd) !== workspacePath) {
      continue;
    }

    const createdAt = dateStringOrUndefined(meta.timestamp) || new Date(file.mtimeMs).toISOString();
    const indexEntry = sessionIndex.get(meta.id);
    const status = readLocalCodexSessionStatus(file.path);
    const updatedAt = latestDateString([
      dateStringOrUndefined(indexEntry?.updatedAt),
      status.lastActivityAt,
      new Date(file.mtimeMs).toISOString()
    ]);
    candidates.push({
      id: meta.id,
      conversationId: meta.id,
      title: titleFromLocalCodexSession(meta, indexEntry),
      url: `${CODEX_SCHEME}://${CODEX_AUTHORITY}/local/${meta.id}`,
      kind: 'codex-local',
      titleSource: titleSourceFromLocalCodexSession(meta, indexEntry),
      createdAt,
      updatedAt,
      localFilePath: file.path,
      status: status.status,
      lastStartedAt: status.lastStartedAt,
      lastCompletedAt: status.lastCompletedAt
    });
  }

  localCodexDiscoveryCache.key = cacheKey;
  localCodexDiscoveryCache.scannedAt = now;
  localCodexDiscoveryCache.candidates = candidates.map((candidate) => ({ ...candidate }));

  return candidates;
}

function invalidateLocalCodexDiscoveryCache() {
  localCodexDiscoveryCache.key = undefined;
  localCodexDiscoveryCache.scannedAt = 0;
  localCodexDiscoveryCache.candidates = [];
}

function readLocalCodexSessionIndex(sessionsDir) {
  const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
  const index = new Map();
  const text = readFilePrefix(indexPath, 4194304);
  if (!text) {
    return index;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const id = stringOrUndefined(record.id);
    const threadName = cleanCodexThreadName(record.thread_name);
    if (!id || !threadName) {
      continue;
    }

    index.set(id, {
      threadName,
      updatedAt: stringOrUndefined(record.updated_at)
    });
  }

  return index;
}

function collectJsonlFiles(rootDir) {
  const files = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while Codex is rotating session logs.
      }
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readLocalCodexSessionMeta(filePath) {
  const text = readFilePrefix(filePath, 262144);
  if (!text) {
    return undefined;
  }

  let meta;
  let hasUserMessage = false;
  let firstUserMessage;

  for (const line of text.split(/\r?\n/).slice(0, 128)) {
    if (!line.trim()) {
      continue;
    }

    if (/"type"\s*:\s*"user_message"/.test(line) || /"role"\s*:\s*"user"/.test(line)) {
      hasUserMessage = true;
      firstUserMessage = firstUserMessage || extractLocalCodexUserMessageText(line);
      if (meta) {
        return { ...meta, hasUserMessage, firstUserMessage };
      }
      continue;
    }

    if (!/"type"\s*:\s*"session_meta"/.test(line)) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type !== 'session_meta' || !record.payload) {
      continue;
    }

    meta = {
      id: stringOrUndefined(record.payload.id),
      cwd: stringOrUndefined(record.payload.cwd),
      timestamp: stringOrUndefined(record.payload.timestamp),
      source: record.payload.source,
      threadSource: stringOrUndefined(record.payload.thread_source),
      hasUserMessage,
      firstUserMessage
    };

    if (hasUserMessage) {
      return meta;
    }
  }

  return meta ? { ...meta, hasUserMessage, firstUserMessage } : undefined;
}

function isLocalCodexSubagentSessionMeta(meta) {
  if (!meta) {
    return false;
  }

  if (meta.threadSource === 'subagent') {
    return true;
  }

  const source = meta.source;
  if (typeof source === 'string') {
    return source.toLowerCase() === 'subagent';
  }

  return Boolean(
    source &&
    typeof source === 'object' &&
    (source.subagent || source.thread_spawn || source.threadSpawn)
  );
}

function extractLocalCodexUserMessageText(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }

  const payload = record.payload && typeof record.payload === 'object' ? record.payload : record;
  if (payload.type === 'user_message') {
    return stringOrUndefined(extractText(payload.message) || extractText(payload.text_elements));
  }

  if (payload.role === 'user' || record.role === 'user') {
    return stringOrUndefined(extractText(payload.content ?? payload.message ?? record.content ?? record.message));
  }

  return undefined;
}

function extractText(value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join(' ');
  }

  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'message', 'value']) {
      const text = extractText(value[key], depth + 1);
      if (text) {
        return text;
      }
    }
  }

  return '';
}

function readFilePrefix(filePath, maxBytes) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore close failures for best-effort discovery.
      }
    }
  }
}

function readFileSuffix(filePath, maxBytes) {
  let handle;
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(handle, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore close failures for best-effort discovery.
      }
    }
  }
}

function readLocalCodexSessionStatus(filePath) {
  const text = readFileSuffix(filePath, LOCAL_CODEX_STATUS_SUFFIX_BYTES);
  if (!text) {
    return {};
  }

  let lastStartedAt;
  let lastCompletedAt;
  let lastActivityAt;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = dateStringOrUndefined(record.timestamp);
    if (timestamp) {
      lastActivityAt = latestDateString([lastActivityAt, timestamp]);
    }

    if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object') {
      continue;
    }

    if (record.payload.type === 'task_started' && timestamp) {
      lastStartedAt = timestamp;
    } else if (record.payload.type === 'task_complete' && timestamp) {
      lastCompletedAt = timestamp;
    }
  }

  let status;
  if (lastStartedAt && !isDateAtOrAfter(lastCompletedAt, lastStartedAt)) {
    const activeAt = Date.parse(lastActivityAt || lastStartedAt);
    status = Date.now() - activeAt > LOCAL_CODEX_RUNNING_STALE_MS ? 'stale' : 'running';
  } else if (lastCompletedAt) {
    status = 'completed';
  }

  return {
    status,
    lastStartedAt,
    lastCompletedAt,
    lastActivityAt
  };
}

function titleFromLocalCodexSession(meta, indexEntry) {
  if (indexEntry?.threadName) {
    return indexEntry.threadName;
  }

  const createdAt = dateStringOrUndefined(meta.timestamp);
  const titleName = titleNameFromUserMessage(meta.firstUserMessage);
  if (createdAt) {
    const titleDate = formatLocalDateForTitle(new Date(createdAt));
    return titleName ? `${titleName} ${titleDate}` : `Codex ${titleDate}`;
  }

  return titleName || `Codex ${meta.id.slice(0, 8)}`;
}

function titleSourceFromLocalCodexSession(meta, indexEntry) {
  if (indexEntry?.threadName) {
    return 'codex-thread-name';
  }

  return titleNameFromUserMessage(meta.firstUserMessage) ? 'local-first-user-message' : 'local-timestamp';
}

function cleanCodexThreadName(value) {
  const text = stringOrUndefined(value);
  return text ? text.replace(/\s+/g, ' ').trim() : undefined;
}

function titleNameFromUserMessage(value) {
  const cleaned = cleanUserMessageForTitle(value);
  return cleaned ? truncateTitle(cleaned, 52) : undefined;
}

function cleanUserMessageForTitle(value) {
  let text = stringOrUndefined(value);
  if (!text) {
    return undefined;
  }

  text = textAfterLastMarker(text, '</environment_context>');
  text = textAfterLastMarker(text, '</INSTRUCTIONS>');

  const requestMarker = /(?:^|\n)##\s*My request for Codex:\s*/i.exec(text);
  if (requestMarker) {
    text = text.slice(requestMarker.index + requestMarker[0].length);
  }

  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[#>\-*]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text || undefined;
}

function textAfterLastMarker(text, marker) {
  const index = text.lastIndexOf(marker);
  return index === -1 ? text : text.slice(index + marker.length);
}

function truncateTitle(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const hardLimit = value.slice(0, Math.max(0, maxLength - 3));
  const wordLimited = hardLimit.replace(/\s+\S*$/, '').trimEnd();
  return `${wordLimited || hardLimit.trimEnd()}...`;
}

function formatLocalDateForTitle(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getLocalCodexSessionsDir() {
  const configured = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('localCodexSessionsPath', '')
    .trim();

  if (configured) {
    return expandHomePath(configured);
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function expandHomePath(value) {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function normalizePathForComparison(value) {
  let normalized = value;
  try {
    normalized = fs.realpathSync.native(value);
  } catch {
    normalized = path.normalize(value);
  }

  normalized = normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateStringOrUndefined(value) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function getTabUri(tab) {
  const input = tab.input;
  if (!input) {
    return undefined;
  }

  return asUri(input.uri) || asUri(input.modified) || asUri(input.original);
}

function asUri(value) {
  if (!value || typeof value.scheme !== 'string' || typeof value.toString !== 'function') {
    return undefined;
  }

  return value;
}

function parseCodexConversationUri(value) {
  let uri;
  try {
    uri = typeof value === 'string' ? vscode.Uri.parse(value) : value;
  } catch {
    return undefined;
  }

  if (uri.scheme !== CODEX_SCHEME || uri.authority !== CODEX_AUTHORITY) {
    return undefined;
  }

  const parts = uri.path.split('/').filter(Boolean);
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }

  return {
    kind: parts[0],
    conversationId: parts[1]
  };
}

function cleanTitle(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^Codex Task\s*[-:]\s*/i, '')
    .trim();
}

function isAutoImportCodexTabsEnabled() {
  return vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('autoImportCodexTabs', true);
}

function isAutoImportLocalCodexSessionsEnabled() {
  return vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('autoImportLocalCodexSessions', true);
}

function debounce(fn, delayMs) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => {
      fn(...args);
    }, delayMs);
  };
}

module.exports = {
  activate,
  deactivate
};
