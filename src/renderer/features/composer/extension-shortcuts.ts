import type { SessionView } from '../../../shared/types.js';

/** 仅转发当前会话声明的组合键；保留客户端快捷键、输入法与普通输入。 */
export function bindExtensionShortcuts(
  getSession: () => SessionView | null,
  invoke: (id: string, key: string) => void,
): void {
  let composing = false;
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || composing || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return;
    const session = getSession();
    if (!session) return;
    const parts = [
      ...(event.ctrlKey ? ['ctrl'] : []), ...(event.altKey ? ['alt'] : []),
      ...(event.shiftKey ? ['shift'] : []), ...(event.metaKey ? ['meta'] : []),
      event.key.toLowerCase(),
    ];
    const normalized = parts.sort().join('+');
    const shortcut = session.shortcuts.find((item) => item.key.toLowerCase().split('+').sort().join('+') === normalized);
    if (!shortcut) return;
    event.preventDefault();
    invoke(session.id, shortcut.key);
  });
}
