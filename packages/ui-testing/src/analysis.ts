import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { ArtifactStore } from './store.js';
import { reconcileRun } from './results.js';
import { finalStates, type Artifact, type FileRef } from './contracts.js';
import { fileRefs, verifyReferences, workspacePath, WorkflowError } from './validation.js';

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

export async function checkAnalysis(root: string, analysis: Artifact<'analysis'>) {
  const input = await analysisInputs(root, analysis.data.results_ref);
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
    await verifyReferences(root, finding.supporting_refs);
    if (finding.certainty === 'unknown' && !finding.alternatives.length) throw new WorkflowError('invalid-input', '未知结论须保留替代解释或待补事实');
  }
  if (input.data.instances.some(i => i.status !== 'passed' && !seen.has(i.instance_id))) {
    throw new WorkflowError('insufficient-evidence', '失败、阻塞、跳过、取消或未知实例不能从分析中遗漏');
  }
  return input;
}

export async function saveAnalysis(root: string, analysis: Artifact<'analysis'>) {
  await checkAnalysis(root, analysis);
  return { analysis_ref: await new ArtifactStore(root).put(analysis) };
}

export async function composeReport(root: string, resultsRef: FileRef, analysisRef: FileRef, reportId: string, linkDirectory?: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(reportId)) throw new WorkflowError('invalid-input', '报告 ID 无效');
  const store = new ArtifactStore(root), input = await analysisInputs(root, resultsRef);
  const analysis = await store.load(analysisRef) as Artifact<'analysis'>;
  if (analysis.kind !== 'analysis' || !same(analysis.data.results_ref, resultsRef) || !same(analysis.data.run_ref, input.data.run_ref)) {
    throw new WorkflowError('precondition', '报告必须绑定同批次的统计与分析');
  }
  await checkAnalysis(root, analysis);
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
  const store = new ArtifactStore(root), { input, base, limitations, followUp, content } = await composeReport(root, resultsRef, analysisRef, reportId);
  const contentRef = await store.putFile(`${base}/content.md`, content);
  const followUpRef = await store.putFile(`${base}/follow-up.json`, JSON.stringify(followUp, null, 2) + '\n');
  const report: Artifact<'report'> = { schema_version: '1.0', kind: 'report', id: reportId, created_at: new Date().toISOString(),
    data: { run_ref: input.data.run_ref, results_ref: resultsRef, analysis_ref: analysisRef,
      content_ref: contentRef, follow_up_ref: followUpRef, completeness: input.details.complete ? 'complete' : 'partial', limitations } };
  const existing = (await store.reindex()).records.find(r => r.ref.path === `${base}/manifest.json`);
  if (existing) report.created_at = (await store.load(existing.ref, false)).created_at;
  return { report_ref: await store.put(report), completeness: report.data.completeness, review_status: 'not-reviewed' };
}
