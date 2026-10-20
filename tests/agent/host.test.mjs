import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { saveModelConfig } from '../../dist/main/models/model-config.js';
import { setupFixture, until } from '../support/fixture.mjs';

test(
  'real SDK: streaming, tool execution, cancellation, independent sessions and persisted continuation',
  { timeout: 60000 },
  async (t) => {
    const fixture = await setupFixture();
    const views = [];
    let host = new AgentHost(
      (view) => views.push(view),
      () => {},
      fixture.agentDir,
    );
    t.after(async () => {
      await host.dispose();
      fixture.close();
    });
    const models = await host.models();
    assert.ok(models.some((model) => model.id === 'fixture-agent'));
    const first = await host.create(fixture.project, true);
    assert.equal(first.model.id, 'fixture-agent');
    assert.ok(
      host.entries.get(first.id).agent instanceof Agent,
      '客户端必须直接持有 pi-agent-core Agent',
    );
    assert.equal(host.entries.get(first.id).session, undefined, '不得由 AgentSession 代管执行');
    await host.send(first.id, 'WRITE_FIXTURE', [], []);
    assert.equal(await readFile(fixture.outputPath, 'utf8'), 'Written by real Pi Agent SDK\n');
    assert.ok(
      views.some(
        (view) => view.running && view.messages.some((message) => message.role === 'assistant'),
      ),
    );
    assert.ok(
      host.view(first.id).tools.some((tool) => tool.status === 'done' && tool.name === 'write'),
    );
    assert.ok(
      fixture.state.toolResults.length > 0,
      'SDK feeds actual tool result back to provider',
    );
    assert.equal(host.view(first.id).running, false);
    const second = await host.create(fixture.project, true);
    assert.notEqual(first.id, second.id);
    assert.equal(host.view(second.id).messages.length, 0);
    await host.send(first.id, 'CONTINUE_SESSION', [], []);
    assert.ok(JSON.stringify(host.view(first.id).messages).includes('会话已继续'));
    const pending = host.send(first.id, 'WAIT_FOR_STOP', [], []);
    await until(() => fixture.state.waiting > 0);
    await assert.rejects(host.send(first.id, 'duplicate while running', [], []), /仍在运行/);
    await host.stop(first.id);
    await pending;
    await until(() => fixture.state.aborted > 0);
    assert.equal(host.active, false);
    assert.equal(host.view(first.id).running, false);
    const bashRun = host.send(first.id, 'LONG_BASH', [], []);
    await until(() =>
      host
        .view(first.id)
        .tools.some((tool) => tool.name === 'bash' && tool.output.includes('BASH_RUNNING')),
    );
    const toolPid = Number(await readFile(fixture.pidPath, 'utf8'));
    assert.ok(toolPid > 1);
    await host.stop(first.id);
    await bashRun;
    await until(() => {
      try {
        process.kill(toolPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(host.active, false);
    assert.ok(
      host.view(first.id).tools.some((tool) => tool.name === 'bash' && tool.status === 'error'),
    );
    const ids = (await host.list()).map((session) => session.id);
    assert.ok(ids.includes(first.id));
    const before = fixture.state.requests;
    await host.dispose();
    host = new AgentHost(
      () => {},
      () => {},
      fixture.agentDir,
    );
    const restored = await host.open(first.id, async () => true);
    assert.ok(JSON.stringify(restored.messages).includes('WRITE_FIXTURE'));
    assert.equal(fixture.state.requests, before, 'opening history must not replay the prompt');
    await host.send(first.id, 'AFTER_RESTART', [], []);
    assert.ok(JSON.stringify(host.view(first.id).messages).includes('AFTER_RESTART'));
  },
);

test('direct Agent: prompt templates and selected model survive restart', async (t) => {
  const fixture = await setupFixture();
  let host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  t.after(async () => {
    await host.dispose();
    fixture.close();
  });
  await mkdir(join(fixture.agentDir, 'prompts'));
  await writeFile(
    join(fixture.agentDir, 'prompts', 'review.md'),
    '$1 | ${2:-default} | ${@:2} | $ARGUMENTS',
  );
  const view = await host.create(fixture.project, true);
  assert.ok(view.templates.some((item) => item.name === 'review'));
  await host.send(view.id, '/review "hello world" tail', [], []);
  assert.ok(
    fixture.state.instructions.at(-1).includes('hello world | tail | tail | hello world tail'),
  );
  await saveModelConfig(fixture.agentDir, {
    provider: 'additional',
    modelId: 'second-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-only',
  });
  await host.setModel(view.id, 'additional', 'second-model');
  await assert.rejects(async () => host.setThinking(view.id, 'high'), /不支持/);
  await host.dispose();
  host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  const restored = await host.open(view.id, async () => true);
  assert.equal(restored.model.id, 'second-model');
  assert.equal(restored.model.provider, 'additional');
});

// 验证发往模型接口的真实请求，避免只检查界面标签而漏掉身份提示和请求模型不一致。
