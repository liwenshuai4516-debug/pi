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
  function pending(value: boolean): void {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))
      control.disabled = value;
    el<HTMLButtonElement>('activate-plugins').disabled = value || !getView();
    el<HTMLButtonElement>('close-plugins').disabled = value;
  }
  function showError(reason: unknown): void {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
    error.hidden = false;
  }
  function render(inventory: PluginInventory): void {
    const view = getView();
    const loaded = (enabled: boolean) => `<span class="resource-state">${enabled ? '当前会话已加载' : '新建对话后加载'}</span>`;
    el('plugin-packages').innerHTML = inventory.packages.length
      ? inventory.packages.map((item) => `<li><strong>${escape(item.source)}</strong><span class="resource-state">${item.installed ? '已安装' : '文件缺失'}</span></li>`).join('')
      : '<li class="resource-empty">暂无资源包，可安装 npm、Git 或本地 Pi 资源包。</li>';
    el('plugin-extensions').innerHTML = inventory.extensions.length
      ? inventory.extensions.map((item) => `<li><div><strong>${escape(item.name)}</strong><small>${escape(item.path)}</small></div>${loaded(!!view?.extensions.includes(item.path))}</li>`).join('')
      : '<li class="resource-empty">暂无可加载的插件。</li>';
    el('plugin-skills').innerHTML = inventory.skills.length
      ? inventory.skills.map((item) => `<li><div><strong>${escape(item.name)}</strong><p>${escape(item.description)}</p><small>/skill:${escape(item.name)}</small></div>${loaded(!!view?.skills.some((skill) => skill.path === item.path))}</li>`).join('')
      : '<li class="resource-empty">暂无 Skill，可导入包含 SKILL.md 的目录。</li>';
    el('plugin-diagnostics').textContent = inventory.diagnostics.join('\n');
    el('plugin-diagnostics').hidden = !inventory.diagnostics.length;
  }
  el('plugins-button').addEventListener('click', () => {
    if (document.querySelector('dialog[open]')) return;
    error.hidden = true;
    status.textContent = '正在读取已安装资源…';
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
