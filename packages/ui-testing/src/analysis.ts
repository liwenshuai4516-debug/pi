import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { ArtifactStore } from './store.js';
import { collectResults, reconcileRun } from './results.js';
import type { UiWorkflowService } from './workflow.js';
import { finalStates, type Artifact, type FileRef } from './contracts.js';
import { fileRefs, sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
export async function verifyResults(root: string, ref: FileRef) {
  const store = new ArtifactStore(root), saved = await store.load(ref) as Artifact<'results'>;
  if (saved.kind !== 'results') throw new WorkflowError('invalid-input', '需要已登记的结果产物');
  const actual = await reconcileRun(root, saved.data.run_ref);
  const { reconciliation_ref: _detail, ...storedData } = saved.data;
  if (!isDeepStrictEqual(storedData, actual.data)) throw new WorkflowError('precondition', '统计或证据状态与原生报告不一致，请重新解析为新结果修订');
  if (!saved.data.reconciliation_ref || !isDeepStrictEqual(JSON.parse(await readFile(await workspacePath(root, saved.data.reconciliation_ref.path), 'utf8')), actual.details)) {
    throw new WorkflowError('precondition', '对账明细与当前原生证据不一致，请生成新的结果修订');
  }
  return { saved, ...actual };
}

export async function analysisInputs(root: string, resultsRef: FileRef) {
  const store = new ArtifactStore(root), verified = await verifyResults(root, resultsRef);
  const run = await store.load(verified.data.run_ref, false) as Artifact<'run'>;
  const asset = await store.load(run.data.asset_ref, false) as Artifact<'asset'>;
  const cases = await store.load(asset.data.cases_ref, false) as Artifact<'cases'>;
  const scope = await store.load(asset.data.scope_ref, false) as Artifact<'scope'>;
  // 引用白名单按本批次与其原始来源建立，不能把另一批次截图混入分析。
  const allowed = fileRefs([verified.saved, run.data.output_refs, asset, cases, scope,
    verified.data.run_ref, run.data.asset_ref, resultsRef, verified.details.design.review_ref]);
  return { ...verified, run, asset, cases, scope, allowed };
}

function checkAnalysisInput(input: Awaited<ReturnType<typeof analysisInputs>>, analysis: Artifact<'analysis'>) {
  if (!same(analysis.data.run_ref, input.data.run_ref)) throw new WorkflowError('precondition', '分析与统计不属于同一批次');
  const seen = new Set<string>();
  for (const finding of analysis.data.findings) {
    if (seen.has(finding.instance_id) || !input.data.instances.some(i => i.instance_id === finding.instance_id)) {
      throw new WorkflowError('invalid-input', '分析实例重复或不属于当前冻结计划');
    }
    seen.add(finding.instance_id);
    const instance = input.data.instances.find(i => i.instance_id === finding.instance_id)!;
    const owned = instance.attempts.flatMap(a => a.evidence_refs);
    if (!finding.facts.length || !finding.next_action.trim() || !finding.supporting_refs.length ||
        finding.supporting_refs.some(ref => !input.allowed.some(a => same(a, ref)) ||
          (ref.path.includes('/output/') && !owned.some(a => same(a, ref))))) {
      throw new WorkflowError('insufficient-evidence', '分析必须有观察事实、下一动作及本批次/原始来源证据，不能引用其他批次');
    }
    if (finding.certainty === 'unknown' && !finding.alternatives.length) throw new WorkflowError('invalid-input', '未知结论须保留替代解释或待补事实');
  }
  if (input.data.instances.some(i => i.status !== 'passed' && !seen.has(i.instance_id))) {
    throw new WorkflowError('insufficient-evidence', '失败、阻塞、跳过、取消或未知实例不能从分析中遗漏');
  }
  return input;
}

export async function checkAnalysis(root: string, analysis: Artifact<'analysis'>) {
  const input = await analysisInputs(root, analysis.data.results_ref);
  await verifyReferences(root, analysis.data.findings.flatMap(finding => finding.supporting_refs));
  return checkAnalysisInput(input, analysis);
}

export async function saveAnalysis(root: string, analysis: Artifact<'analysis'>) {
  await checkAnalysis(root, analysis);
  return { analysis_ref: await new ArtifactStore(root).put(analysis) };
}

async function saveAnalysisWithInput(root: string, input: Awaited<ReturnType<typeof analysisInputs>>, analysis: Artifact<'analysis'>) {
  await verifyReferences(root, analysis.data.findings.flatMap(finding => finding.supporting_refs));
  checkAnalysisInput(input, analysis);
  return { analysis_ref: await new ArtifactStore(root).put(analysis) };
}

/** 按观察签名分组而不推断共同根因；每个实例保留全部 attempts、残留及缺口。 */
export function groupFailures(input: Pick<Awaited<ReturnType<typeof reconcileRun>>, 'data' | 'details'>) {
  const groups = new Map<string, { status: string; instances: typeof input.data.instances }>();
  for (const instance of input.data.instances.filter(i => i.status !== 'passed')) {
    const key = JSON.stringify([instance.status, instance.evidence_state,
      instance.attempts.map(a => [a.native_status, a.errors])]);
    const group = groups.get(key) ?? { status: instance.status, instances: [] };
    group.instances.push(instance); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ group_id: sha256(key), ...group,
    details: input.details.instances.filter(i => group.instances.some(member => member.instance_id === i.instance_id)),
    interpretation: '相同观察签名不证明相同根因；每个非 passed 实例仍须独立 finding 和本批次证据' }));
}

