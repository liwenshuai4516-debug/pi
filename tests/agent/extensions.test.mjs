import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { setupFixture, until } from '../support/fixture.mjs';

const extension = `
import { appendFileSync } from 'node:fs';
export default function (pi) {
  const record = (event, ctx) => appendFileSync(ctx.cwd + '/extension-events.log', event + '\\n');
  pi.on('session_start', (_, ctx) => { record('start', ctx); pi.appendEntry('qa-state', { started: true }); });
  pi.on('session_shutdown', (_, ctx) => record('shutdown', ctx));
  pi.on('agent_start', (_, ctx) => record('agent_start', ctx));
  pi.on('agent_end', (_, ctx) => record('agent_end', ctx));
  pi.on('input', (event) => event.text === 'TRANSFORM_INPUT' ? { action: 'transform', text: 'EXTENSION_TOOL' } : undefined);
  pi.on('before_agent_start', () => ({ systemPrompt: 'QA_EXTENSION_SYSTEM' }));
  pi.on('context', (event) => ({ messages: event.messages }));
  pi.on('tool_call', (event) => {
    if (event.toolName === 'write' && event.input.content !== 'NESTED_WRITE') return { block: true, reason: 'QA_BLOCKED_WRITE' };
  });
  pi.on('tool_result', (event) => {
    if (event.toolName === 'qa_echo') return { content: [{ type: 'text', text: 'QA_HOOK_RESULT' }] };
  });
  pi.registerTool({
    name: 'qa_echo', label: 'QA Echo', description: 'Echo test data',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (_, args, signal, onUpdate, ctx) => {
      record('tool:' + args.text + ':ui=' + ctx.hasUI, ctx);
      return { content: [{ type: 'text', text: args.text }], details: {} };
    },
  });
  pi.registerCommand('qa-name', { description: 'Rename session', handler: async (args) => pi.setSessionName(args) });
  pi.registerTool({
    name: 'qa_nested', label: 'Nested', description: 'Test nested write permissions',
    parameters: { type: 'object', properties: {} },
    execute: async (_, args, signal, onUpdate, ctx) => {
      const outcome = await ctx.executeTool('write', { path: ctx.cwd + '/nested.txt', content: 'NESTED_WRITE' });
      return { content: [{ type: 'text', text: 'NESTED_ERROR=' + outcome.isError }], details: {} };
    },
  });
  pi.registerCommand('qa-run', { handler: () => pi.sendUserMessage('EXTENSION_TOOL') });
  pi.registerCommand('qa-error', { handler: () => { throw new Error('QA_COMMAND_FAILED'); } });
  pi.registerCommand('qa-wait', { description: 'Wait for cancellation', handler: async (_, ctx) => {
    record('waiting', ctx);
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    record('cancelled', ctx);
  } });
}
`;

async function setup(t) {
  const fixture = await setupFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); fixture.close(); });
  await mkdir(join(fixture.agentDir, 'extensions'));
  await writeFile(join(fixture.agentDir, 'extensions', 'qa.ts'), extension);
  return { fixture, host };
}

test('Pi extensions: real discovery, commands, hooks, tools, permission changes and shutdown', async (t) => {
  const { fixture, host } = await setup(t);
  const view = await host.create(fixture.project, true);
  assert.equal(view.warning, null);
  assert.ok(host.entries.get(view.id).agent.state.tools.some((tool) => tool.name === 'qa_echo'));
  assert.ok(host.entries.get(view.id).manager.getEntries().some((entry) => entry.customType === 'qa-state'));
  await host.send(view.id, '/qa-name 扩展命令命名', [], []);
  assert.equal(host.view(view.id).name, '扩展命令命名');
  assert.equal(fixture.state.requests, 0, '扩展命令不应作为普通提示发给模型');
  await host.setPermission(view.id, 'read-only');
  await host.send(view.id, 'TRANSFORM_INPUT', [], []);
  assert.ok(JSON.stringify(fixture.state.toolResults).includes('QA_HOOK_RESULT'));
  assert.ok(JSON.stringify(fixture.state.payloads[0]).includes('QA_EXTENSION_SYSTEM'));
  const events = await readFile(join(fixture.project, 'extension-events.log'), 'utf8');
  assert.match(events, /tool:真实扩展工具:ui=true/);
  assert.match(events, /agent_start/);
  assert.match(events, /agent_end/);
  await host.send(view.id, 'WRITE_FIXTURE', [], []);
  assert.ok(JSON.stringify(fixture.state.toolResults).includes('QA_BLOCKED_WRITE'));
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
  await host.dispose();
  assert.equal((await readFile(join(fixture.project, 'extension-events.log'), 'utf8')).match(/shutdown/g).length, 1);
  const reopened = await host.open(view.id, async () => true);
  assert.ok(host.entries.get(reopened.id).agent.state.tools.some((tool) => tool.name === 'qa_echo'));
  assert.equal(fixture.state.requests, 4, '打开历史不重放模型或工具');
  await host.delete(view.id);
  assert.equal((await readFile(join(fixture.project, 'extension-events.log'), 'utf8')).match(/shutdown/g).length, 2);
});

