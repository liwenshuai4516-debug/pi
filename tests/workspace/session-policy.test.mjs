import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { saveModelConfig } from '../../dist/main/models/model-config.js';
import { setupFixture, until } from '../support/fixture.mjs';

test('thinking effort and workspace permission affect real requests/tools and survive restart', async (t) => {
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
  await saveModelConfig(fixture.agentDir, {
    provider: 'test-provider',
    modelId: 'fixture-agent',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-only',
    reasoning: true,
  });
  const first = await host.create(fixture.project, true);
  assert.ok(first.thinkingLevels.includes('high'));
  host.setThinking(first.id, 'high');
  await host.send(first.id, 'THINK_HIGH', [], []);
  assert.equal(fixture.state.payloads.at(-1).reasoning_effort, 'high');
  host.setThinking(first.id, 'off');
  await host.send(first.id, 'THINK_OFF', [], []);
  assert.ok(
    !fixture.state.payloads.at(-1).reasoning_effort ||
      fixture.state.payloads.at(-1).reasoning_effort === 'none',
  );
  await host.setPermission(first.id, 'read-only');
  await host.send(first.id, 'WRITE_FIXTURE', [], []);
  assert.ok(
    host.view(first.id).tools.some((tool) => tool.status === 'error' && /只读/.test(tool.output)),
  );
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
  await host.setPermission(first.id, 'workspace');
  await host.send(first.id, 'WRITE_FIXTURE', [], []);
  assert.equal(await readFile(fixture.outputPath, 'utf8'), 'Written by real Pi Agent SDK\n');
  host.setThinking(first.id, 'high');
  await host.setPermission(first.id, 'read-only');
  const other = await host.create(fixture.project, true);
  assert.equal(other.permission, 'workspace');
  const pending = host.send(first.id, 'WAIT_FOR_STOP', [], []);
  await until(() => fixture.state.waiting > 0);
  await assert.rejects(host.setPermission(first.id, 'full-access'), /运行时/);
  assert.throws(() => host.setThinking(first.id, 'off'), /运行时/);
  await host.stop(first.id);
  await pending;
  const requests = fixture.state.requests;
  await host.dispose();
  host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  const restored = await host.open(first.id, async () => true);
  assert.equal(restored.permission, 'read-only');
  assert.equal(restored.thinking, 'high');
  assert.equal(fixture.state.requests, requests);
  await assert.rejects(host.setPermission(first.id, 'forged'), /权限/);
  // 更新能力标记保留既有模型字段；关闭能力后恢复时不能发送不支持的思考级别。
  await saveModelConfig(fixture.agentDir, {
    provider: 'test-provider',
    modelId: 'fixture-agent',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-only',
    reasoning: false,
  });
  await host.setModel(first.id, 'test-provider', 'fixture-agent');
  assert.equal(host.view(first.id).thinking, 'off');
  assert.deepEqual(host.view(first.id).thinkingLevels, ['off']);
});
