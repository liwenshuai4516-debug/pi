import { el } from '../../shared/dom.js';

export function bindSessionSidebar(): (expanded: boolean) => void {
  const sidebar = el('session-sidebar');
  const toggle = el<HTMLButtonElement>('toggle-sidebar');
  function setExpanded(expanded: boolean): void {
    // 隐藏整个侧栏，让出聊天空间，同时将侧栏控件移出键盘导航。
    if (!expanded && sidebar.contains(document.activeElement)) toggle.focus();
    sidebar.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? '收起会话栏' : '展开会话栏';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  toggle.addEventListener('click', () => setExpanded(sidebar.hidden));
  return setExpanded;
}
