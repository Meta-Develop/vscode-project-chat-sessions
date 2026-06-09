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
const LINEAGE_CATEGORY_ALL = 'all';
const LINEAGE_CATEGORY_O2 = 'o2';
const LINEAGE_CATEGORY_O1 = 'o1';
const LINEAGE_CATEGORY_OTHER = 'other';
const LINEAGE_FILTER_ACTION_DEFAULT = 'default';
const LINEAGE_FILTER_ACTION_SOURCE = 'source';
const CODEX_SCHEME = 'openai-codex';
const CODEX_AUTHORITY = 'route';
const CODEX_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const LOCAL_CODEX_SCAN_MIN_INTERVAL_MS = 60000;
const LOCAL_CODEX_SCAN_MAX_DIRECTORIES = 8192;
const LOCAL_CODEX_SCAN_MAX_JSONL_FILES = 20000;
const LOCAL_CODEX_RECENT_IMPORT_DAYS = 2;
const LOCAL_CODEX_RECENT_IMPORT_MAX_JSONL_FILES = 512;
const LOCAL_CODEX_RECENT_SCAN_MIN_INTERVAL_MS = 15000;
const LOCAL_CODEX_SESSION_INDEX_PREFIX_BYTES = 4194304;
const LOCAL_CODEX_SESSION_INDEX_FORCE_SUFFIX_BYTES = 16777216;
const LOCAL_CODEX_STATUS_REFRESH_INTERVAL_MS = 45000;
const LOCAL_CODEX_STATUS_SUFFIX_BYTES = 524288;
const LOCAL_CODEX_RUNNING_STALE_MS = 90 * 1000;
const LOCAL_CODEX_TERMINAL_MTIME_GRACE_MS = 2000;
const LOCAL_CODEX_TARGETED_LOOKUP_DAYS = 45;
const NEW_CODEX_SESSION_IMPORT_DELAYS_MS = [500, 1500, 3000, 6000, 10000, 15000];
const LOCAL_CODEX_O1_PROMPT_MARKERS = [
  'You are a child orchestrator in an opt-in local Codex CLI supervisor run.'
];
const LOCAL_CODEX_OTHER_PROMPT_MARKERS = [
  'You are a worker in an opt-in local Codex CLI supervised run.'
];
const MACO_LINEAGE_PREFIX_LINES = 12;
const MACO_LINEAGE_EARLY_SCAN_LINES = 96;
const MACO_LINEAGE_BLOCK_MAX_LINES = 8;
const MACO_LINEAGE_METADATA_PATTERN = /^\s*(ROLE|AGENT_KIND|AGENT_LABEL|PARENT_THREAD_ID|THREAD_DEPTH|NO_FURTHER_DELEGATION)\s*:\s*(.*?)\s*$/i;

const localCodexDiscoveryCache = {
  key: undefined,
  scannedAt: 0,
  candidates: []
};

const localCodexRecentDiscoveryCache = {
  key: undefined,
  scannedAt: 0,
  candidates: []
};

const localCodexSessionMetaCache = {
  key: undefined,
  scannedAt: 0,
  byId: new Map()
};
const localCodexStatusMtimeCache = new Map();
const localCodexTargetedFileCache = new Map();
let extensionContext;

