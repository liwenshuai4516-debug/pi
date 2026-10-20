import { describeInChinese } from '../../../shared/descriptions-zh.js';
import type { PluginInventory, SessionView } from '../../../shared/types.js';
import { el, escape } from '../../shared/dom.js';
import { bindMcpPanel } from './mcp.js';

export function bindPlugins(getView: () => SessionView | null, activate: () => Promise<void>): void {
  const dialog = el<HTMLDialogElement>('plugins-dialog');
  const form = el<HTMLFormElement>('plugin-form');
  const status = el('plugin-status');
  const error = el('plugin-error');
  const kind = el<HTMLSelectElement>('plugin-kind');
  const source = el<HTMLInputElement>('plugin-source');
  let busy = false;
  function selectTab(tab: 'packages' | 'skills' | 'mcp'): void {
    for (const [name, prefix] of [['packages', 'plugins'], ['skills', 'skills'], ['mcp', 'mcp']]) {
      el(`${prefix}-pane`).hidden = name !== tab;
      el(`${prefix}-tab`).setAttribute('aria-pressed', String(name === tab));
    }
    el('plugin-install').hidden = tab === 'mcp';
    if (tab === 'mcp') void mcp.refresh();
  }
  el('plugins-tab').addEventListener('click', () => selectTab('packages'));
  el('skills-tab').addEventListener('click', () => selectTab('skills'));
  el('mcp-tab').addEventListener('click', () => selectTab('mcp'));
  function pending(value: boolean): void {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))
      control.disabled = value;
    el<HTMLButtonElement>('activate-plugins').disabled = value || !getView();
    el<HTMLButtonElement>('close-plugins').disabled = value;
    for (const toggle of dialog.querySelectorAll<HTMLButtonElement>('[role=switch]')) toggle.disabled = value;
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-package-action], [data-mcp-action], [data-mcp-exposure], #mcp-form input, #mcp-form textarea, #mcp-form button, #refresh-mcp')) {
      if (value) { control.dataset.previousDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.previousDisabled !== undefined) { control.disabled = control.dataset.previousDisabled === 'true'; delete control.dataset.previousDisabled; }
    }
  }
  function showError(reason: unknown): void {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
    error.hidden = false;
  }
  const mcp = bindMcpPanel(getView, () => busy, pending, showError);
  function render(inventory: PluginInventory): void {
    const view = getView();
    const loaded = (active: boolean) => `<span class="resource-state">${active ? '当前会话已加载' : '当前会话未加载'}</span>`;
    const toggle = (item: { name: string; path: string; enabled: boolean }, type: 'extension' | 'skill') =>
      `<div class="resource-control"><span>${item.enabled ? '已开启' : '已关闭'}</span><button type="button" class="resource-switch" role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? '关闭' : '开启'} ${escape(item.name)}" data-kind="${type}" data-path="${escape(item.path)}"><span></span></button></div>`;
    el('plugins-count').textContent = String(inventory.packages.length);
    el('skills-count').textContent = String(inventory.skills.length);
    el('plugin-packages').innerHTML = inventory.packages.length
      ? inventory.packages.map((item) => `<li><div class="resource-info"><strong>${escape(item.source)}</strong><p><span class="resource-state">${item.installed ? '已安装' : '文件缺失'}</span></p></div><div class="mcp-actions"><button type="button" class="secondary-button" data-package-action="update" data-source="${escape(item.source)}">更新</button><button type="button" class="secondary-button" data-package-action="remove" data-source="${escape(item.source)}">移除</button></div></li>`).join('')
      : '<li class="resource-empty">暂无资源包，可安装 npm、Git 或本地 Pi 资源包。</li>';
    el('plugin-extensions').innerHTML = inventory.extensions.length
      ? inventory.extensions.map((item) => `<li><div class="resource-info"><strong>${escape(item.source === 'local' || item.source === 'auto' ? item.name : item.source)}</strong><small>${escape(item.path)}</small>${loaded(!!view?.extensions.includes(item.path))}</div>${toggle(item, 'extension')}</li>`).join('')
      : '<li class="resource-empty">暂无插件，点击下方安装入口添加。</li>';
    el('plugin-skills').innerHTML = inventory.skills.length
      ? inventory.skills.map((item) => `<li><div class="resource-info"><strong>${escape(item.name)}</strong><p>${escape(describeInChinese(item.description))}</p><small>来源：${escape(item.source === 'auto' || item.source === 'local' ? '用户技能目录' : item.source)}</small><small>${escape(item.path)} · /skill:${escape(item.name)}</small>${loaded(!!view?.skills.some((skill) => skill.path === item.path))}</div>${toggle(item, 'skill')}</li>`).join('')
      : '<li class="resource-empty">暂无技能，可导入包含 SKILL.md 的目录。</li>';
    el('plugin-diagnostics').textContent = inventory.diagnostics.join('\n');
    el('plugin-diagnostics').hidden = !inventory.diagnostics.length;
  }
  dialog.addEventListener('click', (event) => {
    const packageButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-package-action]');
    if (packageButton && !busy) {
      if (packageButton.dataset.packageAction === 'remove' && packageButton.dataset.confirmed !== 'true') {
        packageButton.dataset.confirmed = 'true'; packageButton.textContent = '确认移除'; return;
      }
      pending(true); error.hidden = true; status.textContent = '正在处理资源包…';
      void window.agentClient.packageAction(packageButton.dataset.source!, packageButton.dataset.packageAction as 'update' | 'remove')
        .then(inventory => { render(inventory); status.textContent = '资源包设置已更新，新建对话后生效。'; })
        .catch(showError).finally(() => pending(false));
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role=switch][data-kind]');
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
    selectTab('packages');
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
    source.placeholder = kind.value === 'skill' ? '包含 SKILL.md 的完整目录路径' : 'pi install npm:pi-goal-x，或 npm:包名、Git 地址、本地目录';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    error.hidden = true;
    pending(true);
    status.textContent = '正在安装，请等待完成…';
    void window.agentClient.installPlugin(source.value, kind.value as 'package' | 'skill').then((inventory) => {
      render(inventory);
      selectTab(kind.value === 'skill' ? 'skills' : 'packages');
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
