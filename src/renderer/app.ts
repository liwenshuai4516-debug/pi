import { describeInChinese } from '../shared/descriptions-zh.js';
import { bindModelSelection } from './features/models/selection.js';
import {
  bindWorkspacePermission,
  renderWorkspacePermission,
} from './features/workspace/permissions.js';
import { renderThinking } from './features/models/thinking.js';
import { bindComposerKeyboard } from './features/composer/keyboard.js';
import { bindExtensionShortcuts } from './features/composer/extension-shortcuts.js';
import { bindSlashMenu } from './features/composer/slash-menu.js';
import { bindModelSettings } from './features/models/settings.js';
import { renderModelChoices } from './features/models/choices.js';
import { bindSessionManagement } from './features/sessions/management.js';
import { bindPlugins } from './features/plugins/panel.js';
import { bindSessionSidebar } from './features/sessions/sidebar.js';
import { renderSessionList } from './features/sessions/list.js';
import { renderMessages } from './features/chat/messages.js';
import { el, escape, nameOf } from './shared/dom.js';
import type {
  FileAttachment,
  ImageAttachment,
  ModelChoice,
  SessionSummary,
  SessionView,
} from '../shared/types.js';
const api = window.agentClient;
const { focusSearch } = bindSessionSidebar();
const prompt = el<HTMLTextAreaElement>('prompt');
const send = el<HTMLButtonElement>('send');
const messages = el<HTMLDivElement>('messages');
const modelSelect = el<HTMLSelectElement>('model');
const thinking = el<HTMLSelectElement>('thinking');
let noticeTimer: ReturnType<typeof setTimeout>;
function notice(text: string): void {
  el('session-notice').textContent = text;
  el('session-notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el('session-notice').hidden = true;
  }, 6000);
}
const drafts = new Map<
  string,
  { text: string; images: ImageAttachment[]; files: FileAttachment[] }
>();
let active: SessionView | null = null;
let cwd: string | null = null;
let defaultCwd: string | null = null;
let models: ModelChoice[] = [];
let sessions: SessionSummary[] = [];
let images: ImageAttachment[] = [],
  files: FileAttachment[] = [];