test('Pi extensions: untrusted projects do not execute project extensions; load errors are visible', async (t) => {
  const { fixture, host } = await setup(t);
  await mkdir(join(fixture.project, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(fixture.project, '.pi', 'extensions', 'project.ts'), `export default (pi) => pi.registerCommand('project-name', { handler: () => pi.setSessionName('PROJECT_EXTENSION_LOADED') });`);
  const untrusted = await host.create(fixture.project, false);
  assert.ok(!host.entries.get(untrusted.id).extensions.runner.getCommand('project-name'));
  const trusted = await host.create(fixture.project, true);
  await host.send(trusted.id, '/project-name', [], []);
  assert.equal(host.view(trusted.id).name, 'PROJECT_EXTENSION_LOADED');
  await writeFile(join(fixture.agentDir, 'extensions', 'broken.ts'), `throw new Error('QA_LOAD_FAILED');`);
  const broken = await host.create(fixture.project, true);
  assert.match(broken.warning, /QA_LOAD_FAILED/);
});

test('Pi extension commands receive cancellation and finish before session cleanup', async (t) => {
  const { fixture, host } = await setup(t);
  const view = await host.create(fixture.project, true);
  const pending = host.send(view.id, '/qa-wait', [], []);
  await until(async () => (await readFile(join(fixture.project, 'extension-events.log'), 'utf8')).includes('waiting'));
  await host.stop(view.id);
  await pending;
  assert.match(await readFile(join(fixture.project, 'extension-events.log'), 'utf8'), /cancelled/);
  assert.equal(host.view(view.id).running, false);
});

test('Pi extension commands take precedence over templates and can start model tasks', async (t) => {
  const { fixture, host } = await setup(t);
  await mkdir(join(fixture.agentDir, 'prompts'));
  await writeFile(join(fixture.agentDir, 'prompts', 'qa-run.md'), 'TEMPLATE_SHOULD_NOT_RUN');
  const view = await host.create(fixture.project, true);
  await host.send(view.id, '/qa-run', [], []);
  assert.equal(fixture.state.requests, 2);
  assert.ok(JSON.stringify(fixture.state.toolResults).includes('QA_HOOK_RESULT'));
  assert.ok(!JSON.stringify(fixture.state.payloads).includes('TEMPLATE_SHOULD_NOT_RUN'));
  await assert.rejects(host.send(view.id, '/qa-error', [], []), /QA_COMMAND_FAILED/);
  assert.match(host.view(view.id).error, /QA_COMMAND_FAILED/);
  assert.equal(host.view(view.id).running, false);
});

test('Pi extension runtime errors are visible and deletion cancels commands before shutdown', async (t) => {
  const { fixture, host } = await setup(t);
  await writeFile(join(fixture.agentDir, 'extensions', 'error.ts'), `export default (pi) => pi.on('session_start', () => { throw new Error('QA_EVENT_FAILED'); });`);
  const view = await host.create(fixture.project, true);
  assert.match(view.warning, /QA_EVENT_FAILED/);
  const pending = host.send(view.id, '/qa-wait', [], []);
  await until(async () => (await readFile(join(fixture.project, 'extension-events.log'), 'utf8')).includes('waiting'));
  await host.delete(view.id);
  await pending;
  const events = await readFile(join(fixture.project, 'extension-events.log'), 'utf8');
  assert.ok(events.indexOf('cancelled') < events.indexOf('shutdown'));
  assert.ok(!(await host.list()).some((entry) => entry.id === view.id));
});

test('Pi extension nested calls retain built-in read-only permissions', async (t) => {
  const { fixture, host } = await setup(t);
  const view = await host.create(fixture.project, true);
  await host.setPermission(view.id, 'read-only');
  await host.send(view.id, 'EXTENSION_TOOL_NESTED', [], []);
  assert.ok(JSON.stringify(fixture.state.toolResults).includes('NESTED_ERROR=true'));
  await assert.rejects(readFile(join(fixture.project, 'nested.txt')), { code: 'ENOENT' });
  await host.setPermission(view.id, 'workspace');
  await host.send(view.id, 'EXTENSION_TOOL_NESTED', [], []);
  assert.ok(JSON.stringify(fixture.state.toolResults).includes('NESTED_ERROR=false'));
  assert.equal(await readFile(join(fixture.project, 'nested.txt'), 'utf8'), 'NESTED_WRITE');
});

test('extension optional lifecycle listeners do not warn; turn boundaries and settled report real state', async (t) => {
  const { fixture, host } = await setup(t);
  await writeFile(join(fixture.agentDir, 'extensions', 'lifecycle.ts'), `
    export default (pi) => {
      for (const name of ['session_tree', 'session_before_switch', 'session_compact', 'session_before_compact'])
        pi.on(name, () => pi.appendEntry('unexpected-event', { name }));
      pi.on('turn_end', (event) => {
        if (!event.messageEntryId || !event.context.contextEntries.length) throw new Error('MISSING_BOUNDARY_CONTEXT');
        pi.appendEntry('qa-turn', { turn: event.turnIndex, messageId: event.messageEntryId });
      });
      pi.on('agent_settled', (event, ctx) => pi.appendEntry('qa-settled', { idle: ctx.isIdle(), aborted: event.aborted }));
      pi.on('model_select', (event) => pi.appendEntry('qa-model', { id: event.model.id, source: event.source }));
      pi.registerShortcut('ctrl+shift+s', { description: 'QA shortcut', handler: ctx => pi.appendEntry('qa-shortcut', { text: ctx.ui.theme.fg('accent', 'QA') }) });
    }
  `);
  const view = await host.create(fixture.project, true);
  assert.equal(view.warning, null);
  await host.send(view.id, 'EXTENSION_TOOL', [], []);
  const entries = host.entries.get(view.id).manager.getEntries();
  assert.equal(entries.filter((item) => item.customType === 'qa-turn').length, 2);
  assert.deepEqual(entries.find((item) => item.customType === 'qa-settled').data, { idle: true, aborted: false });
  assert.ok(!entries.some((item) => item.customType === 'unexpected-event'));
  assert.ok(!host.view(view.id).warning?.includes('MISSING_BOUNDARY_CONTEXT'));
  await host.setModel(view.id, 'test-provider', 'fixture-agent');
  assert.ok(host.entries.get(view.id).manager.getEntries().some((item) => item.customType === 'qa-model' && item.data.source === 'set'));
  assert.ok(host.view(view.id).shortcuts.some((item) => item.key === 'ctrl+shift+s'));
  await host.shortcut(view.id, 'ctrl+shift+s');
  assert.ok(host.entries.get(view.id).manager.getEntries().some((item) => item.customType === 'qa-shortcut'));
  await assert.rejects(host.shortcut(view.id, 'ctrl+unknown'), /快捷键/);
  const waiting = host.send(view.id, 'WAIT_FOR_STOP', [], []);
  await until(() => fixture.state.waiting > 0);
  await host.stop(view.id);
  await waiting;
  const settled = host.entries.get(view.id).manager.getEntries().filter((item) => item.customType === 'qa-settled');
  assert.equal(settled.length, 2);
  assert.deepEqual(settled[1].data, { idle: true, aborted: true });
});

test('extension session_before_fork can cancel without creating or changing sessions', async (t) => {
  const { fixture, host } = await setup(t);
  await writeFile(join(fixture.agentDir, 'extensions', 'cancel-fork.ts'), `export default pi => pi.on('session_before_fork', () => ({ cancel: true }));`);
  const view = await host.create(fixture.project, true);
  await host.send(view.id, 'CONTINUE_SESSION', [], []);
  const before = await host.list();
  await assert.rejects(host.fork(view.id), /扩展.*取消/);
  assert.deepEqual((await host.list()).map((item) => item.id), before.map((item) => item.id));
});

test('extension boundary drafts use SDK projection and request exactly one continuation', async (t) => {
  const { fixture, host } = await setup(t);
  await writeFile(join(fixture.agentDir, 'extensions', 'continue.ts'), `
    export default pi => {
      let continued = false;
      pi.on('turn_end', event => {
        if (continued) return;
        continued = true;
        return { entries: [{ type: 'custom_message', customType: 'qa-next', content: 'BOUNDARY_CONTINUATION', display: true }], continue: true };
      });
    }
  `);
  const view = await host.create(fixture.project, true);
  await host.send(view.id, 'CONTINUE_SESSION', [], []);
  assert.equal(fixture.state.requests, 2);
  assert.ok(JSON.stringify(fixture.state.payloads[1]).includes('BOUNDARY_CONTINUATION'));
  assert.ok(host.entries.get(view.id).manager.getEntries().some((item) => item.customType === 'qa-next'));
});
