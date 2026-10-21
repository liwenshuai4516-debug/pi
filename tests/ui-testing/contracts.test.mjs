import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateArtifact, validateCapabilityResult, verifyReferences, sha256 } from '../../packages/ui-testing/dist/index.js';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { setupFixture } from '../support/fixture.mjs';
import { scope, cases, designReview, ref } from '../support/ui-artifacts.mjs';
import { repoRoot, textContent } from '../support/ui-fixture.mjs';

test('UI-02: schema rejects unsupported versions, missing fields and inconsistent case/source links', () => {
  for (const item of [scope(), cases(), designReview()]) assert.equal(validateArtifact(item).id, item.id);
  const reject = (mutate, category = 'invalid-input') => {
    const item = cases(); mutate(item);
    assert.throws(() => validateArtifact(item), e => e.category === category);
  };
  reject(item => item.schema_version = '2.0', 'incompatible-version');
  reject(item => delete item.data.cases[0].preconditions);
  reject(item => item.data.cases[0].assertions[0].source_id = 'invented');
  reject(item => item.data.cases[0].assertions[0].oracle_type = 'baseline');
  reject(item => item.data.cases[0].steps[0].assertion_ids = ['missing']);
  reject(item => item.data.cases.push(structuredClone(item.data.cases[0])));
  reject(item => item.data.scope_ref = ref('../outside.json'));
  reject(item => item.data.cases[0].assertions = []);
  reject(item => item.data.secret = 'not-in-contract');
});

test('UI-02: approval cannot hide blockers, omit rules or mix result/design rules', () => {
  const review = designReview();
  review.data.issues.push({ id: 'I1', rule: 'D4', reason: 'tautology', evidence_refs: [], fix_condition: 'Check saved data', blocking: true });
  assert.throws(() => validateArtifact(review), /阻断/);
  review.data.issues = [];
  review.data.checked_rules.pop();
  assert.throws(() => validateArtifact(review), /全部适用规则/);
  review.data.checked_rules.push('R6');
  assert.throws(() => validateArtifact(review), /类型不匹配/);
  review.data.checked_rules[0] = 'D99';
  assert.throws(() => validateArtifact(review), /pattern/);
});

test('UI-02: capability success differs from test passing and cannot carry hidden errors', () => {
  const result = { schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
    status: 'completed', artifact_refs: [], errors: [] };
  assert.equal(validateCapabilityResult(result).status, 'completed');
  result.errors.push({ category: 'invalid-input', message: 'bad input', recoverable: false });
  assert.throws(() => validateCapabilityResult(result), /状态与错误列表/);
  result.status = 'blocked';
  assert.equal(validateCapabilityResult(result).status, 'blocked');
});

test('UI-02: file references check existence, bytes and real path boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-contract-'));
  const outside = await mkdtemp(join(tmpdir(), 'ui-contract-outside-'));
  await writeFile(join(root, 'source.md'), 'requirement');
  const valid = { path: 'source.md', sha256: sha256('requirement') };
  await verifyReferences(root, valid);
  await assert.rejects(verifyReferences(root, { ...valid, path: 'missing.md' }), /不可读取/);
  await assert.rejects(verifyReferences(root, { ...valid, sha256: sha256('changed') }), /不匹配/);
  await writeFile(join(outside, 'secret.md'), 'outside');
  await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
  await assert.rejects(verifyReferences(root, { path: 'link.md', sha256: sha256('outside') }), /边界/);
  await writeFile(join(root, 'scope.json'), JSON.stringify({ ...scope(), data: { ...scope().data, sources: [] } }));
  const result = await promisify(execFile)(process.execPath,
    [join(repoRoot, 'packages/ui-testing/dist/cli.js'), 'validate', join(root, 'scope.json'), root]);
  assert.equal(JSON.parse(result.stdout).status, 'completed');
});

for (const source of ['packages/ui-testing', 'dist/packages/ui-testing']) {
test(`UI-02: Pi package installs and invokes its tool and Skill (${source})`, async t => {
  const fixture = await setupFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); fixture.close(); });
  const manager = new PluginManager(fixture.agentDir, fixture.project);
  await manager.install(join(repoRoot, source), 'package');
  const view = await host.create(fixture.project, true);
  assert.ok(view.skills.some(s => s.name === 'ui-artifact-check'));
  assert.ok(host.entries.get(view.id).agent.state.tools.some(t => t.name === 'ui_validate_artifact'));
  let called = false;
  fixture.state.respond = body => {
    if (!called) { called = true; return { tool: 'ui_validate_artifact', args: { artifact: { ...scope(), schema_version: '2.0' } } }; }
    const output = textContent(body.messages.filter(m => m.role === 'tool').at(-1)?.content);
    assert.match(output, /incompatible-version/);
    assert.match(output, /blocked/);
    return { text: 'Unsupported schema retained as blocked; no design approval.' };
  };
  await host.send(view.id, 'Validate this unsupported UI artifact.', [], []);
  if (fixture.state.responseError) throw fixture.state.responseError;
  assert.equal(called, true);
  fixture.state.respond = () => ({ text: 'Skill instructions received.' });
  await host.send(view.id, '/skill:ui-artifact-check Check contract only.', [], []);
  assert.match(fixture.state.instructions.at(-1), /结构通过不表示语义正确/);
});
}