class SessionTreeProvider {
  constructor(context) {
    this.context = context;
    this.lineageFilter = undefined;
    this.treeView = undefined;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  setTreeView(treeView) {
    this.treeView = treeView;
    this.updateMessage();
  }

  async setLineageFilter(filter) {
    this.lineageFilter = filter;
    this.updateMessage();
    await updateLineageFilterContext(Boolean(filter));
    this.refresh();
  }

  async clearLineageFilter() {
    await this.setLineageFilter(undefined);
  }

  refresh() {
    this.updateMessage();
    this._onDidChangeTreeData.fire();
  }

  updateMessage() {
    if (!this.treeView) {
      return;
    }

    if (!this.lineageFilter) {
      this.treeView.message = undefined;
      return;
    }

    const categoryLabel = labelForLineageCategory(this.lineageFilter.category);
    if (this.lineageFilter.sourceThreadId) {
      this.treeView.message = `Lineage: ${this.lineageFilter.sourceTitle} (${categoryLabel})`;
      return;
    }

    this.treeView.message = `Lineage role filter: ${categoryLabel}`;
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

    const allSessions = getSessions(this.context, workspaceKey);
    const sessions = getVisibleSessionsForTree(allSessions, this.lineageFilter);
    if (allSessions.length === 0) {
      return [
        {
          type: 'empty',
          label: 'No sessions for this workspace',
          description: 'Use + to add a ChatGPT/Codex URL.'
        }
      ];
    }

    if (sessions.length === 0 && this.lineageFilter) {
      return [
        {
          type: 'empty',
          label: 'No sessions match this lineage filter',
          description: 'Clear the filter or choose another role.'
        }
      ];
    }

    if (sessions.length === 0) {
      return [
        {
          type: 'empty',
          label: 'No visible sessions',
          description: 'Spawned/delegated local Codex sessions are hidden until filtering is active.'
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
  await updateLineageFilterContext(false);
  const treeOptions = {
    treeDataProvider: provider,
    showCollapseAll: true
  };
  const activityBarTree = vscode.window.createTreeView('projectChatSessions.sessionsView', treeOptions);
  provider.setTreeView(activityBarTree);

  context.subscriptions.push(
    activityBarTree,
    vscode.commands.registerCommand('projectChatSessions.refresh', async () => {
      await importDetectedCodexSessions(context, { forceLocal: true });
      provider.refresh();
    }),
    vscode.commands.registerCommand('projectChatSessions.setViewLocation', async () => {
      await setViewLocation(context);
    }),
    vscode.commands.registerCommand('projectChatSessions.setDateBasis', async () => {
      await setDateBasis(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand('projectChatSessions.setLineageFilter', async () => {
      await setLineageFilterFromPicker(context, provider);
    }),
    vscode.commands.registerCommand('projectChatSessions.showO2LineageSessions', async () => {
      await setLineageRoleFilter(context, provider, LINEAGE_CATEGORY_O2);
    }),
    vscode.commands.registerCommand('projectChatSessions.showO1LineageSessions', async () => {
      await setLineageRoleFilter(context, provider, LINEAGE_CATEGORY_O1);
    }),
    vscode.commands.registerCommand('projectChatSessions.showOtherLineageSessions', async () => {
      await setLineageRoleFilter(context, provider, LINEAGE_CATEGORY_OTHER);
    }),
    vscode.commands.registerCommand('projectChatSessions.clearLineageFilter', async () => {
      await provider.clearLineageFilter();
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
        vscode.window.showWarningMessage('No open Codex tab session changes were found in this VS Code window.');
        return;
      }
      vscode.window.showInformationMessage(`Updated ${count} open Codex session${count === 1 ? '' : 's'}.`);
    }),
    vscode.commands.registerCommand('projectChatSessions.importLocalCodexSessions', async () => {
      if (!requireWorkspaceKey()) {
        return 0;
      }

      if (!isLocalCodexFilesystemAccessAllowed()) {
        showLocalCodexWorkspaceTrustWarning();
        return 0;
      }

      const count = await importLocalCodexSessions(context, { force: true });
      provider.refresh();
      if (count === 0) {
        vscode.window.showWarningMessage('No local Codex session changes were found for this workspace.');
        return 0;
      }
      vscode.window.showInformationMessage(`Updated ${count} local Codex session${count === 1 ? '' : 's'}.`);
      return count;
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
        if (await openUrl(session.url)) {
          await touchSession(context, session.id);
          provider.refresh();
        }
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
    vscode.commands.registerCommand('projectChatSessions.filterLineageFromSession', async (input) => {
      const session = unwrapSession(input);
      if (session) {
        await setLineageFilterFromSession(context, provider, session);
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

async function setLineageFilterFromPicker(context, provider) {
  if (!requireWorkspaceKey()) {
    return;
  }

  const options = [
    {
      label: 'Default',
      value: LINEAGE_FILTER_ACTION_DEFAULT,
      description: 'Hide spawned/delegated agents'
    },
    {
      label: 'O2 root/top-supervisor sessions',
      value: LINEAGE_CATEGORY_O2,
      description: 'MACO O2 and local Codex roots'
    },
    {
      label: 'O1 MACO child orchestrators',
      value: LINEAGE_CATEGORY_O1,
      description: 'Only explicit MACO O1 sessions'
    },
    {
      label: 'Spawned agents / Other',
      value: LINEAGE_CATEGORY_OTHER,
      description: 'Workers, researchers, native subagents, auditors'
    },
    {
      label: 'Full lineage from a session...',
      value: LINEAGE_FILTER_ACTION_SOURCE,
      description: 'Choose a source session and lineage category'
    }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Project Chats Filter',
    placeHolder: 'Choose which sessions to show',
    activeItem: activeLineageFilterOption(options, provider.lineageFilter)
  });
  if (!selected) {
    return;
  }

  if (selected.value === LINEAGE_FILTER_ACTION_DEFAULT) {
    await provider.clearLineageFilter();
    return;
  }

  if (selected.value === LINEAGE_FILTER_ACTION_SOURCE) {
    await setLineageFilterFromSourcePicker(context, provider);
    return;
  }

  await setLineageRoleFilter(context, provider, selected.value);
}

function activeLineageFilterOption(options, lineageFilter) {
  if (!lineageFilter) {
    return options.find((option) => option.value === LINEAGE_FILTER_ACTION_DEFAULT);
  }

  if (lineageFilter.sourceThreadId) {
    return options.find((option) => option.value === LINEAGE_FILTER_ACTION_SOURCE);
  }

  return options.find((option) => option.value === lineageFilter.category);
}

async function setLineageFilterFromSourcePicker(context, provider) {
  if (!(await refreshLocalCodexMetadataForLineageFilter(context, provider))) {
    return;
  }

  const workspaceKey = getWorkspaceKey();
  const sessions = getSessions(context, workspaceKey);
  if (sessions.length === 0) {
    vscode.window.showWarningMessage('No sessions are saved for this workspace.');
    return;
  }

  const options = sessions.map((session) => {
    const role = labelForLineageCategory(getSessionLineageRole(session));
    const date = formatRelativeTime(getSessionDateValue(session));
    return {
      label: session.title,
      description: role,
      detail: `${date} - ${session.url}`,
      session
    };
  });

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Filter by Codex Lineage',
    placeHolder: 'Choose the source session'
  });
  if (!selected) {
    return;
  }

  await setLineageFilterFromSession(context, provider, selected.session, { refreshBeforeApply: false });
}

async function setLineageRoleFilter(context, provider, category) {
  if (!(await refreshLocalCodexMetadataForLineageFilter(context, provider))) {
    return;
  }

  await provider.setLineageFilter({
    category
  });
}

async function setLineageFilterFromSession(context, provider, session, options = {}) {
  const category = await pickLineageCategory();
  if (!category) {
    return;
  }

  const sourceThreadId = getSessionThreadId(session);
  if (!sourceThreadId) {
    vscode.window.showWarningMessage('This session does not have a usable thread id for lineage filtering.');
    return;
  }

  if (options.refreshBeforeApply !== false) {
    if (!(await refreshLocalCodexMetadataForLineageFilter(context, provider))) {
      return;
    }
  }

  await provider.setLineageFilter({
    sourceThreadId,
    sourceTitle: session.title || sourceThreadId,
    category
  });
}

async function pickLineageCategory() {
  const options = [
    {
      label: 'Full lineage',
      value: LINEAGE_CATEGORY_ALL,
      description: 'Show the selected source session and all descendants.'
    },
    {
      label: 'O2 roots/top supervisors',
      value: LINEAGE_CATEGORY_O2,
      description: 'Show MACO O2 and local Codex roots.'
    },
    {
      label: 'O1 MACO child orchestrators',
      value: LINEAGE_CATEGORY_O1,
      description: 'Show explicit MACO O1 sessions.'
    },
    {
      label: 'Spawned/delegated agents',
      value: LINEAGE_CATEGORY_OTHER,
      description: 'Show workers, researchers, native subagents, and auditors.'
    }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Lineage Category',
    placeHolder: 'Choose which part of the lineage to show'
  });

  return selected?.value;
}

async function refreshLocalCodexMetadataForLineageFilter(context, provider) {
  if (!requireWorkspaceKey()) {
    return false;
  }

  if (isLocalCodexFilesystemAccessAllowed()) {
    await importDetectedCodexSessions(context, { forceLocal: true });
    provider.refresh();
  }

  return true;
}

async function updateLineageFilterContext(active) {
  await vscode.commands.executeCommand('setContext', 'projectChatSessions.hasLineageFilter', active);
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
    scheduleNewCodexSessionImports(context, provider);
    return;
  } catch {
    // Fall back to URL opening when the OpenAI Codex extension is unavailable.
  }

  const fallbackUrl = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('defaultNewSessionUrl', 'https://chatgpt.com/');

  await openUrl(fallbackUrl);
}

function scheduleNewCodexSessionImports(context, provider) {
  for (const delayMs of NEW_CODEX_SESSION_IMPORT_DELAYS_MS) {
    const handle = setTimeout(async () => {
      try {
        const changed = await importNewCodexSessionCandidates(context);
        if (changed > 0) {
          provider.refresh();
        }
      } catch {
        // Best-effort reflection only; the manual import commands remain available.
      }
    }, delayMs);

    context.subscriptions.push({ dispose: () => clearTimeout(handle) });
  }
}

async function importNewCodexSessionCandidates(context) {
  let changed = 0;
  changed += await importOpenCodexTabs(context);
  changed += await importRecentLocalCodexSessions(context, { force: true });
  return changed;
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
  const value = stringOrUndefined(url);
  if (!value) {
    vscode.window.showWarningMessage('Refused to open an empty session URL.');
    return false;
  }

  const codexUri = parseCodexConversationUri(value);
  if (value.toLowerCase().startsWith(`${CODEX_SCHEME}:`)) {
    if (!codexUri) {
      vscode.window.showWarningMessage('Refused to open an invalid Codex conversation URI.');
      return false;
    }

    await openCodexUrl(value, codexUri);
    return true;
  }

  const uri = parseHttpsUri(value);
  if (!uri) {
    vscode.window.showWarningMessage('Refused to open a session URL that is not a valid https URL.');
    return false;
  }

  const mode = vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('openMode', 'externalBrowser');

  if (mode === 'simpleBrowser') {
    try {
      await vscode.commands.executeCommand('simpleBrowser.show', uri);
      return true;
    } catch {
      // Fall back to the system browser when the Simple Browser command is not available.
    }
  }

  await vscode.env.openExternal(uri);
  return true;
}

async function openCodexUrl(url, parsed = parseCodexConversationUri(url)) {
  if (!parsed) {
    return false;
  }

  if (await openCodexSidebarRoute(parsed)) {
    return true;
  }

  const uri = vscode.Uri.parse(url);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR_VIEW_TYPE);
    return true;
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
    return true;
  }
}

function parseHttpsUri(value) {
  const trimmed = stringOrUndefined(value);
  if (!trimmed) {
    return undefined;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return undefined;
  }

  try {
    return vscode.Uri.parse(parsed.href);
  } catch {
    return undefined;
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

function isLocalCodexFilesystemAccessAllowed() {
  return vscode.workspace.isTrusted !== false;
}

function showLocalCodexWorkspaceTrustWarning() {
  vscode.window.showWarningMessage(
    'Local Codex session file access is disabled in Restricted Mode. Trust this workspace to import or refresh local Codex sessions.'
  );
}

function getVisibleSessionsForTree(sessions, lineageFilter) {
  if (lineageFilter) {
    return applyLineageFilter(sessions, lineageFilter);
  }

  return sessions.filter((session) => !isDefaultHiddenLocalCodexSession(session));
}

function applyLineageFilter(sessions, lineageFilter) {
  const sourceThreadId = normalizeThreadId(lineageFilter?.sourceThreadId);
  if (!sourceThreadId) {
    if (lineageFilter?.category === LINEAGE_CATEGORY_ALL) {
      return sessions;
    }
    return sessions.filter((session) => getSessionLineageRole(session) === lineageFilter?.category);
  }

  const childIdsByParent = new Map();
  for (const session of sessions) {
    const threadId = normalizeThreadId(getSessionThreadId(session));
    const parentThreadId = normalizeThreadId(session.parentThreadId);
    if (!threadId || !parentThreadId) {
      continue;
    }

    const childIds = childIdsByParent.get(parentThreadId) || [];
    childIds.push(threadId);
    childIdsByParent.set(parentThreadId, childIds);
  }

  const lineageIds = new Set();
  const pending = [sourceThreadId];
  while (pending.length > 0) {
    const threadId = pending.pop();
    if (!threadId || lineageIds.has(threadId)) {
      continue;
    }

    lineageIds.add(threadId);
    for (const childId of childIdsByParent.get(threadId) || []) {
      pending.push(childId);
    }
  }

  return sessions.filter((session) => {
    const threadId = normalizeThreadId(getSessionThreadId(session));
    if (!threadId || !lineageIds.has(threadId)) {
      return false;
    }

    if (lineageFilter.category === LINEAGE_CATEGORY_ALL) {
      return true;
    }

    return getSessionLineageRole(session) === lineageFilter.category;
  });
}

function isDefaultHiddenLocalCodexSession(session) {
  if (!isLocalCodexSession(session)) {
    return false;
  }

  if (normalizeThreadId(session.parentThreadId)) {
    return true;
  }

  const role = getSessionLineageRole(session);
  return role === LINEAGE_CATEGORY_O1 || role === LINEAGE_CATEGORY_OTHER;
}

function isLocalCodexSession(session) {
  if (session?.kind === 'codex-local' || session?.localFilePath) {
    return true;
  }

  const parsed = parseCodexConversationUri(session?.url || '');
  return parsed?.kind === 'local';
}

function getSessionThreadId(session) {
  const parsed = parseCodexConversationUri(session?.url || '');
  return stringOrUndefined(parsed?.conversationId) || stringOrUndefined(session?.threadId) || stringOrUndefined(session?.id);
}

function normalizeThreadId(value) {
  return stringOrUndefined(value)?.toLowerCase();
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

  if (session.status === 'failed') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  }

  if (session.status === 'aborted' || session.status === 'stale') {
    return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('descriptionForeground'));
  }

  if (isSessionUnread(session)) {
    return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
  }

  return new vscode.ThemeIcon('comment-discussion');
}

function getSessionTooltip(session) {
  const state = getSessionStatusLabel(session) || (isSessionUnread(session) ? 'Unread completed session' : undefined);
  return [session.title, state, session.url].filter(Boolean).join('\n');
}

function getSessionStatusLabel(session) {
  switch (session.status) {
    case 'running':
      return 'Running';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Aborted';
    case 'stale':
      return 'Stopped';
    default:
      return undefined;
  }
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

  const runRecentLocalSessions = debounce(async (options = {}) => {
    refreshWhenChanged(await importRecentLocalCodexSessions(context, options));
  }, 500);

  const runLocalStatusRefresh = debounce(async () => {
    if (!hasRefreshableLocalCodexSessions(context)) {
      return;
    }
    refreshWhenChanged(await refreshLocalCodexSessionStatuses(context));
  }, 500);

  runOpenTabs();
  runRecentLocalSessions();
  runLocalStatusRefresh();
  const localScanTimeout = setTimeout(runLocalSessions, 2000);
  const localScanInterval = setInterval(runLocalSessions, LOCAL_CODEX_SCAN_MIN_INTERVAL_MS);
  const recentLocalScanInterval = setInterval(runRecentLocalSessions, LOCAL_CODEX_STATUS_REFRESH_INTERVAL_MS);
  const localStatusInterval = setInterval(runLocalStatusRefresh, LOCAL_CODEX_STATUS_REFRESH_INTERVAL_MS);

  context.subscriptions.push(
    {
      dispose: () => {
        clearTimeout(localScanTimeout);
        clearInterval(localScanInterval);
        clearInterval(recentLocalScanInterval);
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
      runRecentLocalSessions({ force: true });
      runLocalSessions({ force: true });
      runLocalStatusRefresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      invalidateLocalCodexDiscoveryCache();
      runOpenTabs();
      runRecentLocalSessions({ force: true });
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
        runRecentLocalSessions({ force: true });
        runLocalSessions({ force: true });
        runLocalStatusRefresh();
      }
    })
  );
}

async function importDetectedCodexSessions(context, options = {}) {
  let changed = 0;

  if (isAutoImportCodexTabsEnabled()) {
    changed += await importOpenCodexTabs(context);
  }

  changed += await importRecentLocalCodexSessions(context, {
    force: Boolean(options.forceLocal)
  });

  if (options.forceLocal) {
    changed += await importLocalCodexSessions(context, { force: true });
  } else if (isAutoImportLocalCodexSessionsEnabled()) {
    changed += await importLocalCodexSessions(context);
  }

  return changed;
}

async function importOpenCodexTabs(context) {
  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  const imported = await importCodexSessionCandidates(context, workspaceKey, discoverOpenCodexSessions());
  return imported;
}

async function importLocalCodexSessions(context, options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return 0;
  }

  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  const imported = await importCodexSessionCandidates(
    context,
    workspaceKey,
    discoverLocalCodexSessions(workspaceKey, options)
  );
  return imported;
}

async function importRecentLocalCodexSessions(context, options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return 0;
  }

  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return 0;
  }

  return importCodexSessionCandidates(
    context,
    workspaceKey,
    discoverRecentLocalCodexSessions(workspaceKey, options)
  );
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
      if (mergeSessionLineageMetadata(existing, candidate)) {
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
      lastCompletedAt: candidate.lastCompletedAt,
      lastAbortedAt: candidate.lastAbortedAt,
      lastFailedAt: candidate.lastFailedAt,
      parentThreadId: candidate.parentThreadId,
      threadDepth: candidate.threadDepth,
      agentRole: candidate.agentRole,
      agentNickname: candidate.agentNickname,
      agentKind: candidate.agentKind,
      noFurtherDelegation: candidate.noFurtherDelegation,
      isDelegatedLocalCodexSession: candidate.isDelegatedLocalCodexSession,
      lineageRole: candidate.lineageRole
    });
    changed += 1;
  }

  if (changed > 0) {
    await setSessions(context, workspaceKey, sessions);
  }

  return changed;
}

async function refreshLocalCodexSessionStatuses(context) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return 0;
  }

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
    if (!filePath) {
      continue;
    }

    const stat = statLocalFile(filePath);
    if (!stat) {
      continue;
    }

    const fileStamp = localCodexStatusFileStamp(stat);
    if (localCodexStatusMtimeCache.get(filePath) === fileStamp) {
      const mtimeStatus = statusFromExistingSessionMtime(session, stat);
      if (!mtimeStatus.status) {
        continue;
      }

      if (mergeSessionStatus(session, mtimeStatus)) {
        changed += 1;
      }
      continue;
    }

    localCodexStatusMtimeCache.set(filePath, fileStamp);
    const status = readLocalCodexSessionStatus(filePath, stat);
    const effectiveStatus = status.status
      ? status
      : statusFromExistingSessionMtime(session, stat);
    if (!effectiveStatus.status) {
      continue;
    }

    if (mergeSessionStatus(session, effectiveStatus)) {
      changed += 1;
    }

    if (
      effectiveStatus.lastActivityAt &&
      isNewerDateString(effectiveStatus.lastActivityAt, session.updatedAt || session.createdAt)
    ) {
      session.updatedAt = effectiveStatus.lastActivityAt;
      changed += 1;
    }
  }

  if (changed > 0) {
    await setSessions(context, workspaceKey, sessions);
  }

  return changed;
}

