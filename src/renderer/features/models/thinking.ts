import type { SessionView, ThinkingLevel } from '../../../shared/types.js';
import { el } from '../../shared/dom.js';

export function renderThinking(view: SessionView | null): void {
  const select = el<HTMLSelectElement>('thinking');
  const labels: Record<ThinkingLevel, string> = {
    off: '关闭思考',
    minimal: '极少',
    low: '低',
    medium: '中等',
    high: '高',
    xhigh: '更高',
    max: '最高',
  };
  select.innerHTML = (view?.thinkingLevels ?? ['off'])
    .map((level) => `<option value="${level}">${labels[level]}</option>`)
    .join('');
  select.value = view?.thinking ?? 'off';
  select.title =
    view?.thinkingLevels.length === 1
      ? '当前模型未声明可调思考能力；请在模型配置中核对'
      : '思考强度，由当前模型支持能力决定';
}
