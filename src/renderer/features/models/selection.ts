import type { SessionView, ThinkingLevel } from '../../../shared/types.js';
import { el } from '../../shared/dom.js';

/** 配置响应按会话 ID 应用；切换进行中禁用发送，避免用旧模型发送新选择。 */
export function bindModelSelection(
  getView: () => SessionView | null,
  onView: (view: SessionView) => void,
  onPending: (pending: boolean) => void,
  onError: (error: unknown) => void,
): void {
  const model = el<HTMLSelectElement>('model'),
    thinking = el<HTMLSelectElement>('thinking');
  async function change(kind: 'model' | 'thinking'): Promise<void> {
    const view = getView();
    if (!view) return;
    const value = kind === 'model' ? model.value : thinking.value;
    onPending(true);
    try {
      if (kind === 'model') {
        const [provider, id] = JSON.parse(value) as string[];
        onView(await window.agentClient.setModel(view.id, provider, id));
      } else onView(await window.agentClient.setThinking(view.id, value as ThinkingLevel));
    } catch (error) {
      if (getView()?.id === view.id) {
        model.value = view.model ? JSON.stringify([view.model.provider, view.model.id]) : '';
        thinking.value = view.thinking;
      }
      onError(error);
    } finally {
      onPending(false);
    }
  }
  model.addEventListener('change', () => {
    if (model.value) void change('model');
  });
  thinking.addEventListener('change', () => void change('thinking'));
}