function statusFromExistingSessionMtime(session, stat) {
  if (session?.status !== 'running' && session?.status !== 'stale') {
    return {};
  }

  const activeAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
  if (!activeAt) {
    return {};
  }

  return {
    status: activeLocalCodexStatusFromTime(activeAt),
    lastStartedAt: session.lastStartedAt,
    lastActivityAt: new Date(activeAt).toISOString()
  };
}

function localCodexStatusFileStamp(stat) {
  const mtimeMs = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : 0;
  const size = Number.isFinite(stat?.size) ? stat.size : 0;
  return `${mtimeMs}:${size}`;
}

function statLocalFile(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function hasRefreshableLocalCodexSessions(context) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return false;
  }

  const workspaceKey = getWorkspaceKey();
  if (!workspaceKey) {
    return false;
  }

  return getSessions(context, workspaceKey).some((session) => {
    const parsed = parseCodexConversationUri(session.url);
    return parsed?.kind === 'local' && Boolean(session.localFilePath);
  });
}

function mergeSessionStatus(session, candidate) {
  let changed = false;
  const previousStatus = session.status;

  if (candidate.status && session.status !== candidate.status) {
    session.status = candidate.status;
    changed = true;
  }

  for (const field of ['lastStartedAt', 'lastCompletedAt', 'lastAbortedAt', 'lastFailedAt']) {
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

function mergeSessionLineageMetadata(session, candidate) {
  let changed = false;
  for (const field of [
    'parentThreadId',
    'threadDepth',
    'agentRole',
    'agentNickname',
    'agentKind',
    'noFurtherDelegation',
    'isDelegatedLocalCodexSession',
    'lineageRole'
  ]) {
    if (candidate[field] !== undefined && session[field] !== candidate[field]) {
      session[field] = candidate[field];
      changed = true;
    }
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

      const candidate = codexSessionCandidateFromUri(
        uri,
        cleanTitle(tab.label)
      );
      if (!candidate) {
        continue;
      }

      sessionsByUrl.set(uri.toString(), candidate);
    }
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const candidate = codexSessionCandidateFromUri(activeUri);
    if (candidate && !sessionsByUrl.has(activeUri.toString())) {
      sessionsByUrl.set(activeUri.toString(), candidate);
    }
  }

  return [...sessionsByUrl.values()];
}

function codexSessionCandidateFromUri(uri, label) {
  const parsed = parseCodexConversationUri(uri.toString());
  if (!parsed) {
    return undefined;
  }

  const localDetails = getLocalCodexDetailsForOpenTab(parsed);
  const localMeta = localDetails.meta;
  const lineage = localMeta ? lineageFieldsFromLocalCodexMeta(localMeta) : {};

  return {
    conversationId: parsed.conversationId,
    title: label || `Codex ${parsed.conversationId.slice(0, 8)}`,
    url: uri.toString(),
    kind: localDetails.localFilePath ? 'codex-local' : undefined,
    localFilePath: localDetails.localFilePath,
    titleSource: 'codex-tab',
    status: localDetails.status?.status,
    lastStartedAt: localDetails.status?.lastStartedAt,
    lastCompletedAt: localDetails.status?.lastCompletedAt,
    lastAbortedAt: localDetails.status?.lastAbortedAt,
    lastFailedAt: localDetails.status?.lastFailedAt,
    ...lineage
  };
}

function getLocalCodexDetailsForOpenTab(parsed) {
  if (parsed?.kind !== 'local') {
    return {};
  }

  if (!isLocalCodexFilesystemAccessAllowed()) {
    return {};
  }

  const meta = isAutoImportLocalCodexSessionsEnabled()
    ? getLocalCodexSessionMetaByConversationId(parsed.conversationId)
    : undefined;
  const localFilePath = meta?.localFilePath ||
    findLocalCodexSessionFileByConversationId(parsed.conversationId)?.path;
  if (!localFilePath) {
    return { meta };
  }

  const stat = statLocalFile(localFilePath);
  const status = stat ? readLocalCodexSessionStatus(localFilePath, stat) : {};
  return {
    meta: meta || readLocalCodexSessionMeta(localFilePath),
    localFilePath,
    status
  };
}

function discoverLocalCodexSessions(workspaceKey, options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    invalidateLocalCodexDiscoveryCache();
    return [];
  }

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

  const localMetaById = readLocalCodexSessionMetaById(sessionsDir, options);
  const sessionIndex = readLocalCodexSessionIndex(sessionsDir, options);
  const candidates = [];

  for (const meta of [...localMetaById.values()].sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    const candidate = localCodexSessionCandidateFromMeta(meta, sessionIndex, workspacePath);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  localCodexDiscoveryCache.key = cacheKey;
  localCodexDiscoveryCache.scannedAt = now;
  localCodexDiscoveryCache.candidates = candidates.map((candidate) => ({ ...candidate }));

  return candidates;
}

function discoverRecentLocalCodexSessions(workspaceKey, options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    invalidateLocalCodexRecentDiscoveryCache();
    return [];
  }

  const sessionsDir = getLocalCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) {
    invalidateLocalCodexRecentDiscoveryCache();
    return [];
  }

  const workspacePath = normalizePathForComparison(workspaceKey);
  const sessionsPath = normalizePathForComparison(sessionsDir);
  const cacheKey = `${workspacePath}\n${sessionsPath}`;
  const now = Date.now();
  if (
    !options.force &&
    localCodexRecentDiscoveryCache.key === cacheKey &&
    now - localCodexRecentDiscoveryCache.scannedAt < LOCAL_CODEX_RECENT_SCAN_MIN_INTERVAL_MS
  ) {
    return localCodexRecentDiscoveryCache.candidates.map((candidate) => ({ ...candidate }));
  }

  const sessionIndex = readLocalCodexSessionIndex(sessionsDir, options);
  const candidates = [];
  const seenIds = new Set();

  for (const file of collectRecentJsonlFiles(sessionsDir)) {
    const meta = readLocalCodexSessionMeta(file.path);
    if (!meta?.id || seenIds.has(meta.id)) {
      continue;
    }

    seenIds.add(meta.id);
    const candidate = localCodexSessionCandidateFromMeta(
      {
        ...meta,
        localFilePath: file.path,
        mtimeMs: file.mtimeMs
      },
      sessionIndex,
      workspacePath
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }

  localCodexRecentDiscoveryCache.key = cacheKey;
  localCodexRecentDiscoveryCache.scannedAt = now;
  localCodexRecentDiscoveryCache.candidates = candidates.map((candidate) => ({ ...candidate }));

  return candidates;
}

