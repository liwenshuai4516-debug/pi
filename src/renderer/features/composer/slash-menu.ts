import type { SessionView, SlashCompletion } from '../../../shared/types.js';
import { el, escape } from '../../shared/dom.js';

/** 仅补全光标前的命令；保留任务后缀和草稿，候选始终由主进程的当前运行器提供。 */
export function bindSlashMenu(
  input: HTMLTextAreaElement,
  getSession: () => SessionView | null,
  complete: (id: string, prefix: string) => Promise<SlashCompletion[]>,
): { refresh: () => void } {
  const menu = el('slash-menu'), list = el('slash-list'), status = el('slash-status');
  let items: SlashCompletion[] = [], selected = 0, generation = 0, key = '', composing = false, loading = false;
  const kinds = { command: '扩展命令', skill: '技能', template: '提示模板', service: 'MCP 服务' };
  const signature = () => `${getSession()?.id}:${input.value}:${input.selectionStart}:${input.selectionEnd}`;

  function close(): void {
    generation++;
    loading = false;
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(): void {
    for (const [index, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(index === selected));
    const option = list.children[selected];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function show(message = ''): void {
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = message;
    status.hidden = !message;
    list.hidden = Boolean(message);
    el('slash-count').textContent = message ? '' : `${items.length} 项`;
  }
  function refresh(): void {
    const session = getSession();
    const prefix = input.value.slice(0, input.selectionStart);
    if (!session || session.running || input.disabled || composing || document.activeElement !== input ||
        input.selectionStart !== input.selectionEnd || prefix.length > 2000 || !/^\/[^\r\n]*$/.test(prefix)) {
      key = '';
      close();
      return;
    }
    const nextKey = signature();
    if (nextKey === key) return;
    key = nextKey;
    close();
    const request = generation;
    loading = true;
    items = [];
    selected = 0;
    list.replaceChildren();
    if (!/\s/.test(prefix)) show('正在加载候选…');
    void complete(session.id, prefix).then((result) => {
      // 切换会话、光标移动、继续输入或取消后，丢弃迟到的响应。
      if (request !== generation || nextKey !== signature()) return;
      loading = false;
      items = result;
      if (!items.length && /\s/.test(prefix)) { close(); return; }
      list.innerHTML = items.map((item, index) =>
        `<button type="button" role="option" tabindex="-1" id="slash-option-${index}" data-slash-index="${index}" aria-selected="false" class="slash-option" title="${escape(item.description)}"><span class="slash-option-copy"><span class="slash-option-name">${escape(item.label)}</span><span class="slash-option-description">${escape(item.description)}</span></span><span class="slash-option-kind">${kinds[item.kind]}</span></button>`,
      ).join('');
      show(items.length ? '' : '没有匹配的技能或命令');
      highlight();
    }).catch((error: unknown) => {
      if (request !== generation || nextKey !== signature()) return;
      loading = false;
      show(error instanceof Error ? error.message : '加载命令失败，请重新输入');
    });
  }
  function pick(index: number): void {
    const item = items[index];
    if (!item) return;
    const suffix = input.value.slice(input.selectionEnd);
    const inserted = /^\s/.test(suffix) ? item.value.trimEnd() : item.value.replace(/\s*$/, ' ');
    input.value = inserted + suffix;
    input.setSelectionRange(inserted.length, inserted.length);
    close();
    key = signature();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.addEventListener('input', refresh);
  input.addEventListener('click', refresh);
  input.addEventListener('keyup', refresh);
  input.addEventListener('focus', () => { key = ''; refresh(); });
  input.addEventListener('blur', () => { key = ''; close(); });
  input.addEventListener('compositionstart', () => { composing = true; key = ''; close(); });
  input.addEventListener('compositionend', () => { composing = false; refresh(); });
  input.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 || menu.hidden ||
        event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length) {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        highlight();
      }
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    if (event.key === 'Enter' && !loading && !items.length) { close(); return; }
    if (event.key === 'Enter' && !loading && items[selected]?.value.trim() === input.value.slice(0, input.selectionStart).trim()) {
      close(); // 已完整输入的命令按 Enter 可直接发送，保留既有操作。
      return;
    }
    if (event.key === 'Tab' && !items.length) return;
    event.preventDefault();
    if (!event.repeat && !loading) pick(selected);
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[data-slash-index]');
    if (option) pick(Number(option.dataset.slashIndex));
  });
  return { refresh };
}
