import type { SessionSummary } from '../../../shared/types.js';
import { el } from '../../shared/dom.js';
const api = window.agentClient;

export function bindSessionManagement({
  getSessions,
  isNavigating,
  openSession,
  onDeleted,
  notice,
}: {
  getSessions: () => SessionSummary[];
  isNavigating: () => boolean;
  openSession: (id: string) => Promise<void>;
  onDeleted: (id: string) => void;
  notice: (text: string) => void;
}) {
  const sessionDialog = el<HTMLDialogElement>('session-dialog');
  let managed: SessionSummary | null = null;
  let managing = false;
  function manageSession(id: string): void {
    if (isNavigating() || sessionDialog.open) return;
    managed = getSessions().find((item) => item.id === id) ?? null;
    if (!managed) return;
    el<HTMLInputElement>('session-name').value = managed.name;
    el('session-main').hidden = false;
    el('session-delete-confirm').hidden = true;
    el('session-action-error').hidden = true;
    sessionDialog.showModal();
    el<HTMLInputElement>('session-name').select();
  }
  async function sessionAction(action: 'rename' | 'fork' | 'delete'): Promise<void> {
    if (!managed || managing) return;
    // 固定操作目标，流式更新或切换列表不会让确认操作误作用于另一会话。
    const target = managed;
    managing = true;
    el('session-action-error').hidden = true;
    sessionDialog.setAttribute('aria-busy', 'true');
    el('session-action-progress').textContent =
      action === 'delete'
        ? '正在停止任务并删除会话，请稍候…'
        : action === 'fork'
          ? '正在创建分支…'
          : '正在保存名称…';
    el('session-action-progress').hidden = false;
    const buttons = [...sessionDialog.querySelectorAll<HTMLButtonElement>('button')];
    for (const button of buttons) button.disabled = true;
    el<HTMLInputElement>('session-name').disabled = true;
    try {
      if (action === 'rename') {
        await api.renameSession(target.id, el<HTMLInputElement>('session-name').value.trim());
        notice('会话名称已保存');
      } else if (action === 'fork') {
        const id = await api.forkSession(target.id);
        await openSession(id);
        notice('已创建独立分支，可以继续对话；原会话已保留');
      } else {
        await api.deleteSession(target.id);
        // 清理被删除会话的草稿，保留其他会话和项目；不自动新建空会话。
        onDeleted(target.id);
        notice('会话已删除，项目文件和其他分支已保留');
      }
      sessionDialog.close();
    } catch (error) {
      el('session-action-error').textContent =
        error instanceof Error ? error.message : String(error);
      el('session-action-error').hidden = false;
    } finally {
      managing = false;
      for (const button of buttons) button.disabled = false;
      sessionDialog.removeAttribute('aria-busy');
      el('session-action-progress').hidden = true;
      el<HTMLInputElement>('session-name').disabled = false;
    }
  }
  el<HTMLFormElement>('session-rename-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void sessionAction('rename');
  });
  el('session-fork').addEventListener('click', () => void sessionAction('fork'));
  el('session-delete').addEventListener('click', () => {
    el('session-action-error').hidden = true;
    el('session-main').hidden = true;
    el('session-delete-confirm').hidden = false;
    el('session-delete-description').textContent =
      `将删除「${managed?.name}」的历史和未发送草稿。如有运行任务，会先停止并等待工具结束。此操作无法撤销；项目文件和其他分支会保留。`;
    el('cancel-session-delete').focus();
  });
  el('confirm-session-delete').addEventListener('click', () => void sessionAction('delete'));
  el('cancel-session-delete').addEventListener('click', () => {
    el('session-main').hidden = false;
    el('session-delete-confirm').hidden = true;
    el('session-delete').focus();
  });
  el('close-session-dialog').addEventListener('click', () => sessionDialog.close());
  sessionDialog.addEventListener('cancel', (event) => {
    if (managing) event.preventDefault();
  });
  sessionDialog.addEventListener('close', () => {
    const id = managed?.id;
    managed = null;
    // 列表会在操作后重绘，原触发按钮可能已被替换，主动恢复可见焦点。
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('[data-manage]')].find(
      (button) => button.dataset.manage === id,
    );
    (trigger ?? el<HTMLButtonElement>('new-session')).focus();
  });
  return manageSession;
}