function localCodexSessionCandidateFromMeta(meta, sessionIndex, workspacePath) {
  if (!meta || !meta.id || !meta.cwd || !meta.hasUserMessage) {
    return undefined;
  }

  if (normalizePathForComparison(meta.cwd) !== workspacePath) {
    return undefined;
  }

  const createdAt = dateStringOrUndefined(meta.timestamp) || new Date(meta.mtimeMs).toISOString();
  const indexEntry = sessionIndex.get(meta.id);
  const status = readLocalCodexSessionStatus(meta.localFilePath);
  const updatedAt = latestDateString([
    dateStringOrUndefined(indexEntry?.updatedAt),
    status.lastActivityAt,
    new Date(meta.mtimeMs).toISOString()
  ]);

  return {
    id: meta.id,
    conversationId: meta.id,
    title: titleFromLocalCodexSession(meta, indexEntry),
    url: `${CODEX_SCHEME}://${CODEX_AUTHORITY}/local/${meta.id}`,
    kind: 'codex-local',
    titleSource: titleSourceFromLocalCodexSession(meta, indexEntry),
    createdAt,
    updatedAt,
    localFilePath: meta.localFilePath,
    ...lineageFieldsFromLocalCodexMeta(meta),
    status: status.status,
    lastStartedAt: status.lastStartedAt,
    lastCompletedAt: status.lastCompletedAt,
    lastAbortedAt: status.lastAbortedAt,
    lastFailedAt: status.lastFailedAt
  };
}

function invalidateLocalCodexDiscoveryCache() {
  localCodexDiscoveryCache.key = undefined;
  localCodexDiscoveryCache.scannedAt = 0;
  localCodexDiscoveryCache.candidates = [];
  invalidateLocalCodexRecentDiscoveryCache();
  invalidateLocalCodexSessionMetaCache();
}

