import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ChatMessage, ContentBlock, SessionView } from '../../../shared/types.js';
import { renderToolTrace } from './tool-trace.js';
import { el, escape } from '../../shared/dom.js';
const messages = el<HTMLDivElement>('messages');
const markdown = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ['img', 'iframe', 'form', 'input', 'style'],
    FORBID_ATTR: ['style'],
  });

function renderUserText(text: string | undefined): string {
  const skill = /^<skill name="([^"]+)" location="[^"]+">[\s\S]*<\/skill>\s*([\s\S]*)$/.exec(text ?? '');
  return skill
    ? `<span class="skill-invocation">使用 Skill · ${escape(skill[1])}</span>${escape(skill[2])}`
    : escape(text);
}

function renderMessage(message: ChatMessage, index: number, active: SessionView | null, turn: number): string {
  if (message.role === 'toolResult') return '';
  if (!['user', 'assistant'].includes(message.role)) return '';
  const blocks: ContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  let body = '';
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type === 'text')
      body += message.role === 'user' ? renderUserText(block.text) : markdown(block.text ?? '');
    if (block.type === 'thinking' && block.thinking)
      body += `<details class="thinking-block" data-key="thinking-${index}-${blockIndex}"><summary>思考过程</summary>${markdown(block.thinking)}</details>`;
    if (block.type === 'image') body += '<p class="attachment-chip">图片附件</p>';
    if (block.type === 'toolCall') body += renderToolTrace(block, active);
  }
  if (message.errorMessage && message.stopReason !== 'aborted') body += `<p class="form-error">${escape(message.errorMessage)}</p>`;
  if (message.stopReason === 'aborted') body += '<p class="path-note">已停止</p>';
  return `<article class="message ${message.role}"><div class="message-heading"><span class="avatar" aria-hidden="true">${message.role === 'user' ? '你' : 'π'}</span><strong>${message.role === 'user' ? '你' : 'Pi'}</strong>${message.role === 'assistant' ? `<span class="turn-label">第 ${turn} 轮</span>` : ''}${message.timestamp ? `<small>${new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small>` : ''}</div><div class="message-body">${body}</div></article>`;
}
export function renderMessages(active: SessionView | null): void {
  const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 180;
  const openDetails = new Set(
    [...messages.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
      (node) => node.dataset.key,
    ),
  );
  if (!active || !active.messages.length)
    messages.innerHTML = '<div class="welcome"><h1>从一个任务开始</h1><p>告诉 Pi 你想完成什么</p></div>';
  else {
    let turn = 0;
    messages.innerHTML =
      active.messages.map((message, index) => {
        if (message.role === 'user') turn = 0;
        if (message.role === 'assistant') turn++;
        return renderMessage(message, index, active, turn);
      }).join('') +
      (active.running
        ? '<div class="running-label" role="status"><span class="status-dot"></span>Agent 正在执行…</div>'
        : '');
  }
  for (const detail of messages.querySelectorAll<HTMLDetailsElement>('details'))
    if (openDetails.has(detail.dataset.key)) detail.open = true;
  if (stick) messages.scrollTop = messages.scrollHeight;
}