let navigating = false;
let configuring = false;
let sendingIds = new Set<string>();
function showError(error: unknown): void {
  const banner = el('error-banner');
  banner.textContent = error instanceof Error ? error.message : String(error);
  banner.hidden = false;
}
async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    showError(error);
  }
}
function storeDraft(): void {
  if (active) drafts.set(active.id, { text: prompt.value, images: [...images], files: [...files] });
  api.reportDraft(
    [...drafts.values()].some((draft) =>
      Boolean(draft.text.trim() || draft.images.length || draft.files.length),
    ),
  );
}
function restoreDraft(): void {
  const draft = active ? drafts.get(active.id) : null;
  prompt.value = draft?.text ?? '';
  images = draft?.images ?? [];
  files = draft?.files ?? [];
  renderAttachments();
  storeDraft();
}
function renderSessions(): void {
  renderSessionList(sessions, active?.id);
}
function renderModels(): void {
  renderModelChoices(models, active);
}
function renderAttachments(): void {
  const all = [...images, ...files];
  el('attachments').innerHTML = all
    .map(
      (item, i) =>
        `<span class="attachment-chip">${escape(item.name)}<button data-remove-attachment="${i}" aria-label="移除 ${escape(item.name)}">×</button></span>`,
    )
    .join('');
}
function updateControls(): void {
  const busy = active?.running || Boolean(active && sendingIds.has(active.id));
  renderWorkspacePermission(active, navigating || configuring || Boolean(busy));
  prompt.disabled = !active || navigating || configuring;
  el<HTMLButtonElement>('attach').disabled = !active || navigating || configuring || Boolean(busy);
  modelSelect.disabled = !active || navigating || configuring || Boolean(busy);
  thinking.disabled =
    !active || navigating || configuring || Boolean(busy) || active.thinkingLevels.length <= 1;
  send.disabled =
    !active ||
    navigating ||
    configuring ||
    (!busy && (!active.model || !(prompt.value.trim() || images.length || files.length)));
  send.classList.toggle('running', Boolean(busy));
  send.setAttribute('aria-label', busy ? '停止执行' : '发送任务');
  send.title = busy ? '停止执行' : '发送任务';
  send.innerHTML = busy
    ? '<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="2" width="10" height="10" rx="2"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V4m-6 6 6-6 6 6"/></svg>';
  el<HTMLButtonElement>('new-session').disabled = !cwd || navigating;
  el<HTMLButtonElement>('project-picker').disabled = navigating || configuring || Boolean(busy);
  el('global-status').textContent = busy
    ? 'Agent 执行中'
    : models.length
      ? '本地工作空间'
      : '模型待配置';
  el('task-status').textContent = busy
    ? '正在执行 · 点击停止可中止任务'
    : active && !active.model
      ? '请先在模型配置中连接模型'
      : 'Enter 发送 · Shift + Enter 换行';
  slashMenu.refresh();
}
function renderView(): void {
  el('chat-title').textContent = active?.name ?? '新会话';
  const workspace = active?.cwd ?? cwd;
  const isDefaultWorkspace = workspace === defaultCwd;
  el('project-name').textContent = workspace && !isDefaultWorkspace ? nameOf(workspace) : '选择工作区';
  el('project-picker').title = workspace
    ? `${isDefaultWorkspace ? '当前使用应用默认目录' : '当前工作区'}：${workspace}；点击选择工作区`
    : '选择工作区';
  el('project-path').textContent = workspace ?? '';
  el('project-path').hidden = !workspace || isDefaultWorkspace;
  document.querySelector('.chat-panel')!.classList.toggle('empty-chat', !active?.messages.length);
  el('new-session').classList.toggle('selected', Boolean(active && !active.messages.length));
  renderThinking(active);
  const templates = active?.templates ?? [];
  el('template-list').innerHTML = templates.length
    ? templates
        .map(
          (template) =>
            `<button class="template-choice" data-template="${escape(template.name)}">/${escape(template.name)}<small>${escape(describeInChinese(template.description))}</small></button>`,
        )
        .join('')
    : '<p>尚无提示模板。Pi 已配置的提示模板会显示在这里。</p>';
  el('session-info').innerHTML = active
    ? `<dl><dt>项目目录</dt><dd>${escape(active.cwd)}</dd><dt>会话 ID</dt><dd>${escape(active.id)}</dd><dt>模型</dt><dd>${escape(active.model ? `${active.model.provider}/${active.model.id}` : '未选择')}</dd><dt>状态</dt><dd>${active.running ? '执行中' : '空闲'}</dd><dt>工具执行</dt><dd>${active.tools.length ? active.tools.map((tool) => `${escape(tool.name)} · ${tool.status === 'running' ? '执行中' : tool.status === 'done' ? '完成' : '失败'}`).join('<br>') : '本次打开后暂无工具调用'}</dd></dl>`
    : '<p>打开会话后显示详细信息。</p>';
  if (active?.error) showError(active.error);
  else el('error-banner').hidden = true;
  el('warning-banner').textContent = active?.warning ?? '';
  el('warning-banner').hidden = !active?.warning;
  renderModels();
  renderSessions();
  renderMessages(active);
  updateControls();
}
async function chooseProject(): Promise<void> {
  if (navigating || configuring || active?.running) return;
  const selected = await api.selectProject();
  if (!selected) return;
  const draft = { text: prompt.value, images: [...images], files: [...files] };
  const previousId = active?.id;
  storeDraft();
  cwd = selected;
  await newSession();
  // 将草稿转移到新工作区，避免原会话残留一份重复草稿。
  if (previousId) drafts.delete(previousId);
  prompt.value = draft.text;
  images = draft.images;
  files = draft.files;
  renderAttachments();
  storeDraft();
  updateControls();
}
async function newSession(): Promise<void> {
  if (!cwd || navigating) return;
  storeDraft();
  navigating = true;
  updateControls();
  try {
    active = await api.createSession(cwd);
    restoreDraft();
    renderView();
  } finally {
    navigating = false;
    updateControls();
  }
  prompt.focus();
}
async function openSession(id: string): Promise<void> {
  if (id === active?.id || navigating) return;
  storeDraft();
  navigating = true;
  updateControls();
  try {
    active = await api.openSession(id);
    cwd = active.cwd;
    restoreDraft();
    renderView();
    messages.scrollTop = messages.scrollHeight;
  } finally {
    navigating = false;
    updateControls();
  }
}
async function submit(): Promise<void> {
  if (!active) return;
  const id = active.id;
  if (active.running || sendingIds.has(id)) {
    await api.stop(id);
    return;
  }
  const text = prompt.value,
    sentImages = [...images],
    sentFiles = [...files];
  if (!text.trim() && !images.length && !files.length) return;
  sendingIds.add(id);
  prompt.value = '';
  images = [];
  files = [];
  renderAttachments();
  storeDraft();
  updateControls();
  try {
    await api.send(id, text, sentImages, sentFiles);
  } catch (error) {
    const current = drafts.get(id) ?? { text: '', images: [], files: [] };
    drafts.set(id, {
      text: text + (current.text ? '\n' + current.text : ''),
      images: [...sentImages, ...current.images],
      files: [...sentFiles, ...current.files],
    });
    if (active?.id === id) {
      restoreDraft();
      showError(error);
    }
  } finally {
    sendingIds.delete(id);
    updateControls();
  }
}

