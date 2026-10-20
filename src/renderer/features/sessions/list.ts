import type { SessionSummary } from '../../../shared/types.js';
import { el, escape, nameOf } from '../../shared/dom.js';

export function renderSessionList(sessions: SessionSummary[], activeId: string | undefined): void {
  const query = el<HTMLInputElement>('session-search').value.toLowerCase();
  const visible = sessions.filter((item) =>
    `${item.name} ${item.cwd}`.toLowerCase().includes(query),
  );
  el('session-count').textContent = String(visible.length);
  el('sessions').innerHTML = visible.length
    ? visible
        .map(
          (item) =>
            `<div class="session-item"><button class="session-row ${item.id === activeId ? 'active' : ''}" data-session="${escape(item.id)}" ${item.id === activeId ? 'aria-current="page"' : ''}><span aria-hidden="true">${item.running ? '◌' : '▱'}</span><div><strong>${escape(item.name)}</strong><small>${escape(nameOf(item.cwd))} · ${item.running ? '运行中' : new Date(item.modified).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></div></button><button class="session-manage" data-manage="${escape(item.id)}" aria-label="管理会话 ${escape(item.name)}" title="管理会话"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button></div>`,
        )
        .join('')
    : '<p class="side-empty">暂无会话。选择项目，开始第一个任务。</p>';
}
