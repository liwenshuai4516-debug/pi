import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToolTrace } from '../../dist/renderer/features/chat/tool-trace.js';

test('trace translates known tools, preserves raw identity, and escapes extension-controlled content', () => {
  const translated = renderToolTrace({ type: 'toolCall', id: 'read-id', name: 'conversation_read', arguments: {} }, {
    messages: [{ role: 'toolResult', toolCallId: 'read-id', content: 'actual result', isError: true }], tools: [], running: false,
  });
  assert.match(translated, /读取会话/);
  assert.match(translated, /工具标识：<code>conversation_read/);
  assert.match(translated, /tool-status">失败/);
  assert.match(translated, /actual result/);
  const untrusted = renderToolTrace({ type: 'toolCall', id: '" onclick="bad', name: '<svg onload="bad">', arguments: { path: '<img src=x>' } }, {
    messages: [], tools: [], running: false,
  });
  assert.doesNotMatch(untrusted, /<svg onload|<img src=x>|data-key="tool-" onclick=/);
  assert.match(untrusted, /&lt;svg onload=/);
  assert.match(untrusted, /未完成/);
});
