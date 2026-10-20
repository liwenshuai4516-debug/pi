import type { McpAction, McpInventory, SessionView } from '../../../shared/types.js';
import { el, escape } from '../../shared/dom.js';

export function bindMcpPanel(
  getView: () => SessionView | null,
  isBusy: () => boolean,
  pending: (value: boolean) => void,
  showError: (reason: unknown) => void,
): { refresh: () => Promise<void> } {
  const api = window.agentClient, dialog = el<HTMLDialogElement>('plugins-dialog');
  const list = el('mcp-servers'), notice = el('mcp-notice');
  let revision = 0, last = '', reading = false;
  const states: Record<string, string> = { connected: '已连接', connecting: '连接中', starting: '启动中', disconnected: '已断开', disabled: '已关闭', failed: '连接失败', 'needs-auth': '需要登录', closed: '已关闭', unknown: '当前会话未加载' };
  const scopes = { global: '用户配置', project: '项目配置', extension: '扩展注册 · 仅当前会话' };
  const exposures = { codemode: '按需调用 · codemode', deferred: '搜索后调用 · deferred', direct: '直接提供 · direct', hidden: '隐藏工具 · hidden' };
  function render(inventory: McpInventory): void {
    el('mcp-count').textContent = String(inventory.servers.length);
    notice.textContent = inventory.diagnostics.join('\n') || '文件配置持久保存；扩展注册服务的调整仅用于当前对话。';
    el<HTMLFormElement>('mcp-form').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input, textarea, button').forEach(control => { control.disabled = !inventory.available; });
    const next = JSON.stringify(inventory);
    if (next === last) return;
    last = next;
    const focus = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusServer = focus?.dataset.server, focusAction = focus?.dataset.mcpAction;
    const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.server));
    list.innerHTML = inventory.servers.length ? inventory.servers.map(server => {
      const button = (action: McpAction, label: string, disabled = false) => `<button type="button" class="secondary-button" data-mcp-action="${action}" data-server="${escape(server.name)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
      return `<li><div class="resource-info"><div class="mcp-heading"><strong>${escape(server.name)}</strong><span class="resource-state" data-state="${escape(server.state)}">${states[server.state] ?? '未知状态'}</span></div><small>${scopes[server.scope]} · ${server.transport === 'http' ? '远程 HTTP' : '本地 stdio'}</small><small>${escape(server.source)}</small><small>服务提供 ${server.toolCount} 个工具</small><div class="mcp-actions">${button(server.enabled ? 'disable' : 'enable', server.enabled ? '关闭' : '开启')}${server.canLogin ? button('login', '登录', !server.enabled) + button('logout', '退出登录', !server.enabled) : ''}${button('reconnect', '重新连接', !server.enabled)}${server.scope !== 'extension' ? button('remove', '移除配置') : ''}</div><label class="mcp-exposure">工具使用方式<select data-mcp-exposure data-server="${escape(server.name)}" aria-label="${escape(server.name)} 工具使用方式">${Object.entries(exposures).map(([value, label]) => `<option value="${value}" ${server.exposure === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><details data-server="${escape(server.name)}" ${expanded.has(server.name) ? 'open' : ''}><summary>可调用工具 · ${server.tools.length}</summary>${server.tools.length ? server.tools.map(tool => `<div class="mcp-tool"><strong>${escape(tool.name)}</strong><p>${escape(tool.description)}</p></div>`).join('') : '<p class="path-note">当前没有可调用的工具。隐藏的工具不可调用；需要登录时请先完成授权。</p>'}</details></div></li>`;
    }).join('') : '<li class="resource-empty">当前对话没有 MCP 服务。可添加服务，或启用注册 MCP 的资源包后新建对话。</li>';
    if (focusServer) [...list.querySelectorAll<HTMLElement>('button, select')].find(item => item.dataset.server === focusServer && item.dataset.mcpAction === focusAction)?.focus();
  }
  async function refresh(): Promise<void> {
    const view = getView();
    if (!view) { notice.textContent = '请先打开对话。'; return; }
    if (reading || isBusy()) return;
    reading = true;
    const current = ++revision;
    try {
      const inventory = await api.listMcp(view.id);
      if (current === revision && getView()?.id === view.id) render(inventory);
    } catch (reason) { if (current === revision) showError(reason); }
    finally { reading = false; }
  }
  async function change(action: (id: string) => Promise<McpInventory>): Promise<void> {
    const view = getView();
    if (!view || isBusy()) return;
    revision++;
    el('plugin-error').hidden = true;
    pending(true);
    el('mcp-cancel').hidden = false;
    el('plugin-status').textContent = '正在处理 MCP 服务；登录时请在浏览器完成授权…';
    try {
      const inventory = await action(view.id);
      if (getView()?.id === view.id) render(inventory);
      el('plugin-status').textContent = '操作已完成，连接状态见服务列表。';
    } catch (reason) { showError(reason); el('plugin-status').textContent = '操作未完成，请检查提示后重试。'; }
    finally { pending(false); el('mcp-cancel').hidden = true; }
  }
  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mcp-action]');
    if (!button || isBusy()) return;
    if (button.dataset.mcpAction === 'remove' && button.dataset.confirmed !== 'true') {
      button.dataset.confirmed = 'true'; button.textContent = '确认移除配置'; return;
    }
    void change(id => api.manageMcp(id, button.dataset.server!, button.dataset.mcpAction as McpAction));
  });
  list.addEventListener('change', event => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>('[data-mcp-exposure]');
    if (select) void change(id => api.manageMcp(id, select.dataset.server!, select.value as McpAction));
  });
  el('mcp-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = el<HTMLInputElement>('mcp-name'), config = el<HTMLTextAreaElement>('mcp-config');
    void change(async id => { const inventory = await api.addMcp(id, name.value, config.value); name.value = ''; config.value = ''; return inventory; });
  });
  el('refresh-mcp').addEventListener('click', () => void refresh());
  el('mcp-cancel').addEventListener('click', () => {
    const view = getView();
    if (view) void api.stop(view.id).catch(showError);
  });
  const timer = setInterval(() => { if (dialog.open && !el('mcp-pane').hidden) void refresh(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  dialog.addEventListener('close', () => { revision++; last = ''; el<HTMLTextAreaElement>('mcp-config').value = ''; });
  return { refresh };
}
