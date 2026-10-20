import { el } from '../../shared/dom.js';

export function bindSessionSidebar() {
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
  const searchButton = el<HTMLButtonElement>('search-sessions');
  const searchBox = el('session-search-box');
  const sessionToggle = el<HTMLButtonElement>('toggle-session-list');
  const sessions = el('sessions');
  function expandSessions(expanded: boolean): void {
    sessions.hidden = !expanded;
    sessionToggle.setAttribute('aria-expanded', String(expanded));
  }
  sessionToggle.addEventListener('click', () => expandSessions(sessions.hidden));
  function focusSearch(): void {
    expandSessions(true);
    setExpanded(true);
    searchBox.hidden = false;
    searchButton.setAttribute('aria-expanded', 'true');
    el<HTMLInputElement>('session-search').focus();
  }
  searchButton.addEventListener('click', () => {
    if (searchBox.hidden) focusSearch();
    else {
      searchBox.hidden = true;
      searchButton.setAttribute('aria-expanded', 'false');
      const input = el<HTMLInputElement>('session-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      searchButton.focus();
    }
  });
  return { focusSearch };
}
