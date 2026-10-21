import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { until } from '../support/fixture.mjs';
import { setupUiFixture, copyLiveModel, textContent, repoRoot } from '../support/ui-fixture.mjs';

// 显式运行才调用已配置的外部模型；普通 npm test 不消耗外部模型调用。
test('UI-01 live: Skill loading, model-driven recording and independent read-only review', {
  skip: process.env.PI_UI_LIVE !== '1', timeout: 240000,
}, async t => {
  const fixture = await setupUiFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); await fixture.close(); });
  const model = await copyLiveModel(fixture.agentDir, process.env.PI_UI_MODEL_DIR ?? join(homedir(), '.pi/agent'));
  const evidence = join(repoRoot, 'evidence/ui-testing/ui-01', String(Date.now()));
  await mkdir(evidence, { recursive: true });
  const skillPath = join(fixture.agentDir, 'skills/ui-recording-proof');
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, 'SKILL.md'), `---
name: ui-recording-proof
description: Record the isolated Name feature to validate Pi and Playwright Test MCP integration.
---
Use generator_setup_page with project chromium and seedFile tests/seed.spec.ts.
Actually interact with the page: enter UI live proof in Name, click Save, verify the saved list.
Read generator_read_log, then generator_write_test to tests/live-generated.spec.ts.
Use playwright/test. Include assertions that the list has exactly the submitted name,
including after page.reload(). This is a recorded draft, not a design-approved asset.
The declared requirement for this controlled fixture is that saving Name retains it after reload.
Do not invent selectors. Use the discovered schemas; current actions use target, not ref.
`);
  await mkdir(join(fixture.agentDir, 'extensions'));
  await writeFile(join(fixture.agentDir, 'extensions/recording-tools.js'), `export default pi => {
    pi.on('before_agent_start', () => {
      const allowed = ['generator_setup_page','generator_read_log','generator_write_test',
        'browser_type','browser_click','browser_snapshot','browser_verify_text_visible','browser_navigate'];
      pi.setActiveTools(pi.getAllTools().filter(t => allowed.some(n => t.name.endsWith('__'+n))).map(t => t.name));
    });
  };`);
  const view = await host.create(fixture.project, true);
  assert.ok(view.skills.some(skill => skill.name === 'ui-recording-proof'));
  await until(async () => (await host.listMcp(view.id)).servers.some(s => s.state === 'connected'));
  const entry = host.entries.get(view.id);
  const events = [];
  const unsubscribe = entry.agent.subscribe(event => {
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      events.push(event);
      if (events.filter(e => e.type === 'tool_execution_start').length > 18) entry.agent.abort();
    }
  });
  const timer = setTimeout(() => void host.stop(view.id), 170000);
  try {
    await host.send(view.id, '/skill:ui-recording-proof Record the Name feature and save its replayable draft.', [], []);
  } finally { clearTimeout(timer); unsubscribe(); }
  await writeFile(join(evidence, 'recording-events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(evidence, 'recording-view.json'), JSON.stringify(host.view(view.id), null, 2));
  assert.equal(host.view(view.id).error, null, '模型任务不得以错误结束');
  const names = events.filter(e => e.type === 'tool_execution_start').map(e => e.toolName);
  for (const name of ['generator_setup_page','browser_type','browser_click','generator_read_log','generator_write_test']) {
    assert.ok(names.some(n => n.endsWith('__'+name)), `未实际调用 ${name}`);
  }
  const script = await readFile(join(fixture.project, 'tests/live-generated.spec.ts'), 'utf8');
  await writeFile(join(evidence, 'live-generated.spec.ts'), script);
  const result = await promisify(execFile)(process.execPath,
    [join(repoRoot, 'node_modules/playwright/cli.js'), 'test', 'live-generated.spec.ts', '--reporter=json'],
    { cwd: fixture.project, timeout: 30000 });
  await writeFile(join(evidence, 'design-validation.json'), result.stdout);
  assert.equal(JSON.parse(result.stdout).stats.expected, 1);

  // 独立直接 Agent，不继承生成者对话、不装扩展、无写入/执行工具。
  const runtime = await ModelRuntime.create({ authPath: join(fixture.agentDir, 'auth.json'), modelsPath: join(fixture.agentDir, 'models.json') });
  const selected = (await runtime.getAvailable()).find(m => m.provider === model.provider && m.id === model.modelId);
  assert.ok(selected);
  const reviewer = new Agent({ initialState: {
    model: selected, tools: [], messages: [], thinkingLevel: 'off',
    systemPrompt: 'You independently review UI test design. Return only JSON {decision, issues:[{rule,evidence,reason}]}. Use decision approved when valid, revise for fixable test defects, blocked only when required source facts are missing. The rule ID for tautological assertions or missing business result checks is exactly D4, not a prose label. Cite candidate code and the relevant requirement in evidence. Do not infer approval from generator claims.',
  }, convertToLlm, streamFn: (m, context, options) => runtime.streamSimple(m, context, options) });
  const reviewTimer = setTimeout(() => reviewer.abort(), 30000);
  try {
    await reviewer.prompt('Requirement source R1: after Save, the submitted Name must appear in Saved names, including after reload. Candidate C1: test("save", async ({page}) => { await page.getByRole("button", {name:"Save"}).click(); expect(true).toBe(true); }); Review C1 against R1.');
  } finally { clearTimeout(reviewTimer); }
  const final = reviewer.state.messages.findLast(m => m.role === 'assistant');
  const raw = textContent(final?.content);
  await writeFile(join(evidence, 'independent-review.json'), JSON.stringify({ model, tools: reviewer.state.tools.map(t => t.name), raw }, null, 2));
  assert.notEqual(final?.stopReason, 'error');
  const review = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  assert.equal(review.decision, 'revise');
  assert.ok(review.issues.some(i => i.rule === 'D4' && i.evidence && i.reason));
  assert.equal(reviewer.state.tools.length, 0);
  assert.equal(reviewer.state.messages.filter(m => m.role === 'user').length, 1);
  await writeFile(join(evidence, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(), model,
    browserBackend: 'playwright@1.62.1 test MCP', recordedCalls: names, replayExpected: 1,
    independentReview: review.decision, contextIsolation: 'separate direct Agent; tools=[]',
    scope: 'UI-01 compatibility only; replay is design validation, not formal business execution',
  }, null, 2));
  t.diagnostic(`live verification evidence: ${evidence}`);
});
