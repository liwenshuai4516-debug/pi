import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { saveModelConfig, validateModelConfig } from '../../dist/main/models/model-config.js';
import { setupFixture } from '../support/fixture.mjs';

test('model configuration rejects invalid input and stores credentials separately', async (t) => {
  const fixture = await setupFixture();
  t.after(() => fixture.close());
  for (const input of [
    null,
    {},
    { provider: '__proto__', modelId: 'x', baseUrl: 'https://x.test', apiKey: 'test' },
    { provider: 'x', modelId: 'm', baseUrl: 'file:///tmp', apiKey: 'test' },
    { provider: 'x', modelId: 'm', baseUrl: fixture.baseUrl, apiKey: '' },
  ])
    assert.throws(() => validateModelConfig(input));
  const input = {
    provider: 'additional',
    modelId: 'second-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key-never-exported',
  };
  await saveModelConfig(fixture.agentDir, input);
  const modelsText = await readFile(join(fixture.agentDir, 'models.json'), 'utf8');
  assert.ok(!modelsText.includes(input.apiKey));
  const models = JSON.parse(modelsText);
  assert.ok(models.providers['test-provider']);
  assert.equal(models.providers.additional.models[0].id, input.modelId);
  const auth = JSON.parse(await readFile(join(fixture.agentDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth.additional, { type: 'api_key', key: input.apiKey });
  assert.equal((await stat(join(fixture.agentDir, 'auth.json'))).mode & 0o777, 0o600);
  const host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  t.after(() => host.dispose());
  assert.ok((await host.models()).some((model) => model.id === input.modelId));
});

// 模板由客户端展开后交给 Agent；验证 Pi 原有的引用、默认值和切片语义。

test('request model and identity context follow selection and restored history', async (t) => {
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
  const view = await host.create(fixture.project, true);
  await host.send(view.id, '你是什么模型？', [], []);
  const systemText = (payload) =>
    payload.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => JSON.stringify(message.content))
      .join('\n');
  const first = fixture.state.payloads.at(-1);
  assert.equal(first.model, 'fixture-agent');
  assert.doesNotMatch(systemText(first), /You are Pi,/);
  assert.match(systemText(first), /Configured provider: test-provider/);
  assert.match(systemText(first), /Configured model ID: fixture-agent/);
  await saveModelConfig(fixture.agentDir, {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-only',
  });
  await host.setModel(view.id, 'deepseek', 'deepseek-v4-pro');
  await host.send(view.id, '现在用的是什么模型？', [], []);
  const switched = fixture.state.payloads.at(-1);
  assert.equal(switched.model, 'deepseek-v4-pro');
  assert.match(systemText(switched), /Configured provider: deepseek/);
  assert.match(systemText(switched), /Configured model ID: deepseek-v4-pro/);
  assert.doesNotMatch(systemText(switched), /Configured model ID: fixture-agent/);
  // 旧会话可能包含先前的身份提示，恢复后仍应传入当前选择，且不能改写用户历史。
  host.entries.get(view.id).manager.appendMessage({
    role: 'system',
    content: 'You are Pi, a coding assistant.',
    timestamp: Date.now(),
  });
  await host.dispose();
  host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  const restored = await host.open(view.id, async () => true);
  assert.equal(restored.model.id, 'deepseek-v4-pro');
  await host.send(view.id, '继续确认模型', [], []);
  const continued = fixture.state.payloads.at(-1);
  assert.equal(continued.model, 'deepseek-v4-pro');
  assert.match(systemText(continued), /Configured model ID: deepseek-v4-pro/);
  assert.match(systemText(continued), /Pi Agent is the desktop client name/);
});

// 会话管理只操作 SDK 历史；分支和恢复不得重放模型请求或工具。
