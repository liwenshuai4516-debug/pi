import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { setupFixture, until } from '../support/fixture.mjs';

test('session rename, branch and delete persist without replay or changing the source', async (t) => {
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
  const empty = await host.create(fixture.project, true);
  await assert.rejects(host.rename(empty.id, '   '), /名称/);
  await assert.rejects(host.rename(empty.id, 'x'.repeat(121)), /名称/);
  await host.rename(empty.id, '  未发送的会话  ');
  assert.equal(host.view(empty.id).name, '未发送的会话');
  await assert.rejects(host.fork(empty.id), /暂无已保存/);
  await host.delete(empty.id);
  assert.ok(!(await host.list()).some((item) => item.id === empty.id));
  await assert.rejects(
    host.open(empty.id, async () => true),
    /不存在/,
  );
  const original = await host.create(fixture.project, true);
  await host.send(original.id, 'WRITE_FIXTURE', [], []);
  await host.rename(original.id, '  原始任务  ');
  const sourcePath = host.entries.get(original.id).manager.getSessionFile();
  const sourceBytes = await readFile(sourcePath, 'utf8');
  const written = await stat(fixture.outputPath);
  const requests = fixture.state.requests;
  const forkId = await host.fork(original.id);
  assert.notEqual(forkId, original.id);
  assert.equal(await readFile(sourcePath, 'utf8'), sourceBytes);
  assert.equal(host.view(original.id).name, '原始任务');
  const branch = await host.open(forkId, async () => true);
  assert.match(branch.name, /^原始任务 · 分支/);
  assert.deepEqual(branch.messages, host.view(original.id).messages);
  assert.deepEqual(branch.model, host.view(original.id).model);
  assert.equal(fixture.state.requests, requests);
  assert.equal((await stat(fixture.outputPath)).mtimeMs, written.mtimeMs);
  await host.send(forkId, 'BRANCH_ONLY', [], []);
  assert.ok(!JSON.stringify(host.view(original.id).messages).includes('BRANCH_ONLY'));
  await host.dispose();
  host = new AgentHost(
    () => {},
    () => {},
    fixture.agentDir,
  );
  // 尚未打开的历史也可改名、分支和删除，不需要启动 Agent。
  await host.rename(original.id, '重启后改名');
  const secondFork = await host.fork(original.id);
  assert.equal((await host.open(original.id, async () => true)).name, '重启后改名');
  await host.delete(original.id);
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  assert.ok((await host.list()).some((item) => item.id === forkId));
  await host.delete(secondFork);
  const restored = await host.open(forkId, async () => true);
  assert.ok(JSON.stringify(restored.messages).includes('BRANCH_ONLY'));
  await host.send(forkId, 'AFTER_SOURCE_DELETE', [], []);
  for (const id of ['unknown-id', '/tmp/forged-session.jsonl']) {
    await assert.rejects(host.rename(id, 'test'), /不存在/);
    await assert.rejects(host.fork(id), /不存在/);
    await assert.rejects(host.delete(id), /不存在/);
  }
});

test(
  'running session branch snapshots completed messages; deletion waits for cancellation',
  { timeout: 30000 },
  async (t) => {
    const fixture = await setupFixture();
    const host = new AgentHost(
      () => {},
      () => {},
      fixture.agentDir,
    );
    t.after(async () => {
      await host.dispose();
      fixture.close();
    });
    const source = await host.create(fixture.project, true);
    await host.send(source.id, 'FIRST_TURN', [], []);
    const pending = host.send(source.id, 'WAIT_FOR_STOP', [], []);
    await until(() => fixture.state.waiting > 0);
    await host.rename(source.id, '运行中的会话');
    const requests = fixture.state.requests;
    const branchId = await host.fork(source.id);
    const branch = await host.open(branchId, async () => true);
    assert.equal(fixture.state.requests, requests);
    assert.equal(fixture.state.aborted, 0);
    assert.equal(host.view(source.id).running, true);
    assert.ok(!JSON.stringify(branch.messages).includes('正在等待'));
    const path = host.entries.get(source.id).manager.getSessionFile();
    await host.delete(source.id);
    await pending;
    await until(() => fixture.state.aborted > 0);
    assert.equal(host.active, false);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.ok(!(await host.list()).some((item) => item.id === source.id));
    await host.send(branchId, 'CONTINUE_SNAPSHOT', [], []);
    const toolRun = host.send(branchId, 'LONG_BASH', [], []);
    await until(() =>
      host
        .view(branchId)
        .tools.some((tool) => tool.name === 'bash' && tool.output.includes('BASH_RUNNING')),
    );
    const pid = Number(await readFile(fixture.pidPath, 'utf8'));
    const deletion = host.delete(branchId);
    await assert.rejects(host.send(branchId, 'RACE_WITH_DELETE', [], []), /正在处理/);
    await deletion;
    await toolRun;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(host.active, false);
  },
);

// 验证请求参数和真实工具结果，不能只检查思考/权限下拉框的文字。