/** 仅对任务选定的已结束 run 做确定性处理；不启动浏览器或模型，不跳过结果评审。 */
export async function analyzeTask(workflow: UiWorkflowService, taskId: string,
  findings?: Artifact<'analysis'>['data']['findings'], signal?: AbortSignal) {
  const release = await workflow.store.acquireResource(`analysis:${taskId}`);
  try {
    if (signal?.aborted) throw new WorkflowError('cancelled', '任务分析已取消');
    let current = await workflow.find(taskId);
    const mode = current.task.data.workflow!.mode;
    if (mode === 'view') throw new WorkflowError('precondition', '查看任务只读取旧批次，不生成分析或评审');
    const runRef = current.stage_inputs.run_ref;
    if (!runRef) throw new WorkflowError('precondition', '任务缺少唯一已登记批次');
    const run = await workflow.store.load(runRef, false) as Artifact<'run'>;
    if (run.kind !== 'run' || run.data.state !== 'finished') throw new WorkflowError('precondition', '批次尚未结束或副作用未知，不自动交接或重放');
    if (current.task.data.completed_stages.includes('analyze')) {
      if (current.stage_inputs.report_refs.length !== 1) throw new WorkflowError('precondition', '任务报告不唯一，须明确选择');
      const ref = current.stage_inputs.report_refs[0], report = await workflow.store.load(ref) as Artifact<'report'>;
      if (!same(report.data.run_ref, runRef)) throw new WorkflowError('precondition', '报告不属于选定批次');
      const checked = await verifyResults(workflow.root, report.data.results_ref);
      const analysis = await workflow.store.load(report.data.analysis_ref) as Artifact<'analysis'>;
      if (findings && !isDeepStrictEqual(findings, analysis.data.findings)) throw new WorkflowError('precondition', '重复分析不能更换结论，须显式新修订');
      return { workflow: current, report_ref: ref, results_ref: report.data.results_ref,
        summary: { counts: checked.data.counts, complete: checked.details.complete, stable_pass_rate: checked.details.stable_pass_rate },
        groups: groupFailures(checked), replayed: true };
    }
    if (current.task.data.state !== 'running' || !['execute', 'analyze'].includes(current.task.data.stage)) {
      throw new WorkflowError('precondition', '任务不在可分析阶段；阻塞/取消须显式核对并续跑');
    }
    if (current.task.data.stage === 'execute') current = await workflow.handoff({ task_id: taskId, stage: 'execute', output_refs: [runRef] }, signal);
    if (current.task.data.stage !== 'analyze' || current.blockers.length) throw new WorkflowError('precondition', '分析前置阶段尚未放行');
    const id = `task-${sha256(JSON.stringify([taskId, runRef])).slice(0, 24)}`;
    // collectResults 已对本轮原生结果完成对账；下游保存/报告仍各自核验，不重复立即重算。
    const parsed = await collectResults(workflow.root, runRef, id);
    const groups = groupFailures(parsed);
    const summary = { counts: parsed.data.counts, complete: parsed.details.complete, stable_pass_rate: parsed.details.stable_pass_rate };
    if (groups.length && !findings) return { workflow: current, results_ref: parsed.results_ref, summary, groups, replayed: false };
    if (signal?.aborted) throw new WorkflowError('cancelled', '任务分析已取消');
    const input = await analysisInputs(workflow.root, parsed.results_ref);
    const analysis: Artifact<'analysis'> = { schema_version: '1.0', kind: 'analysis', id,
      created_at: run.created_at, data: { run_ref: runRef, results_ref: parsed.results_ref, findings: findings ?? [] } };
    const saved = await saveAnalysisWithInput(workflow.root, input, analysis);
    const report = await draftReportWithInput(workflow.root, input, parsed.results_ref, saved.analysis_ref, id);
    if (signal?.aborted) throw new WorkflowError('cancelled', '报告候选已保存，交接已取消；核对原任务后续跑');
    // 本调用已取得当前引用；复用原 checkpoint 的版本冲突检查，不再按 ID 扫描一次。
    const next = await workflow.checkpoint(current.task_ref, 'analyze', [report.report_ref], signal);
    return { workflow: next, results_ref: parsed.results_ref, report_ref: report.report_ref, summary, groups, replayed: false };
  } finally { await release(); }
}

