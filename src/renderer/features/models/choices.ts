import type { ModelChoice, SessionView } from '../../../shared/types.js';
import { el, escape } from '../../shared/dom.js';
const modelSelect = el<HTMLSelectElement>('model');

export function renderModelChoices(models: ModelChoice[], active: SessionView | null): void {
  const chosen = active?.model ? JSON.stringify([active.model.provider, active.model.id]) : '';
  modelSelect.innerHTML =
    '<option value="">选择模型</option>' +
    models
      .map(
        (model) =>
          `<option value="${escape(JSON.stringify([model.provider, model.id]))}">${escape(model.name)} · ${escape(model.provider)}</option>`,
      )
      .join('');
  if (chosen && !models.some((model) => JSON.stringify([model.provider, model.id]) === chosen))
    modelSelect.insertAdjacentHTML(
      'beforeend',
      `<option value="${escape(chosen)}">${escape(active?.model?.name)} · 当前模型</option>`,
    );
  modelSelect.value = chosen;
  el('configured-models').textContent = models.length
    ? `已加载 ${models.length} 个可用模型：${models
        .slice(0, 5)
        .map((model) => `${model.provider}/${model.id}`)
        .join('、')}${models.length > 5 ? '…' : ''}`
    : '尚无已配置的可用模型。';
}
