import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ArtifactStore, assetDigest, sha256 } from '../../packages/ui-testing/dist/index.js';
import { artifact, scope, cases, designReview } from '../support/ui-artifacts.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-ui-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  const source = { path: 'requirements.md', sha256: sha256('Name persists') };
  await writeFile(join(root, source.path), 'Name persists');
  const s = scope(); s.data.sources[0].ref = source;
  const scopeRef = await store.put(s);
  const rules = await store.putFile('qa/ui/cases/cases-1/data-rules.json', '{}');
  const c = cases(); c.data.scope_ref = scopeRef; c.data.sources = s.data.sources; c.data.data_rules_ref = rules;
  const casesRef = await store.put(c);
  const file = await store.putFile('qa/ui/assets/name/revisions/v1/tests/name.spec.ts', '// real script placeholder');
  const helper = await store.putFile('qa/ui/assets/name/revisions/v1/helpers/data.ts', '// shared fixture');
  const asset = artifact('asset', { revision: 'v1', module_ids: ['names'], scope_ref: scopeRef,
    cases_ref: casesRef, recording_refs: [], files: [file, helper], dependencies: [{ name: 'playwright', version: '1.62.1' }],
    readiness: 'design-only', content_sha256: 'a'.repeat(64), gaps: [] }, 'name');
  asset.data.content_sha256 = assetDigest(asset);
  const assetRef = await store.put(asset);
  const task = artifact('task', { intent: 'execute', scope_ref: scopeRef, state: 'pending', stage: 'execute',
    completed_stages: ['discover-record', 'case-design', 'design-review'], input_sha256: sha256('frozen input'),
    asset_refs: [assetRef], run_ids: [], output_refs: [], blockers: [] });
  const taskRef = await store.put(task);
  const run = artifact('run', { task_id: task.id, request_id: 'request-1', asset_ref: assetRef,
    environment_id: 'test', deployment_version: 'v1', role: 'tester',
    plan: [{ instance_id: 'C1-v1', case_id: 'C1', revision: 'v1', data_row_id: 'default', browser_project: 'chromium' }],
    state: 'pending', command: ['playwright', 'test'], process_token: 'token-1', output_refs: [] });
  return { root, store, asset, assetRef, file, helper, task, taskRef, run };
}

test('immutable assets and reviews survive a new process; catalog is rebuildable', async t => {
  const { root, store, asset, assetRef } = await setup(t);
  const review = designReview(); review.data.subject_ref = assetRef; review.data.subject_sha256 = assetRef.sha256;
  review.data.raw_ref = await store.putFile('qa/ui/assets/name/revisions/v1/reviews/design-review-1/raw.json', '{}');
  const reviewRef = await store.put(review);
  assert.equal((await new ArtifactStore(root).load(reviewRef)).data.decision, 'approved');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/ui-testing/dist/index.js')).href;
  const script = `import {ArtifactStore} from ${JSON.stringify(moduleUrl)}; const a=await new ArtifactStore(process.argv[1]).load(JSON.parse(process.argv[2])); console.log(a.id);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(assetRef)], { encoding: 'utf8' }).trim(), 'name');
  assert.deepEqual(await store.put(asset), assetRef);
  const changed = structuredClone(asset); changed.data.gaps.push('changed'); changed.data.content_sha256 = assetDigest(changed);
  await assert.rejects(store.put(changed), /不可覆盖/);
  await rm(join(root, 'qa/ui/catalog.json'));
  const rebuilt = await store.reindex();
  assert.ok(rebuilt.records.some(r => r.ref.sha256 === assetRef.sha256));
  assert.ok(rebuilt.records.some(r => r.ref.sha256 === reviewRef.sha256));
  await writeFile(join(root, 'qa/ui/catalog.json'), 'broken');
  assert.equal((await store.reindex()).invalid.length, 0);
});

test('scripts and shared fixtures are hash checked, immutable and contained', async t => {
  const { root, store, assetRef, file, helper } = await setup(t);
  await assert.rejects(store.putFile(file.path, 'changed'), /不可覆盖/);
  for (const dep of [file, helper]) {
    const old = await readFile(join(root, dep.path));
    await writeFile(join(root, dep.path), 'corrupted');
    await assert.rejects(store.load(assetRef), /摘要不匹配/);
    await writeFile(join(root, dep.path), old);
  }
  await assert.rejects(store.putFile('qa/ui/../outside', 'bad'), /相对路径/);
  await assert.rejects(store.putFile('qa/ui/tasks/task-1/requests/r.json', '{}'), /元数据/);
  await assert.rejects(store.putFile('qa/ui/assets/name/bad/file', 'bad'), /元数据/);
  await symlink(tmpdir(), join(root, 'qa/ui/recordings'));
  await assert.rejects(store.putFile('qa/ui/recordings/r1/log.json', '{}'), /符号链接/);
});

test('interrupted multipart writes and malformed objects remain visible but not loadable', async t => {
  const { root, store } = await setup(t);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/ui-testing/dist/index.js')).href;
  const script = `import {ArtifactStore} from ${JSON.stringify(moduleUrl)}; await new ArtifactStore(process.argv[1]).putFile('qa/ui/recordings/half/log.json','{}'); process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, root]);
  await mkdir(join(root, 'qa/ui/scopes/broken'), { recursive: true });
  await writeFile(join(root, 'qa/ui/scopes/broken/manifest.json'), '{');
  const index = await store.reindex();
  assert.ok(index.incomplete.includes('qa/ui/recordings/half'));
  assert.ok(index.invalid.some(r => r.path.endsWith('broken/manifest.json')));
  await assert.rejects(store.load({ path: 'qa/ui/recordings/half/manifest.json', sha256: sha256('{}') }), /未完成/);
});