export async function composeReport(root: string, resultsRef: FileRef, analysisRef: FileRef, reportId: string, linkDirectory?: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(reportId)) throw new WorkflowError('invalid-input', '报告 ID 无效');
  return composeReportWithInput(root, await analysisInputs(root, resultsRef), resultsRef, analysisRef, reportId, linkDirectory);
}

async function composeReportWithInput(root: string, input: Awaited<ReturnType<typeof analysisInputs>>, resultsRef: FileRef, analysisRef: FileRef, reportId: string, linkDirectory?: string) {
  const store = new ArtifactStore(root);
  const analysis = await store.load(analysisRef) as Artifact<'analysis'>;
  if (analysis.kind !== 'analysis' || !same(analysis.data.results_ref, resultsRef) || !same(analysis.data.run_ref, input.data.run_ref)) {
    throw new WorkflowError('precondition', '报告必须绑定同批次的统计与分析');
  }
  await verifyReferences(root, analysis.data.findings.flatMap(finding => finding.supporting_refs));
  checkAnalysisInput(input, analysis);
  const base = `${posix.dirname(input.data.run_ref.path)}/report/${reportId}`;
  const limitations = [...input.details.limitations, ...input.details.issues.map(i => `${i.rule}: ${i.reason}`),
    ...analysis.data.findings.filter(f => f.certainty === 'unknown').map(f => `${f.instance_id}：原因仍未知，未假定已修复或已提交缺陷`)];
  const followUp = analysis.data.findings.map(finding => {
    const instance = input.run.data.plan.find(p => p.instance_id === finding.instance_id)!;
    const c = input.cases.data.cases.find(c => c.case_id === instance.case_id)!;
    return { run_ref: input.data.run_ref, instance_id: finding.instance_id, case_id: c.case_id,
      classification: finding.classification, certainty: finding.certainty, evidence_refs: finding.supporting_refs,
      proposed_next_action: finding.next_action, action_performed: false,
      routing: finding.classification === 'script' ? 'new-revision-and-design-review'
        : ['environment', 'data'].includes(finding.classification) ? 'restore-preconditions-then-new-run'
        : finding.classification === 'product' ? 'confirm-defect-then-regress-fixed-version' : 'collect-evidence-before-replay',
      regression: { asset_ref: input.run.data.asset_ref, revision: instance.revision, case_id: c.case_id,
        data_row_id: instance.data_row_id, browser_project: instance.browser_project },
      ...(finding.classification === 'product' ? { defect_draft: { status: 'draft-not-submitted', title: c.title,
        observed: finding.facts, expected: c.assertions.map(a => ({ assertion_id: a.assertion_id, expected: a.expected,
          oracle_type: a.oracle_type, source_id: a.source_id })), steps: c.steps, priority: c.priority,
        conditions: c.preconditions, hypotheses: finding.hypotheses, alternatives: finding.alternatives } } : {}),
    };
  });
  const link = (ref: FileRef) => `[${ref.path}](${posix.relative(linkDirectory ?? base, ref.path)})`;
  const lines = ['# UI 测试结果', '', `范围：${input.scope.data.goal}`, '',
    `批次：${input.run.id}；部署：${input.run.data.deployment_version}；角色：${input.run.data.role}`, '',
    `冻结计划：${input.data.planned_count}；实际启动：${input.details.started_count}；稳定通过率：${input.details.stable_pass_rate === null ? '不适用' : (100 * input.details.stable_pass_rate).toFixed(2) + '%'}`, '',
    '| 状态 | 实例数 |', '|---|---:|', ...finalStates.map(s => `| ${s} | ${input.data.counts[s]} |`), '',
    `原始结果：${link(input.data.raw_ref)}`, '',
    `确定性对账与证据状态：${link(input.saved.data.reconciliation_ref!)}`, '',
    `设计评估（仅本批次资产修订）：候选用例 ${input.details.design.candidate_count}；通过 ${input.details.design.approved_count ?? '不可用'}；待修订 ${input.details.design.revise_count ?? '不可用'}；阻塞 ${input.details.design.blocked_count ?? '不可用'}；结论 ${input.details.design.decision}。`, '',
    `已登记功能清单：${input.details.coverage.selected_features ?? '不可用'}；清单内尚无用例的功能点：${input.details.coverage.features_without_cases?.join('、') || (input.details.coverage.features_without_cases ? '无' : '不可用')}。`, '',
    `未探索范围（不计入上述清单分母）：${input.details.coverage.unexplored?.join('；') || (input.details.coverage.unexplored ? '未登记；不代表全产品已探索' : '不可用')}。`, '',
    `功能覆盖：冻结用例涉及 ${input.details.coverage.features_with_cases} 个功能点，其中 ${input.details.coverage.features_with_execution_conclusion} 个获得执行结论；不代表全产品覆盖。`, '',
    '## 模块、功能与优先级统计', '',
    '```json', JSON.stringify({ by_module: input.details.by_module, by_feature: input.details.by_feature,
      by_priority: input.details.by_priority, by_oracle: input.details.by_oracle }, null, 2), '```', '',
    '## 观察、解释与下一动作', ''];
  for (const finding of analysis.data.findings) {
    lines.push(`### ${finding.instance_id}（${finding.classification} / ${finding.certainty}）`, '',
      ...finding.facts.map(f => `- 观察事实：${f}`), ...finding.hypotheses.map(h => `- 候选解释：${h}`),
      ...finding.alternatives.map(a => `- 替代解释/缺口：${a}`), `- 下一验证动作：${finding.next_action}`,
      ...finding.supporting_refs.map(r => `- 证据：${link(r)}`), '');
  }
  lines.push('## 数据清理与残留', '', '```json', JSON.stringify(input.details.instances.map(i => ({
    instance_id: i.instance_id, cleanup: i.cleanup, evidence_gaps: i.evidence_gaps,
  })), null, 2), '```', '');
  lines.push('## 限制与待处理事项', '', ...limitations.map(l => `- ${l}`), '',
    '失败处理：产品问题仅形成待确认缺陷草稿；脚本问题新建修订并重审；环境/数据恢复后新批次执行；证据不足先补证据，不修改历史结果。', '');
  lines.push(`后续处理草稿：[缺陷与回归建议](${posix.relative(linkDirectory ?? base, `${base}/follow-up.json`)})；未向外部系统提交。`, '');
  return { input, base, limitations, followUp, content: lines.join('\n') };
}