function invalidateLocalCodexRecentDiscoveryCache() {
  localCodexRecentDiscoveryCache.key = undefined;
  localCodexRecentDiscoveryCache.scannedAt = 0;
  localCodexRecentDiscoveryCache.candidates = [];
}

function invalidateLocalCodexSessionMetaCache() {
  localCodexSessionMetaCache.key = undefined;
  localCodexSessionMetaCache.scannedAt = 0;
  localCodexSessionMetaCache.byId = new Map();
  localCodexTargetedFileCache.clear();
}

function readLocalCodexSessionIndex(sessionsDir, options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return new Map();
  }

  const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
  const index = new Map();
  const text = readLocalCodexSessionIndexText(indexPath, options);
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

function readLocalCodexSessionIndexText(indexPath, options = {}) {
  const prefix = readFilePrefix(indexPath, LOCAL_CODEX_SESSION_INDEX_PREFIX_BYTES);
  if (!options.force) {
    return prefix;
  }

  const suffix = readFileSuffix(indexPath, LOCAL_CODEX_SESSION_INDEX_FORCE_SUFFIX_BYTES);
  if (!prefix) {
    return suffix;
  }
  if (!suffix || suffix === prefix) {
    return prefix;
  }

  return `${prefix}\n${suffix}`;
}

function collectJsonlFiles(rootDir) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return [];
  }

  const files = [];
  const pending = [rootDir];
  let directoriesScanned = 0;
  let jsonlFilesScanned = 0;

  while (
    pending.length > 0 &&
    directoriesScanned < LOCAL_CODEX_SCAN_MAX_DIRECTORIES &&
    jsonlFilesScanned < LOCAL_CODEX_SCAN_MAX_JSONL_FILES
  ) {
    const dir = pending.pop();
    directoriesScanned += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (directoriesScanned + pending.length < LOCAL_CODEX_SCAN_MAX_DIRECTORIES) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      jsonlFilesScanned += 1;
      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while Codex is rotating session logs.
      }

      if (jsonlFilesScanned >= LOCAL_CODEX_SCAN_MAX_JSONL_FILES) {
        break;
      }
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function collectRecentJsonlFiles(sessionsDir) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return [];
  }

  const files = [];
  const seenFiles = new Set();
  for (const dir of recentLocalCodexSessionDirs(sessionsDir, LOCAL_CODEX_RECENT_IMPORT_DAYS)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .sort((left, right) => right.name.localeCompare(left.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      const normalized = normalizePathForComparison(filePath);
      if (seenFiles.has(normalized)) {
        continue;
      }

      seenFiles.add(normalized);
      const stat = statLocalFile(filePath);
      if (!stat) {
        continue;
      }

      files.push({ path: filePath, mtimeMs: stat.mtimeMs });
      if (files.length >= LOCAL_CODEX_RECENT_IMPORT_MAX_JSONL_FILES) {
        return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
      }
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readLocalCodexSessionMetaById(sessionsDir = getLocalCodexSessionsDir(), options = {}) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    invalidateLocalCodexSessionMetaCache();
    return new Map();
  }

  if (!sessionsDir || !fs.existsSync(sessionsDir)) {
    invalidateLocalCodexSessionMetaCache();
    return new Map();
  }

  const sessionsPath = normalizePathForComparison(sessionsDir);
  const now = Date.now();
  if (
    !options.force &&
    localCodexSessionMetaCache.key === sessionsPath &&
    now - localCodexSessionMetaCache.scannedAt < LOCAL_CODEX_SCAN_MIN_INTERVAL_MS
  ) {
    return localCodexSessionMetaCache.byId;
  }

  const byId = new Map();
  for (const file of collectJsonlFiles(sessionsDir)) {
    const meta = readLocalCodexSessionMeta(file.path);
    if (!meta?.id || byId.has(meta.id)) {
      continue;
    }

    byId.set(meta.id, {
      ...meta,
      localFilePath: file.path,
      mtimeMs: file.mtimeMs
    });
  }

  localCodexSessionMetaCache.key = sessionsPath;
  localCodexSessionMetaCache.scannedAt = now;
  localCodexSessionMetaCache.byId = byId;
  return byId;
}

function getLocalCodexSessionMetaByConversationId(conversationId) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return undefined;
  }

  const id = stringOrUndefined(conversationId);
  if (!id) {
    return undefined;
  }

  const sessionsDir = getLocalCodexSessionsDir();
  let metaById = readLocalCodexSessionMetaById(sessionsDir);
  let meta = metaById.get(id);
  if (!meta || !meta.firstUserMessage) {
    metaById = readLocalCodexSessionMetaById(sessionsDir, { force: true });
    meta = metaById.get(id);
  }

  return meta;
}

function findLocalCodexSessionFileByConversationId(conversationId) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return undefined;
  }

  const id = stringOrUndefined(conversationId);
  const sessionsDir = getLocalCodexSessionsDir();
  if (!id || !sessionsDir || !fs.existsSync(sessionsDir)) {
    return undefined;
  }

  const cacheKey = `${normalizePathForComparison(sessionsDir)}\n${id}`;
  const now = Date.now();
  const cached = localCodexTargetedFileCache.get(cacheKey);
  if (cached && now - cached.scannedAt < LOCAL_CODEX_SCAN_MIN_INTERVAL_MS) {
    if (!cached.path) {
      return undefined;
    }

    const stat = statLocalFile(cached.path);
    if (stat) {
      return { path: cached.path, mtimeMs: stat.mtimeMs };
    }
  }

  const found = findLocalCodexSessionFileInBoundedDateDirs(sessionsDir, id);
  localCodexTargetedFileCache.set(cacheKey, {
    path: found?.path,
    scannedAt: now
  });
  return found;
}

function findLocalCodexSessionFileInBoundedDateDirs(sessionsDir, id) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return undefined;
  }

  for (const dir of recentLocalCodexSessionDirs(sessionsDir, LOCAL_CODEX_TARGETED_LOOKUP_DAYS)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(id)) {
        continue;
      }

      const filePath = path.join(dir, entry.name);
      const stat = statLocalFile(filePath);
      if (!stat) {
        continue;
      }

      const meta = readLocalCodexSessionMeta(filePath);
      if (meta?.id !== id) {
        continue;
      }

      return { path: filePath, mtimeMs: stat.mtimeMs };
    }
  }

  return undefined;
}

function recentLocalCodexSessionDirs(sessionsDir, days) {
  const dirs = [sessionsDir];
  const seen = new Set(dirs.map((dir) => normalizePathForComparison(dir)));
  const addDir = (dir) => {
    const normalized = normalizePathForComparison(dir);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      dirs.push(dir);
    }
  };

  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    addDir(path.join(sessionsDir, year, month, day));

    const utcYear = String(date.getUTCFullYear());
    const utcMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
    const utcDay = String(date.getUTCDate()).padStart(2, '0');
    addDir(path.join(sessionsDir, utcYear, utcMonth, utcDay));
  }

  return dirs;
}

function readLocalCodexSessionMeta(filePath) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return undefined;
  }

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
      threadSource: firstString(record.payload.thread_source, record.payload.threadSource),
      ...extractLocalCodexLineageMetadata(record.payload),
      hasUserMessage,
      firstUserMessage
    };

    if (hasUserMessage) {
      return meta;
    }
  }

  return meta ? { ...meta, hasUserMessage, firstUserMessage } : undefined;
}

