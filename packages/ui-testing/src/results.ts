import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { posix, relative, resolve } from 'node:path';
import { ArtifactStore } from './store.js';
import { finalStates, type Artifact, type FileRef } from './contracts.js';
import { fileRefs, verifyReferences, workspacePath, WorkflowError } from './validation.js';

type Step = { title: string; error?: { message?: string }; steps?: Step[] };
type Attachment = { name?: string; path?: string; body?: string };
type Attempt = { retry: number; status: string; steps?: Step[]; errors?: { message?: string }[]; attachments?: Attachment[] };
type Test = { projectName: string; expectedStatus: string; results: Attempt[] };
type Spec = { title: string; file: string; tests: Test[] };
type Suite = { specs?: Spec[]; suites?: Suite[] };
export type NativeReport = { errors: unknown[]; suites: Suite[] };
type Issue = { rule: 'R1' | 'R2' | 'R3'; reason: string; instance_id?: string };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const flatten = (s: Suite): Spec[] => [...(s.specs ?? []), ...(s.suites ?? []).flatMap(flatten)];
const steps = (items: Step[]): Step[] => items.flatMap(s => [s, ...steps(s.steps ?? [])]);
const counts = () => Object.fromEntries(finalStates.map(status => [status, 0])) as Artifact<'results'>['data']['counts'];
function body(attachment: Attachment) {
  if (!attachment.body) return undefined;
  try { return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8')); } catch { return undefined; }
}

/** 解析只读取文件与原生 reporter，不发模型请求或浏览器操作。缺证据与业务终态分别保存。 */
export async function reconcileRun(root: string, runRef: FileRef) {
  root = await realpath(root);
  const store = new ArtifactStore(root), run = await store.load(runRef, false) as Artifact<'run'>;
  if (run.kind !== 'run') throw new WorkflowError('invalid-input', '结果解析必须引用正式 run');
  const base = posix.dirname(runRef.path), issues: Issue[] = [];
  const readable: FileRef[] = [], missing: { path: string; expected_sha256: string; reason: string }[] = [];
  for (const ref of run.data.output_refs) {
    try {
      if (!ref.path.startsWith(base + '/')) throw new Error('foreign-run');
      await verifyReferences(root, ref); readable.push(ref);
    } catch { missing.push({ path: ref.path, expected_sha256: ref.sha256, reason: '不存在、摘要不符或不属于本批次' }); }
  }
  const asset = await store.load(run.data.asset_ref, false) as Artifact<'asset'>;
  if (asset.kind !== 'asset') throw new WorkflowError('invalid-input', '批次缺少对应资产');
  const cases = await store.load(asset.data.cases_ref, false) as Artifact<'cases'>;
  for (const ref of [...new Map(fileRefs([asset, cases]).map(r => [r.path, r])).values()]) {
    try { await verifyReferences(root, ref); }
    catch { missing.push({ path: ref.path, expected_sha256: ref.sha256, reason: '原始脚本、配置或业务来源缺失/变更' }); }
  }
  const rawRef = readable.find(r => r.path === `${base}/report.json`);
  const summaryRef = readable.find(r => r.path === `${base}/execution-summary.json`);
  const preflightRef = readable.find(r => r.path === `${base}/preflight.json`);
  const readJson = async (ref: FileRef | undefined) => ref ? JSON.parse(await readFile(await workspacePath(root, ref.path), 'utf8')) : undefined;
  const summary = await readJson(summaryRef), preflight = await readJson(preflightRef);
  const request = await readJson(readable.find(r => r.path === `${base}/input.json`));
  let designReview: Artifact<'design-review'> | undefined;
  if (request?.review_ref) {
    try {
      const saved = await store.load(request.review_ref) as Artifact<'design-review'>;
      if (saved.kind !== 'design-review' || saved.data.subject_ref.path !== run.data.asset_ref.path ||
          saved.data.subject_ref.sha256 !== run.data.asset_ref.sha256) throw new Error('wrong design subject');
      designReview = saved;
    } catch { issues.push({ rule: 'R3', reason: '正式执行绑定的设计评估记录缺失或与资产不符' }); }
  }
  let inventory: Artifact<'inventory'> | undefined;
  if (asset.data.inventory_ref) {
    try {
      const saved = await store.load(asset.data.inventory_ref) as Artifact<'inventory'>;
      if (saved.kind !== 'inventory' || saved.data.scope_ref.sha256 !== asset.data.scope_ref.sha256) throw new Error('wrong inventory scope');
      inventory = saved;
    } catch { issues.push({ rule: 'R3', reason: '功能清单不可核验，不能推断完整覆盖' }); }
  }
  const processRef = readable.find(r => r.path === `${base}/process.json`);
  const processResult = await readJson(processRef);
  const receipts = [];
  for (const ref of readable.filter(r => r.path.startsWith(`${base}/attempts/`) && r.path.endsWith('.json'))) {
    try {
      const value = await readJson(ref);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
      receipts.push(value);
    }
    catch { issues.push({ rule: 'R3', reason: '原始 attempt 登记不可解析，不能确认附件归属' }); }
  }
  if (preflight?.status === 'completed' && !processRef) issues.push({ rule: 'R1', reason: '缺少已登记的原生进程结果，不能只凭测试 JSON 宣称完整执行' });
  if (processResult && processResult.code !== run.data.exit_code) issues.push({ rule: 'R1', reason: '批次退出码与原始进程结果不一致' });
  let report: NativeReport | undefined;
  try {
    report = await readJson(rawRef);
    if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors)) throw new Error('invalid native reporter');
  } catch { report = undefined; issues.push({ rule: 'R1', reason: '原生报告缺失、无效或摘要不符，不能补造执行结果' }); }
  if (missing.length) issues.push({ rule: 'R3', reason: '本批次证据存在缺失、篡改或错误归属' });
  if (['pending', 'running', 'unknown'].includes(run.data.state)) issues.push({ rule: 'R1', reason: '批次尚未确认终态' });
  if (run.data.state === 'interrupted') issues.push({ rule: 'R1', reason: '批次已中断，须核对未完成执行与副作用，不能宣称完整交付' });
  if (report?.errors.length) issues.push({ rule: 'R1', reason: '原生 runner 存在全局错误，须核对未完成实例与副作用' });
  if (summary?.collection_problems?.length) issues.push({ rule: 'R3', reason: '执行阶段已记录收集或完整性问题，不能忽略' });
  const specs = report?.suites.flatMap(flatten) ?? [], consumed = new Set<Test>();
  const specPaths = new Map<Spec, string>();
  for (const spec of specs) {
    try { specPaths.set(spec, await realpath(resolve(root, spec.file))); }
    catch { specPaths.set(spec, resolve(root, spec.file)); }
  }
  const instances: Artifact<'results'>['data']['instances'] = [];
  const details: { instance_id: string; expected_status: string[]; assertion_ids: string[]; missing_assertions: string[];
    cleanup: unknown[]; evidence_gaps: string[] }[] = [];
  let started = 0, assertionReached = 0;
  for (const planned of run.data.plan) {
    const binding = asset.data.bindings?.find(b => b.case_id === planned.case_id);
    const testcase = cases.data.cases.find(c => c.case_id === planned.case_id && c.data_row_id === planned.data_row_id && c.browser_project === planned.browser_project);
    const matches = binding ? specs.filter(s => s.title === binding.test_title &&
      relative(root, specPaths.get(s)!).replaceAll('\\', '/') === binding.script_ref.path)
      .flatMap(s => s.tests.filter(t => t.projectName === planned.browser_project)) : [];
    const attempts: Artifact<'results'>['data']['instances'][number]['attempts'] = [];
    const evidenceGaps: string[] = [], missingAssertions: string[] = [], cleanup: unknown[] = [];
    if (missing.length) evidenceGaps.push('批次登记证据缺失或摘要不符');
    const issue = (rule: Issue['rule'], reason: string) => issues.push({ rule, reason, instance_id: planned.instance_id });
    let status: typeof finalStates[number] = preflight?.status === 'blocked' ? 'blocked'
      : summary?.status === 'cancelled' ? 'cancelled' : summary?.business_started === false ? 'not-run' : 'unknown';
    if (!binding || !testcase || planned.revision !== asset.data.revision) issue('R1', '冻结实例与资产 case/数据行/修订不一致');
    if (matches.length !== 1 || consumed.has(matches[0])) {
      issue('R1', '计划实例缺少唯一原生结果，原计划分母保留');
      evidenceGaps.push('原生结果缺失或重复');
    } else {
      const test = matches[0]; consumed.add(test);
      if (test.results.some(a => a.status !== 'skipped')) started++;
      const retries = test.results.map(a => a.retry);
      if (new Set(retries).size !== retries.length || retries.some((r, i) => r !== i)) issue('R1', '原生 attempt 序号重复或不连续');
      for (const attempt of test.results) {
        const refs: FileRef[] = rawRef ? [rawRef] : [];
        const owners = receipts.filter(r => r.run_id === run.id && r.instance_id === planned.instance_id &&
          r.case_id === planned.case_id && r.attempt === attempt.retry);
        const owner = owners.length === 1 ? owners[0] : undefined;
        if (!owner || owner.native_status !== attempt.status || owner.raw_ref?.sha256 !== rawRef?.sha256 ||
            !isDeepStrictEqual(owner.steps, attempt.steps ?? []) || !isDeepStrictEqual(owner.attachments, attempt.attachments ?? [])) {
          evidenceGaps.push('原生 attempt 与收集时的实例/步骤/附件登记不一致');
          issue('R3', '缺少唯一且一致的 run/case/attempt 证据归属登记');
        }
        let blocked = false, cleanupFailed = false;
        for (const attachment of attempt.attachments ?? []) {
          if (attachment.path) {
            const path = relative(root, resolve(root, attachment.path)).replaceAll('\\', '/');
            const ref = readable.find(r => r.path === path);
            if (!path.startsWith(`${base}/output/`) || !ref ||
                !owner?.evidence_refs?.some((r: FileRef) => r.path === path && r.sha256 === ref.sha256)) {
              evidenceGaps.push(`附件缺失或属于其他批次：${path}`);issue('R3', '截图/trace 未登记为当前批次可核验证据');
            } else refs.push(ref);
          }
          if (attachment.name === 'ui-preflight') {
            const value = body(attachment);if (!value) evidenceGaps.push('前置检查附件不可解析');
            if (value?.status === 'blocked') blocked = true;
          }
          if (attachment.name === 'ui-data-lifecycle') {
            const value = body(attachment);cleanup.push(value ?? { status: 'missing' });
            if (!value || !Array.isArray(value.records) || !Array.isArray(value.residual)) cleanupFailed = true;
            else {
              const retained = new Set(value.records.filter((r: { cleanup_state: string; cleanup_reason?: string }) => r.cleanup_state === 'retained' && r.cleanup_reason)
                .map((r: { business_key: string }) => r.business_key));
              cleanupFailed = value.residual.some((key: string) => !retained.has(key)) || value.records.some((r: { cleanup_state: string; business_key: string }) =>
                r.cleanup_state !== 'cleaned' && !(r.cleanup_state === 'retained' && retained.has(r.business_key)));
              if (value.records.some((r: { state: string }) => r.state === 'prepare-failed')) blocked = true;
            }
          }
        }
        if (cleanupFailed) { evidenceGaps.push('数据清理或残留状态未确认');issue('R3', '数据清理失败或残留未确认，不能隐藏'); }
        const allSteps = steps(attempt.steps ?? []);
        for (const id of binding?.assertion_ids ?? []) {
          const found = allSteps.filter(s => s.title === id || s.title.startsWith(id + ' '));
          if (found.length === 1) assertionReached++;
          if (attempt.status === 'passed' && (found.length !== 1 || found[0].error)) missingAssertions.push(id);
        }
        if (['failed', 'timedOut'].includes(attempt.status) &&
            !(attempt.attachments ?? []).some(a => a.name === 'trace' && a.path && refs.some(r => resolve(root, r.path) === resolve(root, a.path!)))) {
          evidenceGaps.push('失败 attempt 缺少可读取 trace');
        }
        attempts.push({ attempt: attempt.retry, native_status: attempt.status, evidence_refs: refs,
          errors: (attempt.errors ?? []).map(e => e.message ?? JSON.stringify(e)) });
        // 保留原生状态；业务状态不能利用 expected-failure 或重试把第一次失败变绿。
        status = blocked ? 'blocked' : attempt.status === 'passed' ? 'passed'
          : ['failed', 'timedOut'].includes(attempt.status) ? 'failed'
          : attempt.status === 'interrupted' ? 'cancelled' : attempt.status === 'skipped' ? 'skipped' : 'unknown';
      }
      if (!test.results.length) { issue('R1', '原生测试未提供任何 attempt');evidenceGaps.push('attempt 缺失'); }
      if (status === 'passed' && attempts.slice(0, -1).some(a => ['failed', 'timedOut', 'interrupted'].includes(a.native_status))) status = 'flaky';
      if (test.expectedStatus === 'failed' && status !== 'skipped') { status = 'failed';issue('R2', '测试带 expected-failure 标记，不作为稳定业务通过'); }
      if (missingAssertions.length) { if (status === 'passed') status = 'unknown';issue('R2', '原生通过缺少成功关键断言步骤，不认定业务通过'); }
    }
    if (evidenceGaps.length) issue('R3', '该实例证据存在缺口，状态和证据完整性分别记录');
    instances.push({ instance_id: planned.instance_id, status, evidence_state: evidenceGaps.length || missingAssertions.length ? 'missing' : 'complete', attempts });
    details.push({ instance_id: planned.instance_id, expected_status: matches.map(t => t.expectedStatus),
      assertion_ids: binding?.assertion_ids ?? [], missing_assertions: [...new Set(missingAssertions)], cleanup, evidence_gaps: evidenceGaps });
  }
  const unplanned = specs.flatMap(s => s.tests.filter(t => !consumed.has(t)).map(t => ({ file: s.file, title: s.title, project: t.projectName })));
  if (unplanned.length) issues.push({ rule: 'R1', reason: '原生报告包含冻结计划外的实例，不能静默删除' });
  const total = counts();for (const instance of instances) total[instance.status]++;
  const denominator = total.passed + total.failed + total.flaky;
  const groups = (key: 'module_id' | 'feature_id' | 'priority') => {
    const result: Record<string, ReturnType<typeof counts>> = {};
    for (const instance of instances) {
      const planned = run.data.plan.find(p => p.instance_id === instance.instance_id)!;
      const c = cases.data.cases.find(c => c.case_id === planned.case_id);
      const label = c ? key === 'feature_id' ? `${c.module_id}/${c.feature_id}` : c[key] : 'unmapped';
      (result[label] ??= counts())[instance.status]++;
    }
    return result;
  };
  const data: Artifact<'results'>['data'] = { run_ref: runRef, raw_ref: rawRef ?? summaryRef ?? runRef,
    raw_kind: rawRef ? 'native-report' : summaryRef ? 'execution-summary' : 'run-manifest',
    planned_count: run.data.plan.length, instances, counts: total };
  const featureKey = (c: { module_id: string; feature_id: string }) => `${c.module_id}/${c.feature_id}`;
  const coveredFeatures = new Set(cases.data.cases.map(featureKey));
  const concludedFeatures = new Set(instances.filter(i => ['passed', 'failed', 'flaky'].includes(i.status)).flatMap(i => {
    const planned = run.data.plan.find(p => p.instance_id === i.instance_id)!;
    const c = cases.data.cases.find(c => c.case_id === planned.case_id);return c ? [featureKey(c)] : [];
  }));
  const byOracle = Object.fromEntries(['requirement', 'declaration', 'baseline'].map(type => [type,
    instances.filter(i => {
      const planned = run.data.plan.find(p => p.instance_id === i.instance_id)!;
      return cases.data.cases.find(c => c.case_id === planned.case_id)?.assertions.some(a => a.oracle_type === type);
    }).map(i => i.instance_id)]));
  return { data, details: { schema_version: '1.0', run_ref: runRef, complete: !issues.length,
    issues, missing, unplanned, instances: details, started_count: started, assertion_reached_attempt_count: assertionReached,
    stable_pass_rate: denominator ? total.passed / denominator : null,
    by_module: groups('module_id'), by_feature: groups('feature_id'), by_priority: groups('priority'),
    by_oracle: byOracle, coverage: { basis: 'frozen-case-features', features_with_cases: coveredFeatures.size,
      features_with_execution_conclusion: concludedFeatures.size,
      selected_features: inventory ? new Set(inventory.data.features.map(featureKey)).size : null,
      features_without_cases: inventory ? inventory.data.features.filter(f => !coveredFeatures.has(featureKey(f))).map(featureKey) : null,
      unexplored: inventory?.data.unexplored ?? null, case_gaps: cases.data.gaps, asset_gaps: asset.data.gaps },
    design: { basis: 'executed-asset-revision-only', candidate_count: cases.data.cases.length,
      approved_count: designReview ? designReview.data.decision === 'approved' ? cases.data.cases.length : 0 : null,
      revise_count: designReview ? designReview.data.decision === 'revise' ? cases.data.cases.length : 0 : null,
      blocked_count: designReview ? designReview.data.decision === 'blocked' ? cases.data.cases.length : 0 : null,
      review_ref: request?.review_ref ?? null, decision: designReview?.data.decision ?? 'unavailable' },
    limitations: ['范围仅限冻结计划，不代表全产品或代码覆盖率；attempt 与 case 分开统计',
      '候选与设计评估数量仅统计本批次资产修订；不推断其他候选或历史轮次。未登记的信息为不可用，不填零',
      ...(inventory ? inventory.data.unexplored.map(gap => `未探索：${gap}`) : ['未绑定可核验功能清单，已选功能点分母不可用']),
      ...cases.data.gaps, ...asset.data.gaps],
  } };
}

export async function collectResults(root: string, runRef: FileRef, resultId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(resultId)) throw new WorkflowError('invalid-input', '结果 ID 无效');
  const store = new ArtifactStore(root), reconciled = await reconcileRun(root, runRef);
  const detailRef = await store.putFile(`${posix.dirname(runRef.path)}/results/${resultId}/reconciliation.json`, json(reconciled.details));
  const artifact: Artifact<'results'> = { schema_version: '1.0', kind: 'results', id: resultId, created_at: new Date().toISOString(),
    data: { ...reconciled.data, reconciliation_ref: detailRef } };
  const existing = (await store.reindex()).records.find(r => r.ref.path === `${posix.dirname(runRef.path)}/results/${resultId}/manifest.json`);
  if (existing) artifact.created_at = (await store.load(existing.ref, false)).created_at;
  return { ...reconciled, data: artifact.data, results_ref: await store.put(artifact) };
}