export async function draftReport(root: string, resultsRef: FileRef, analysisRef: FileRef, reportId: string) {
  return draftReportWithInput(root, await analysisInputs(root, resultsRef), resultsRef, analysisRef, reportId);
}

async function draftReportWithInput(root: string, input: Awaited<ReturnType<typeof analysisInputs>>, resultsRef: FileRef, analysisRef: FileRef, reportId: string) {
  const store = new ArtifactStore(root), { base, limitations, followUp, content } = await composeReportWithInput(root, input, resultsRef, analysisRef, reportId);
  const contentRef = await store.putFile(`${base}/content.md`, content);
  const followUpRef = await store.putFile(`${base}/follow-up.json`, JSON.stringify(followUp, null, 2) + '\n');
  const report: Artifact<'report'> = { schema_version: '1.0', kind: 'report', id: reportId, created_at: new Date().toISOString(),
    data: { run_ref: input.data.run_ref, results_ref: resultsRef, analysis_ref: analysisRef,
      content_ref: contentRef, follow_up_ref: followUpRef, completeness: input.details.complete ? 'complete' : 'partial', limitations } };
  const existing = (await store.reindex()).records.find(r => r.ref.path === `${base}/manifest.json`);
  if (existing) report.created_at = (await store.load(existing.ref, false)).created_at;
  return { report_ref: await store.put(report), completeness: report.data.completeness, review_status: 'not-reviewed' };
}
