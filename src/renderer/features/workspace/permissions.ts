import type { SessionView, WorkspacePermission } from '../../../shared/types.js';
import { el } from '../../shared/dom.js';

export const permissionLabels: Record<WorkspacePermission, string> = {
  'read-only': '只读',
  workspace: '工作区读写',
  'full-access': '完全访问',
};
export function renderWorkspacePermission(view: SessionView | null, disabled: boolean): void {
  const select = el<HTMLSelectElement>('workspace-permission');
  select.value = view?.permission ?? 'workspace';
  select.disabled = !view || disabled;
  el('permission-label').textContent = view ? permissionLabels[view.permission] : '工作区权限';
  el('permission-description').textContent =
    view?.permission === 'full-access'
      ? '完全访问：文件和命令沿用当前系统账号的访问权限。'
      : `${view?.permission === 'read-only' ? '只读：可以读取项目内容，禁止修改文件。' : '工作区读写：文件工具和命令可在项目内读写。'}命令可读取系统运行文件；网络访问不由此入口限制。`;
}
export function bindWorkspacePermission(
  getView: () => SessionView | null,
  onView: (view: SessionView) => void,
  onError: (error: unknown) => void,
  onPending: (pending: boolean) => void,
): void {
  el<HTMLSelectElement>('workspace-permission').addEventListener('change', async (event) => {
    const select = event.currentTarget as HTMLSelectElement,
      view = getView();
    if (!view) return;
    const permission = select.value as WorkspacePermission;
    select.disabled = true;
    onPending(true);
    try {
      onView(await window.agentClient.setPermission(view.id, permission));
    } catch (error) {
      select.value = view.permission;
      onError(error);
    } finally {
      onPending(false);
      select.disabled = !getView() || Boolean(getView()?.running);
    }
  });
}