test('concurrent duplicate launch reserves exactly one batch and freezes launch input', async t => {
  const { root, store, run } = await setup(t);
  const outcomes = await Promise.all([store.reserveRun(run), new ArtifactStore(root).reserveRun(run)]);
  assert.equal(outcomes.filter(r => r.created).length, 1);
  assert.deepEqual(outcomes[0].ref, outcomes[1].ref);
  const changed = structuredClone(run); changed.data.deployment_version = 'v2';
  await assert.rejects(store.reserveRun(changed), /输入不能变化/);
  const another = structuredClone(run); another.id = 'run-2'; another.data.request_id = 'request-2';
  await assert.rejects(store.reserveRun(another), /活跃/);
  const runningRef = await store.markRunStarted(outcomes[0].ref, process.pid, 'token-1');
  await assert.rejects(store.markRunStarted(outcomes[0].ref, process.pid, 'token-1'), /摘要不匹配/);
  assert.equal((await store.reserveRun(run)).created, false);
  const terminal = await store.finishRun(runningRef, 1, []);
  assert.equal((await store.load(terminal)).data.exit_code, 1);
  await assert.rejects(store.finishRun(terminal, 0, []), /终结/);
  assert.equal((await store.reserveRun(another)).created, true);
});

test('unknown interruption and orphan launch intent block repeat execution', async t => {
  const { root, store, run } = await setup(t);
  const reserved = await store.reserveRun(run);
  const terminal = await store.finishRun(reserved.ref, null, [], true);
  assert.equal((await store.load(terminal)).data.state, 'interrupted');
  const another = structuredClone(run); another.id = 'run-2'; another.data.request_id = 'request-2';
  await assert.rejects(store.reserveRun(another), /活跃或状态未核对/);
  // 模拟进程在写启动意图后、提交批次 manifest 前中断。
  await rm(join(root, terminal.path));
  await assert.rejects(store.reserveRun(another), /活跃或状态未核对/);
});

test('task updates require current version and preserve frozen inputs and completed stages', async t => {
  const { store, task, taskRef } = await setup(t);
  const next = structuredClone(task); next.data.state = 'running';
  const current = await store.updateTask(taskRef, next);
  await assert.rejects(store.updateTask(taskRef, next), /摘要不匹配/);
  const bad = structuredClone(next); bad.data.completed_stages = [];
  await assert.rejects(store.updateTask(current, bad), /回退/);
  const changed = structuredClone(next); changed.data.intent = 'record';
  await assert.rejects(store.updateTask(current, changed), /输入/);
  next.data.state = 'completed';
  const done = await store.updateTask(current, next);
  next.data.state = 'running';
  await assert.rejects(store.updateTask(done, next), /终态/);
});
