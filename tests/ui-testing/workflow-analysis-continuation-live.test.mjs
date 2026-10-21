import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArtifactStore, sha256 } from '../../packages/ui-testing/dist/index.js';
import { copyLiveModel, repoRoot } from '../support/ui-fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';

// 显式选择已保存批次，只补分析/评估；不重发原执行，不重置原 run 的评估预算。
test('UI-10 live: continue a blocked failure analysis using original trace events without replay', {
  skip: !process.env.PI_UI_ANALYSIS_CONTINUE, timeout: 660000,
}, async t => {
  const previous = process.env.PI_UI_ANALYSIS_CONTINUE;
  const saved = JSON.parse(await readFile(join(previous, 'failure.json'), 'utf8'));
  const executions = saved.results.filter(r => r.tool === 'ui_test_run').map(r => JSON.parse(r.text).output).filter(r => r?.run_ref);
  assert.equal(executions.length, 1);
  const original = executions[0], command = original.run.data.command;
  const root = command[command.indexOf('--config') + 1].split('/qa/ui/runs/')[0];
  const agentDir = join(dirname(root), 'agent'), store = new ArtifactStore(root);
  const run = await store.load(original.run_ref, false);
  const bytes = await Promise.all(run.data.output_refs.map(async ref => ({ ref, digest: sha256(await readFile(join(root, ref.path))) })));
  const evidence = join(previous, 'analysis-continuation', String(Date.now()));await mkdir(evidence, { recursive: true });
  const selected = await copyLiveModel(agentDir, join(homedir(), '.pi/agent'), { provider: process.env.PI_UI_PROVIDER, modelId: process.env.PI_UI_MODEL });
  t.after(async () => { await rm(join(agentDir, 'auth.json'), { force: true });await rm(join(agentDir, 'models.json'), { force: true }); });
  await new PluginManager(agentDir, root).install(join(repoRoot, 'packages/ui-testing'), 'package');
  const prompt = `Continue analysis only for original run ${JSON.stringify(original.run_ref)}. Create workflow mode analyze task live-failure-evidence. Read original evidence, old rejected reviews and current analysis/review Skills. Use read-trace for readable original events and cite the original trace ref, not shell-authored extracts. Save corrected analysis and report, independently review using the existing run authority/budget (only the remaining round; do not reset it), deliver only if approved and checkpoint the new analyze workflow. Preserve failed=1, unknown internal root cause and original results. Never execute, diagnose, record or change assets. If blocked, save the actual blocker and stop.`;
  const output = join(evidence, 'output.json');await writeFile(join(evidence, 'prompt.md'), prompt);
  try {
    await promisify(execFile)(process.execPath, [join(repoRoot, 'tests/support/ui-workflow-process.mjs'), agentDir, root, output, prompt],
      { cwd: repoRoot, timeout: 650000, maxBuffer: 1024 * 1024, env: { ...process.env, PI_UI_WORKFLOW_DEADLINE_MS: '600000', PI_UI_WORKFLOW_MAX_TOOLS: '100' } });
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.timed_out, false);assert.equal(result.stop_reason, 'stop');
    assert.ok(result.calls.every(name => !['ui_test_run', 'ui_design_diagnose', 'ui_design_review', 'ui_case_design', 'ui_discover_record'].includes(name)));
    assert.ok(result.tool_calls.some(c => c.name === 'ui_result_analysis' && c.arguments.request.operation === 'read-trace'));
    const index = await store.reindex(), task = await store.load(index.records.find(r => r.kind === 'task' && r.id === 'live-failure-evidence').ref, false);
    assert.equal(task.data.state, 'completed');
    const reviewRef = task.data.output_refs.find(r => r.path.includes('/reviews/'));
    const review = await store.load(reviewRef);
    assert.equal(review.data.round, 3);assert.equal(review.data.decision, 'approved');
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ passed: true, model: selected, run_ref: original.run_ref, review_ref: reviewRef, task, original_full_workflow_passed: false }, null, 2));
  } finally {
    for (const { ref, digest } of bytes) assert.equal(sha256(await readFile(join(root, ref.path))), digest);
    assert.equal(sha256(await readFile(join(root, original.run_ref.path))), original.run_ref.sha256);
    await cp(join(root, 'qa/ui'), join(evidence, 'qa/ui'), { recursive: true });
    t.diagnostic(`Continuation evidence: ${evidence}`);
  }
});