function applySessionView(view: SessionView): void {
  if (active?.id === view.id) {
    active = view;
    renderView();
  }
}
const slashMenu = bindSlashMenu(
  prompt,
  () => navigating || configuring || (active && sendingIds.has(active.id)) ? null : active,
  (id, prefix) => api.complete(id, prefix),
);
const setConfiguring = (pending: boolean): void => {
  configuring = pending;
  updateControls();
};
bindModelSelection(() => active, applySessionView, setConfiguring, showError);
bindWorkspacePermission(() => active, applySessionView, showError, setConfiguring);
const openSettings = bindModelSettings(
  () => active,
  (list) => {
    models = list;
    renderModels();
    updateControls();
  },
  (view) => {
    if (active?.id === view.id) {
      active = view;
      renderView();
    }
  },
);
bindPlugins(() => active, newSession);
const manageSession = bindSessionManagement({
  getSessions: () => sessions,
  isNavigating: () => navigating,
  openSession,
  notice,
  onDeleted: (id) => {
    drafts.delete(id);
    sendingIds.delete(id);
    if (active?.id === id) {
      active = null;
      restoreDraft();
      renderView();
    } else storeDraft();
  },
});
el('project-picker').addEventListener('click', () => void run(chooseProject));
el('new-session').addEventListener('click', () => void run(newSession));
el('sessions').addEventListener('click', (event) => {
  const manage = (event.target as HTMLElement).closest<HTMLElement>('[data-manage]');
  if (manage?.dataset.manage) {
    manageSession(manage.dataset.manage);
    return;
  }
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-session]');
  if (row?.dataset.session) void run(() => openSession(row.dataset.session!));
});
el('session-search').addEventListener('input', renderSessions);
el('toggle-info').addEventListener('click', () => {
  const info = el('info-panel');
  info.hidden = !info.hidden;
  el('toggle-info').setAttribute('aria-expanded', String(!info.hidden));
});
prompt.addEventListener('input', () => {
  storeDraft();
  updateControls();
});
bindComposerKeyboard(
  prompt,
  () => Boolean(active && !active.running && !sendingIds.has(active.id) && !send.disabled),
  () => void run(submit),
);
send.addEventListener('click', () => void run(submit));
el('attach').addEventListener(
  'click',
  () =>
    void run(async () => {
      const selected = await api.chooseAttachments();
      images.push(...selected.images);
      files.push(...selected.files);
      renderAttachments();
      storeDraft();
      updateControls();
    }),
);
el('attachments').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-attachment]');
  if (!button) return;
  const index = Number(button.dataset.removeAttachment);
  if (index < images.length) images.splice(index, 1);
  else files.splice(index - images.length, 1);
  renderAttachments();
  storeDraft();
  updateControls();
});
el('template-list').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-template]');
  if (!button) return;
  prompt.value = `/${button.dataset.template} ${prompt.value}`;
  el<HTMLDetailsElement>('templates').open = false;
  prompt.focus();
  storeDraft();
  updateControls();
});
document.addEventListener('click', (event) => {
  for (const detail of document.querySelectorAll<HTMLDetailsElement>('.popover[open]'))
    if (!detail.contains(event.target as Node)) detail.open = false;
});
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'n') {
    event.preventDefault();
    void run(newSession);
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    focusSearch();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    openSettings();
  }
  if (event.key === 'Escape')
    for (const detail of document.querySelectorAll<HTMLDetailsElement>('.popover[open]'))
      detail.open = false;
});
bindExtensionShortcuts(
  () => navigating || configuring ? null : active,
  (id, key) => { void run(() => api.shortcut(id, key)); },
);
api.onSession((view) => {
  if (view.id === active?.id) {
    active = view;
    renderView();
  }
});
api.onSessionsChanged((list) => {
  sessions = list;
  renderSessions();
});
renderMessages(active);
void run(async () => {
  const initial = await api.initialize();
  sessions = initial.sessions;
  models = initial.models;
  el('config-directory').textContent = `配置目录：${initial.configDirectory}`;
  defaultCwd = initial.defaultCwd;
  cwd = defaultCwd;
  await newSession();
  if (initial.modelError) showError(initial.modelError);
});
