import type { ContentBlock, SessionView } from '../../../shared/types.js';
import { escape } from '../../shared/dom.js';

const toolLabels: Record<string, string> = {
  read: '读取文件', write: '写入文件', edit: '编辑文件', bash: '执行命令',
  grep: '搜索内容', find: '查找文件', ls: '查看目录',
  conversation_read: '读取会话', conversation_list: '列出会话',
  conversation_search: '搜索会话', web_search: '搜索网页', web_fetch: '读取网页',
};
export function renderToolTrace(block: ContentBlock, active: SessionView | null): string {
  const result = active?.messages.find((item) => item.role === 'toolResult' && item.toolCallId === block.id);
  const progress = active?.tools.find((item) => item.id === block.id);
  const resultText = result
    ? typeof result.content === 'string' ? result.content
      : result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : progress?.output ?? '';
  const stopped = active?.messages.at(-1)?.stopReason === 'aborted';
  const status = result ? result.isError ? '失败' : '完成'
    : progress?.status === 'error' ? '失败'
    : progress?.status === 'done' ? '完成'
    : active?.running ? '执行中' : stopped ? '已停止' : '未完成';
  const args = block.arguments as Record<string, unknown> | undefined;
  const target = args?.path ?? args?.command ?? args?.query ?? '';
  const name = block.name ?? 'tool';
  const label = toolLabels[name] ?? name;
  return `<details class="tool-card ${status === '失败' ? 'failed' : ''}" data-key="tool-${escape(block.id)}"><summary>
    <svg class="trace-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
    <strong title="${escape(name)}">${escape(label)}</strong><span class="tool-target">${escape(typeof target === 'string' ? target : name)}</span><small class="tool-status">${status === '执行中' ? '<span class="execution-spinner" aria-hidden="true"></span>' : ''}${status}</small>
    </summary><div class="trace-detail"><div class="trace-tool-name">工具标识：<code>${escape(name)}</code></div><h4>输入参数</h4>
    <pre class="tool-output">${escape(JSON.stringify(block.arguments ?? {}, null, 2))}</pre><h4>执行结果</h4>
    <pre class="tool-output">${escape(resultText || (status === '执行中' ? '正在等待工具返回…' : status === '已停止' ? '任务已停止，工具尚未返回结果。' : '暂无文本结果。'))}</pre></div></details>`;
}