function extractLocalCodexLineageMetadata(payload) {
  const source = payload?.source;
  const threadSpawn = firstObject(
    source?.subagent?.thread_spawn,
    source?.subagent?.threadSpawn,
    source?.thread_spawn,
    source?.threadSpawn,
    payload?.subagent?.thread_spawn,
    payload?.subagent?.threadSpawn,
    payload?.thread_spawn,
    payload?.threadSpawn,
    payload
  );

  const roleSource = firstObject(
    source?.subagent,
    source?.thread_spawn,
    source?.threadSpawn,
    payload?.subagent,
    payload?.thread_spawn,
    payload?.threadSpawn,
    payload
  );

  return {
    parentThreadId: firstString(
      threadSpawn?.parent_thread_id,
      threadSpawn?.parentThreadId,
      threadSpawn?.parent_id,
      threadSpawn?.parentId,
      source?.parent_thread_id,
      source?.parentThreadId,
      payload?.parent_thread_id,
      payload?.parentThreadId
    ),
    threadDepth: firstNumber(
      threadSpawn?.depth,
      source?.depth,
      payload?.depth,
      payload?.thread_depth,
      payload?.threadDepth,
      threadSpawn?.THREAD_DEPTH,
      source?.THREAD_DEPTH,
      payload?.THREAD_DEPTH
    ),
    agentRole: firstString(
      threadSpawn?.agent_role,
      threadSpawn?.agentRole,
      threadSpawn?.role,
      threadSpawn?.ROLE,
      roleSource?.agent_role,
      roleSource?.agentRole,
      roleSource?.role,
      roleSource?.ROLE,
      source?.agent_role,
      source?.agentRole,
      source?.role,
      source?.ROLE,
      payload?.agent_role,
      payload?.agentRole,
      payload?.role,
      payload?.ROLE
    ),
    agentNickname: firstString(
      threadSpawn?.agent_nickname,
      threadSpawn?.agentNickname,
      threadSpawn?.agent_label,
      threadSpawn?.agentLabel,
      threadSpawn?.AGENT_LABEL,
      threadSpawn?.nickname,
      roleSource?.agent_nickname,
      roleSource?.agentNickname,
      roleSource?.agent_label,
      roleSource?.agentLabel,
      roleSource?.AGENT_LABEL,
      roleSource?.nickname,
      source?.agent_nickname,
      source?.agentNickname,
      source?.agent_label,
      source?.agentLabel,
      source?.AGENT_LABEL,
      source?.nickname,
      payload?.agent_nickname,
      payload?.agentNickname,
      payload?.agent_label,
      payload?.agentLabel,
      payload?.AGENT_LABEL,
      payload?.nickname
    ),
    agentKind: firstString(
      threadSpawn?.agent_kind,
      threadSpawn?.agentKind,
      threadSpawn?.AGENT_KIND,
      roleSource?.agent_kind,
      roleSource?.agentKind,
      roleSource?.AGENT_KIND,
      source?.agent_kind,
      source?.agentKind,
      source?.AGENT_KIND,
      payload?.agent_kind,
      payload?.agentKind,
      payload?.AGENT_KIND
    ),
    noFurtherDelegation: firstBoolean(
      threadSpawn?.no_further_delegation,
      threadSpawn?.noFurtherDelegation,
      threadSpawn?.NO_FURTHER_DELEGATION,
      roleSource?.no_further_delegation,
      roleSource?.noFurtherDelegation,
      roleSource?.NO_FURTHER_DELEGATION,
      source?.no_further_delegation,
      source?.noFurtherDelegation,
      source?.NO_FURTHER_DELEGATION,
      payload?.no_further_delegation,
      payload?.noFurtherDelegation,
      payload?.NO_FURTHER_DELEGATION
    ),
    isDelegatedLocalCodexSession: hasDelegatedLocalCodexSourceMetadata(payload) || undefined
  };
}

function lineageFieldsFromLocalCodexMeta(meta) {
  const lineageMeta = localCodexLineageMetadataWithPromptPrefix(meta);
  return {
    parentThreadId: lineageMeta.parentThreadId,
    threadDepth: lineageMeta.threadDepth,
    agentRole: lineageMeta.agentRole,
    agentNickname: lineageMeta.agentNickname,
    agentKind: lineageMeta.agentKind,
    noFurtherDelegation: lineageMeta.noFurtherDelegation,
    isDelegatedLocalCodexSession: lineageMeta.isDelegatedLocalCodexSession,
    lineageRole: classifyLocalCodexLineageRole(lineageMeta)
  };
}

function localCodexLineageMetadataWithPromptPrefix(meta) {
  const promptMetadata = parseMacoLineagePrefix(meta?.firstUserMessage);
  return {
    ...meta,
    parentThreadId: meta?.parentThreadId ?? promptMetadata.parentThreadId,
    threadDepth: meta?.threadDepth ?? promptMetadata.threadDepth,
    agentRole: meta?.agentRole ?? promptMetadata.agentRole,
    agentNickname: meta?.agentNickname ?? promptMetadata.agentNickname,
    agentKind: meta?.agentKind ?? promptMetadata.agentKind,
    noFurtherDelegation: meta?.noFurtherDelegation ?? promptMetadata.noFurtherDelegation
  };
}

function classifyLocalCodexLineageRole(meta) {
  const macoRole = classifyMacoLineageMetadata(meta);
  if (macoRole) {
    return macoRole;
  }

  const promptRole = classifyPromptDeclaredLineageRole(meta?.firstUserMessage);
  if (promptRole) {
    return promptRole;
  }

  const classifiedRole = classifyExplicitStructuredLineageRole(meta) ||
    classifyStructuredAuxiliaryLineageRole(meta);
  if (classifiedRole) {
    return classifiedRole;
  }

  if (hasAuxiliaryLineageDefaultOtherSignal(meta)) {
    return LINEAGE_CATEGORY_OTHER;
  }

  return LINEAGE_CATEGORY_O2;
}

function classifyExplicitStructuredLineageRole(meta) {
  const macoRole = classifyMacoLineageMetadata(meta);
  if (macoRole) {
    return macoRole;
  }

  const threadSourceText = normalizeLineageSignalText([meta?.threadSource]);

  if (hasOtherLineageSignal(threadSourceText)) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (hasO2LineageSignal(threadSourceText)) {
    return LINEAGE_CATEGORY_O2;
  }

  if (hasO1LineageSignal(threadSourceText)) {
    return LINEAGE_CATEGORY_O1;
  }

  if (hasDelegatedLocalCodexSessionSignal(meta)) {
    return LINEAGE_CATEGORY_OTHER;
  }

  return undefined;
}

function classifyStructuredAuxiliaryLineageRole(meta) {
  const sourceText = lineageSignalTextFromStructuredSource(meta?.source);

  if (hasOtherLineageSignal(sourceText)) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (hasO2LineageSignal(sourceText)) {
    return LINEAGE_CATEGORY_O2;
  }

  if (hasO1LineageSignal(sourceText)) {
    return LINEAGE_CATEGORY_O1;
  }

  return undefined;
}

function classifyPromptDeclaredLineageRole(value) {
  const text = stringOrUndefined(value);
  if (!text) {
    return undefined;
  }

  const macoPrefix = parseMacoLineagePrefix(text);
  const macoRole = classifyMacoLineageMetadata(macoPrefix);
  if (macoRole) {
    return macoRole;
  }

  if (LOCAL_CODEX_OTHER_PROMPT_MARKERS.some((marker) => text.includes(marker))) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (LOCAL_CODEX_O1_PROMPT_MARKERS.some((marker) => text.includes(marker))) {
    return LINEAGE_CATEGORY_O1;
  }

  return undefined;
}

function parseMacoLineagePrefix(value) {
  const text = stringOrUndefined(value);
  if (!text) {
    return {};
  }

  const lines = text.split(/\r?\n/);
  const prefixEntries = lines
    .slice(0, MACO_LINEAGE_PREFIX_LINES)
    .map(parseMacoLineageMetadataEntry)
    .filter(Boolean);
  const prefixMetadata = macoLineageMetadataFromEntries(prefixEntries);
  if (classifyMacoLineageMetadata(prefixMetadata)) {
    return prefixMetadata;
  }

  return findEarlyMacoLineageMetadataBlock(lines.slice(0, MACO_LINEAGE_EARLY_SCAN_LINES)) ||
    prefixMetadata;
}

function findEarlyMacoLineageMetadataBlock(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const entries = [];
    const keys = new Set();

    for (
      let cursor = index;
      cursor < lines.length && cursor < index + MACO_LINEAGE_BLOCK_MAX_LINES;
      cursor += 1
    ) {
      const entry = parseMacoLineageMetadataEntry(lines[cursor]);
      if (!entry) {
        break;
      }

      entries.push(entry);
      keys.add(entry.key);
    }

    if (isMacoLineageMetadataBlock(keys)) {
      return macoLineageMetadataFromEntries(entries);
    }
  }

  return undefined;
}

