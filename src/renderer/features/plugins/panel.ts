import type { PluginInventory, SessionView } from '../../../shared/types.js';
import { el, escape } from '../../shared/dom.js';

export function bindPlugins(getView: () => SessionView | null, activate: () => Promise<void>): void {
  const dialog = el<HTMLDialogElement>('plugins-dialog');
  const form = el<HTMLFormElement>('plugin-form');
  const status = el('plugin-status');
  const error = el('plugin-error');
  const kind = el<HTMLSelectElement>('plugin-kind');
  const source = el<HTMLInputElement>('plugin-source');
  let busy = false;
  function selectTab(skills: boolean): void {
    el('plugins-pane').hidden = skills;
    el('skills-pane').hidden = !skills;
    el('plugins-tab').setAttribute('aria-pressed', String(!skills));
    el('skills-tab').setAttribute('aria-pressed', String(skills));
  }
  el('plugins-tab').addEventListener('click', () => selectTab(false));
  el('skills-tab').addEventListener('click', () => selectTab(true));
  function pending(value: boolean): void {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))
      control.disabled = value;
    el<HTMLButtonElement>('activate-plugins').disabled = value || !getView();
    el<HTMLButtonElement>('close-plugins').disabled = value;
    for (const toggle of dialog.querySelectorAll<HTMLButtonElement>('[role=switch]')) toggle.disabled = value;
  }
  function showError(reason: unknown): void {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
    error.hidden = false;
  }
  function render(inventory: PluginInventory): void {
    const view = getView();
    const loaded = (active: boolean) => `<span class="resource-state">${active ? '当前会话已加载' : '当前会话未加载'}</span>`;
    const toggle = (item: { name: string; path: string; enabled: boolean }, type: 'extension' | 'skill') =>
      `<div class="resource-control"><span>${item.enabled ? '已开启' : '已关闭'}</span><button type="button" class="resource-switch" role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? '关闭' : '开启'} ${escape(item.name)}" data-kind="${type}" data-path="${escape(item.path)}"><span></span></button></div>`;
    el('plugins-count').textContent = String(inventory.extensions.length);
    el('skills-count').textContent = String(inventory.skills.length);
    el('plugin-packages').innerHTML = inventory.packages.length
      ? inventory.packages.map((item) => `<li><strong>${escape(item.source)}</strong><span class="resource-state">${item.installed ? '已安装' : '文件缺失'}</span></li>`).join('')
      : '<li class="resource-empty">暂无资源包，可安装 npm、Git 或本地 Pi 资源包。</li>';
    el('plugin-extensions').innerHTML = inventory.extensions.length
      ? inventory.extensions.map((item) => `<li><div class="resource-info"><strong>${escape(item.source === 'local' || item.source === 'auto' ? item.name : item.source)}</strong><small>${escape(item.path)}</small>${loaded(!!view?.extensions.includes(item.path))}</div>${toggle(item, 'extension')}</li>`).join('')
      : '<li class="resource-empty">暂无插件，点击下方安装入口添加。</li>';
    el('plugin-skills').innerHTML = inventory.skills.length
      ? inventory.skills.map((item) => `<li><div class="resource-info"><strong>${escape(item.name)}</strong><p>${escape(item.description)}</p><small>${escape(item.path)} · /skill:${escape(item.name)}</small>${loaded(!!view?.skills.some((skill) => skill.path === item.path))}</div>${toggle(item, 'skill')}</li>`).join('')
      : '<li class="resource-empty">暂无技能，可导入包含 SKILL.md 的目录。</li>';
    el('plugin-diagnostics').textContent = inventory.diagnostics.join('\n');
    el('plugin-diagnostics').hidden = !inventory.diagnostics.length;
  }
  dialog.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role=switch]');
    if (!button || busy) return;
    const path = button.dataset.path!;
    const kind = button.dataset.kind as 'extension' | 'skill';
    const enabled = button.getAttribute('aria-checked') !== 'true';
    error.hidden = true;
    pending(true);
    status.textContent = '正在保存设置…';
    void window.agentClient.setPluginEnabled(path, kind, enabled).then((inventory) => {
      render(inventory);
      status.textContent = '设置已保存，新建对话后生效。';
      const list = el(kind === 'skill' ? 'plugin-skills' : 'plugin-extensions');
      [...list.querySelectorAll<HTMLButtonElement>('[role=switch]')].find((item) => item.dataset.path === path)?.focus();
    }).catch((reason) => { status.textContent = '设置未保存，请重试。'; showError(reason); }).finally(() => pending(false));
  });
  el('plugins-button').addEventListener('click', () => {
    if (document.querySelector('dialog[open]')) return;
    error.hidden = true;
    status.textContent = '正在读取已安装资源…';
    selectTab(false);
    dialog.showModal();
    pending(true);
    void window.agentClient.listPlugins().then((inventory) => {
      render(inventory);
      status.textContent = '安装到用户级 Pi 配置；新建对话后加载。';
    }).catch(showError).finally(() => pending(false));
  });
  el('close-plugins').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  el('choose-plugin-source').addEventListener('click', () => {
    void window.agentClient.choosePluginSource(kind.value as 'package' | 'skill')
      .then((path) => { if (path) source.value = path; }).catch(showError);
  });
  kind.addEventListener('change', () => {
    source.placeholder = kind.value === 'skill' ? '包含 SKILL.md 的完整目录路径' : 'npm:包名、Git 地址或本地资源包路径';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    error.hidden = true;
    pending(true);
    status.textContent = '正在安装，请等待完成…';
    void window.agentClient.installPlugin(source.value, kind.value as 'package' | 'skill').then((inventory) => {
      render(inventory);
      selectTab(kind.value === 'skill');
      status.textContent = '安装完成。点击“新建对话并加载”后使用；原对话及草稿会保留。';
      source.value = '';
    }).catch((reason) => { status.textContent = '安装未完成。'; showError(reason); }).finally(() => pending(false));
  });
  el('activate-plugins').addEventListener('click', () => {
    pending(true);
    error.hidden = true;
    status.textContent = '正在加载到新对话…';
    void activate().then(() => dialog.close()).catch(showError).finally(() => pending(false));
  });
}
