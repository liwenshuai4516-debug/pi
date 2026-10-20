import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { setupFixture } from '../support/fixture.mjs';

test('slash candidates reflect loaded commands, Skills, templates, native argument completions and config', async (t) => {
  const fixture = await setupFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); fixture.close(); });
  for (const folder of ['extensions', 'prompts', 'skills/slash-qa']) await mkdir(join(fixture.agentDir, folder), { recursive: true });
  await writeFile(join(fixture.agentDir, 'skills/slash-qa/SKILL.md'), '---\nname: slash-qa\ndescription: 接口回归测试\n---\nSLASH_SKILL_PROOF\n');
  await writeFile(join(fixture.agentDir, 'prompts/review.md'), '---\ndescription: 被同名扩展命令覆盖\n---\nTEMPLATE_SHOULD_NOT_WIN\n');
  await writeFile(join(fixture.agentDir, 'prompts/check.md'), '---\ndescription: 检查清单\n---\n检查 $ARGUMENTS\n');
  await writeFile(join(fixture.agentDir, 'extensions/qa.js'), `export default pi => {
    pi.registerCommand('review', {description: '真实评审命令', handler: () => {}});
    pi.registerCommand('args', {
      getArgumentCompletions: async prefix => prefix === 'bad' ? Promise.reject(new Error('COMPLETION_FAILED')) : [{value: 'selected ', label: '<selected>', description: '参数:' + prefix}],
      handler: () => {},
    });
  };`);
  const view = await host.create(fixture.project, true);
  const all = await host.complete(view.id, '/');
  assert.ok(all.some(item => item.value === '/mcp ' && item.kind === 'service'));
  assert.ok(all.some(item => item.value === '/skill:slash-qa ' && item.kind === 'skill'));
  assert.ok(all.some(item => item.value === '/check ' && item.kind === 'template'));
  assert.deepEqual(all.filter(item => item.value === '/review '), [{value: '/review ', label: '/review', description: '真实评审命令', kind: 'command'}]);
  assert.equal((await host.complete(view.id, '/回归'))[0].value, '/skill:slash-qa ');
  assert.deepEqual((await host.complete(view.id, '/mcp lo')).map(item => item.label), ['login', 'logout']);
  assert.deepEqual(await host.complete(view.id, '/args 真实前缀'), [{value: '/args selected ', label: '<selected>', description: '参数:真实前缀', kind: 'command'}]);
  await assert.rejects(host.complete(view.id, '/args bad'), /COMPLETION_FAILED/);
  assert.deepEqual(await host.complete(view.id, '/unknown'), []);
  assert.deepEqual(await host.complete(view.id, '普通对话 /review'), []);
  assert.deepEqual(await host.complete(view.id, '/skill:slash-qa 普通任务'), []);
  assert.equal(fixture.state.requests, 0, 'completion must not send a model request');
  const settingsPath = join(fixture.agentDir, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({...settings, enableSkillCommands: false}));
  const disabled = await host.create(fixture.project, true);
  assert.ok(!(await host.complete(disabled.id, '/')).some(item => item.kind === 'skill'));
  assert.ok((await host.complete(view.id, '/')).some(item => item.kind === 'skill'), 'existing sessions keep their resource snapshot');
});