function isMacoLineageMetadataBlock(keys) {
  return keys.size >= 2 && (keys.has('ROLE') || keys.has('AGENT_KIND'));
}

function parseMacoLineageMetadataEntry(line) {
  const match = MACO_LINEAGE_METADATA_PATTERN.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    key: match[1].toUpperCase(),
    value: match[2]
  };
}

function macoLineageMetadataFromEntries(entries) {
  const metadata = {};
  for (const entry of entries) {
    const key = entry.key;
    const valueText = entry.value;

    if (key === 'ROLE') {
      metadata.agentRole = stringOrUndefined(valueText);
    } else if (key === 'AGENT_KIND') {
      metadata.agentKind = stringOrUndefined(valueText);
    } else if (key === 'AGENT_LABEL') {
      metadata.agentNickname = stringOrUndefined(valueText);
    } else if (key === 'PARENT_THREAD_ID') {
      metadata.parentThreadId = normalizedParentThreadIdFromPrefix(valueText);
    } else if (key === 'THREAD_DEPTH') {
      metadata.threadDepth = firstNumber(valueText);
    } else if (key === 'NO_FURTHER_DELEGATION') {
      metadata.noFurtherDelegation = firstBoolean(valueText);
    }
  }

  return metadata;
}

function normalizedParentThreadIdFromPrefix(value) {
  const text = stringOrUndefined(value);
  if (!text || /^none|null|undefined$/i.test(text)) {
    return undefined;
  }
  return text;
}

function classifyMacoLineageMetadata(meta) {
  const role = classifyMacoAgentRole(meta?.agentRole);
  if (role) {
    return role;
  }

  const agentKind = normalizeLineageSignalText([meta?.agentKind]);
  const threadDepth = typeof meta?.threadDepth === 'number' && Number.isFinite(meta.threadDepth)
    ? meta.threadDepth
    : firstNumber(meta?.threadDepth);
  const noFurtherDelegation = booleanOrUndefined(meta?.noFurtherDelegation);

  if (hasOtherAgentKind(agentKind) || noFurtherDelegation === true || threadDepth >= 2) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (/\borchestrator\b/.test(agentKind)) {
    if (threadDepth === 0) {
      return LINEAGE_CATEGORY_O2;
    }
    if (threadDepth === 1) {
      return LINEAGE_CATEGORY_O1;
    }
  }

  return undefined;
}

function classifyMacoAgentRole(value) {
  const roleText = normalizeLineageSignalText([value]);
  if (!roleText) {
    return undefined;
  }

  const canonical = roleText.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (canonical === 'o2_top_supervisor') {
    return LINEAGE_CATEGORY_O2;
  }
  if (canonical === 'o1_child_orchestrator') {
    return LINEAGE_CATEGORY_O1;
  }
  if (
    canonical === 'terminal_worker' ||
    canonical === 'researcher' ||
    canonical === 'review_auditor' ||
    canonical === 'expert_coder' ||
    canonical === 'expert_reviewer' ||
    canonical === 'expert_explorer' ||
    canonical === 'expert_researcher'
  ) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (hasOtherLineageSignal(roleText)) {
    return LINEAGE_CATEGORY_OTHER;
  }

  if (hasO2LineageSignal(roleText)) {
    return LINEAGE_CATEGORY_O2;
  }

  if (hasO1LineageSignal(roleText)) {
    return LINEAGE_CATEGORY_O1;
  }

  return undefined;
}

function normalizeLineageSignalText(values) {
  return values.filter(Boolean).join(' ').toLowerCase();
}

function hasO2LineageSignal(text) {
  return Boolean(
    text &&
    (
      /\bo2\b/.test(text) ||
      /\bo2(?:agent|orchestrator|supervisor|coordinator)\b/.test(text) ||
      /top[\s_-]*supervisor|topsupervisor/.test(text)
    )
  );
}

function hasO1LineageSignal(text) {
  return Boolean(
    text &&
    (
      /\bo1\b/.test(text) ||
      /\bo1(?:agent|orchestrator|supervisor|coordinator)\b/.test(text) ||
      /child[\s_-]*orchestrator/.test(text)
    )
  );
}

function hasOtherLineageSignal(text) {
  return Boolean(
    text &&
    /worker|researcher|explorer|auditor|terminal|expert[\s_-]*(?:coder|reviewer|explorer|researcher)/.test(text)
  );
}

function hasOtherAgentKind(text) {
  return Boolean(text && /\b(?:worker|researcher|auditor)\b/.test(text));
}

function hasAuxiliaryLineageDefaultOtherSignal(meta) {
  const threadDepth = typeof meta?.threadDepth === 'number' && Number.isFinite(meta.threadDepth)
    ? meta.threadDepth
    : firstNumber(meta?.threadDepth);
  return Boolean(
    normalizeThreadId(meta?.parentThreadId) ||
    threadDepth > 0 ||
    booleanOrUndefined(meta?.noFurtherDelegation) === true ||
    hasOtherAgentKind(normalizeLineageSignalText([meta?.agentKind]))
  );
}

function hasDelegatedLocalCodexSessionSignal(meta) {
  return booleanOrUndefined(meta?.isDelegatedLocalCodexSession) === true ||
    hasDelegatedLocalCodexSourceMetadata(meta);
}

function hasDelegatedLocalCodexSourceMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return false;
  }

  if (isSubagentThreadSource(meta.threadSource) || isSubagentThreadSource(meta.thread_source)) {
    return true;
  }

  if (
    hasStructuredDelegationMarker(meta.subagent) ||
    hasStructuredDelegationMarker(meta.thread_spawn) ||
    hasStructuredDelegationMarker(meta.threadSpawn)
  ) {
    return true;
  }

  const source = meta.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    if (
      isSubagentThreadSource(source.threadSource) ||
      isSubagentThreadSource(source.thread_source) ||
      hasStructuredDelegationMarker(source.subagent) ||
      hasStructuredDelegationMarker(source.thread_spawn) ||
      hasStructuredDelegationMarker(source.threadSpawn)
    ) {
      return true;
    }
  }

  const payload = meta.payload;
  if (payload && payload !== meta && typeof payload === 'object' && !Array.isArray(payload)) {
    return hasDelegatedLocalCodexSourceMetadata(payload);
  }

  return false;
}

function isSubagentThreadSource(value) {
  const text = stringOrUndefined(value);
  return Boolean(text && text.replace(/[^a-z0-9]+/gi, '').toLowerCase() === 'subagent');
}

function hasStructuredDelegationMarker(value) {
  if (value === undefined || value === null) {
    return false;
  }

  const booleanValue = booleanOrUndefined(value);
  if (booleanValue !== undefined) {
    return booleanValue;
  }

  if (typeof value === 'string') {
    return !/^(?:none|null|undefined)$/i.test(value.trim());
  }

  return true;
}

function lineageSignalTextFromStructuredSource(source) {
  if (typeof source === 'string') {
    return normalizeLineageSignalText([source]);
  }

  return normalizeLineageSignalText(lineageSignalValuesFromStructuredSource(source));
}

function lineageSignalValuesFromStructuredSource(value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => lineageSignalValuesFromStructuredSource(item, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const values = [];
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:agent_?label|agent_?nickname|nickname|label|display_?name|title)$/i.test(key)) {
      continue;
    }
    values.push(key);
    values.push(...lineageSignalValuesFromStructuredSource(child, depth + 1));
  }
  return values;
}

function getSessionLineageRole(session) {
  const classifiedRole = classifyExplicitStructuredLineageRole(session) ||
    classifyStructuredAuxiliaryLineageRole(session);
  if (classifiedRole) {
    return classifiedRole;
  }

  const role = normalizeLineageRole(session?.lineageRole);
  if (role) {
    if (role === LINEAGE_CATEGORY_O2 && hasAuxiliaryLineageDefaultOtherSignal(session)) {
      return LINEAGE_CATEGORY_OTHER;
    }
    return role;
  }

  if (isLocalCodexSession(session) && !hasAuxiliaryLineageDefaultOtherSignal(session)) {
    return LINEAGE_CATEGORY_O2;
  }

  return LINEAGE_CATEGORY_OTHER;
}

