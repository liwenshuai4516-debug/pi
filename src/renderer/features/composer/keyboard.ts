/** Enter 发送、Shift+Enter 换行；中文候选确认与长按回车不触发发送。 */
export function bindComposerKeyboard(
  input: HTMLTextAreaElement,
  canSend: () => boolean,
  submit: () => void,
): void {
  let composing = false;
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
  });
  input.addEventListener('keydown', (event) => {
    // Safari 等环境可能先触发 compositionend，再派发 keyCode 229 的确认键。
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!event.repeat && canSend()) submit();
  });
}