function normalizeLineageRole(value) {
  const normalized = stringOrUndefined(value)?.toLowerCase();
  if (
    normalized === LINEAGE_CATEGORY_O2 ||
    normalized === LINEAGE_CATEGORY_O1 ||
    normalized === LINEAGE_CATEGORY_OTHER
  ) {
    return normalized;
  }
  return undefined;
}

function labelForLineageCategory(value) {
  switch (value) {
    case LINEAGE_CATEGORY_ALL:
      return 'Full lineage';
    case LINEAGE_CATEGORY_O2:
      return 'O2 roots/top supervisors';
    case LINEAGE_CATEGORY_O1:
      return 'O1 MACO child orchestrators';
    case LINEAGE_CATEGORY_OTHER:
      return 'Spawned/delegated agents';
    default:
      return 'Spawned/delegated agents';
  }
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values) {
  for (const value of values) {
    const text = stringOrUndefined(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstBoolean(...values) {
  for (const value of values) {
    const parsed = booleanOrUndefined(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function booleanOrUndefined(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
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

function readLocalCodexSessionStatus(filePath, fileStat) {
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return {};
  }

  const text = readFileSuffix(filePath, LOCAL_CODEX_STATUS_SUFFIX_BYTES);
  if (!text) {
    return {};
  }

  const stat = fileStat || statLocalFile(filePath);
  if (!stat) {
    return {};
  }

  let lastStartedAt;
  let lastCompletedAt;
  let lastAbortedAt;
  let lastFailedAt;
  let lastActivityAt;
  let lastStartedOrder = -1;
  let lastParsedRecordOrder = -1;
  let lastTurnStatusEvent;

  const lines = text.split(/\r?\n/);
  for (let lineOrder = 0; lineOrder < lines.length; lineOrder += 1) {
    const line = lines[lineOrder];
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    lastParsedRecordOrder = lineOrder;
    const timestamp = dateStringOrUndefined(record.timestamp);
    if (timestamp) {
      lastActivityAt = latestDateString([lastActivityAt, timestamp]);
    }

    if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object') {
      continue;
    }

    const completedAt = dateStringOrUndefined(record.payload.completed_at);
    if (completedAt) {
      lastActivityAt = latestDateString([lastActivityAt, completedAt]);
    }

    if (record.payload.type === 'task_started') {
      if (timestamp) {
        lastStartedAt = timestamp;
      }
      lastStartedOrder = lineOrder;
      lastTurnStatusEvent = { type: 'started', at: timestamp, order: lineOrder };
    } else if (record.payload.type === 'task_complete') {
      const terminalAt = completedAt || timestamp;
      if (terminalAt) {
        lastCompletedAt = terminalAt;
      }
      if (lineOrder >= lastStartedOrder) {
        lastTurnStatusEvent = { type: 'completed', at: terminalAt, order: lineOrder };
      }
    } else if (record.payload.type === 'turn_aborted') {
      const terminalAt = completedAt || timestamp;
      if (terminalAt) {
        lastAbortedAt = terminalAt;
      }
      if (lineOrder >= lastStartedOrder) {
        lastTurnStatusEvent = { type: 'aborted', at: terminalAt, order: lineOrder };
      }
    } else if (record.payload.type === 'error') {
      if (timestamp) {
        lastFailedAt = timestamp;
      }
      if (lineOrder >= lastStartedOrder) {
        lastTurnStatusEvent = { type: 'failed', at: timestamp, order: lineOrder };
      }
    }
  }

  let status;
  const lastTerminalStatus = terminalLocalCodexStatusFromTurnEvent(lastTurnStatusEvent);
  const activeAt = latestLocalCodexActivityTime(stat, lastStartedAt, lastActivityAt);
  if (lastTerminalStatus && isTurnStatusSemanticallyOlderThanLatestStart(lastTurnStatusEvent, lastStartedAt)) {
    status = activeAt ? activeLocalCodexStatusFromTime(activeAt) : undefined;
    if (activeAt) {
      lastActivityAt = latestDateString([lastActivityAt, new Date(activeAt).toISOString()]);
    }
  } else if (
    lastTurnStatusEvent?.type === 'failed' &&
    hasActiveWorkAfterErrorTurnStatus(lastTurnStatusEvent, lastParsedRecordOrder, lastActivityAt, stat)
  ) {
    status = 'running';
    if (activeAt) {
      lastActivityAt = latestDateString([lastActivityAt, new Date(activeAt).toISOString()]);
    }
  } else if (lastTerminalStatus) {
    status = lastTerminalStatus;
  } else if (lastStartedAt) {
    status = activeAt ? activeLocalCodexStatusFromTime(activeAt) : undefined;
    if (activeAt) {
      lastActivityAt = latestDateString([lastActivityAt, new Date(activeAt).toISOString()]);
    }
  } else if (lastCompletedAt) {
    status = 'completed';
  } else if (lastAbortedAt) {
    status = 'aborted';
  } else if (lastFailedAt) {
    status = 'failed';
  }

  return {
    status,
    lastStartedAt,
    lastCompletedAt,
    lastAbortedAt,
    lastFailedAt,
    lastActivityAt
  };
}

function terminalLocalCodexStatusFromTurnEvent(event) {
  if (event?.type === 'completed') {
    return 'completed';
  }
  if (event?.type === 'aborted') {
    return 'aborted';
  }
  if (event?.type === 'failed') {
    return 'failed';
  }
  return undefined;
}

function isTurnStatusSemanticallyOlderThanLatestStart(event, lastStartedAt) {
  const eventTime = Date.parse(event?.at || '');
  const startedTime = Date.parse(lastStartedAt || '');
  return Boolean(
    Number.isFinite(eventTime) &&
    Number.isFinite(startedTime) &&
    eventTime < startedTime
  );
}

function hasActiveWorkAfterErrorTurnStatus(event, lastParsedRecordOrder, lastActivityAt, stat) {
  if (!event) {
    return false;
  }

  const eventTime = Date.parse(event.at || '');
  const lastActivityTime = Date.parse(lastActivityAt || '');
  const fileMtime = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : undefined;

  const hasLaterRecord = lastParsedRecordOrder > event.order ||
    (
      Number.isFinite(eventTime) &&
      Number.isFinite(lastActivityTime) &&
      lastActivityTime > eventTime
    );
  const hasNewerFileWrite = Number.isFinite(eventTime) &&
    fileMtime &&
    fileMtime - eventTime > LOCAL_CODEX_TERMINAL_MTIME_GRACE_MS;
  const hasRecentFileWrite = fileMtime &&
    Date.now() - fileMtime <= LOCAL_CODEX_RUNNING_STALE_MS;

  return Boolean(
    (hasLaterRecord || hasNewerFileWrite) &&
    hasRecentFileWrite
  );
}

function latestLocalCodexActivityTime(stat, ...dateStrings) {
  let latest = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : undefined;
  for (const value of dateStrings) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) {
      continue;
    }
    if (latest === undefined || time > latest) {
      latest = time;
    }
  }
  return latest;
}

function activeLocalCodexStatusFromTime(activeAt) {
  return Date.now() - activeAt > LOCAL_CODEX_RUNNING_STALE_MS ? 'stale' : 'running';
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
    uri = typeof value === 'string' ? vscode.Uri.parse(value.trim()) : value;
  } catch {
    return undefined;
  }

  if (!uri || uri.scheme !== CODEX_SCHEME || uri.authority !== CODEX_AUTHORITY) {
    return undefined;
  }

  if (uri.query || uri.fragment) {
    return undefined;
  }

  const match = /^\/(local|remote)\/([^/]+)$/.exec(uri.path);
  if (!match) {
    return undefined;
  }

  const conversationId = match[2];
  if (!CODEX_CONVERSATION_ID_PATTERN.test(conversationId)) {
    return undefined;
  }

  return {
    kind: match[1],
    conversationId
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
  if (!isLocalCodexFilesystemAccessAllowed()) {
    return false;
  }

  return vscode.workspace
    .getConfiguration('projectChatSessions')
    .get('autoImportLocalCodexSessions', false);
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
