import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { ArtifactStore } from './store.js';
import { reconcileRun } from './results.js';
import type { Artifact, FileRef } from './contracts.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

export type RunIntent = 'resume' | 'rerun-failed' | 'rerun-all';
/** 选择只依赖冻结计划和原生结果；未知副作用不靠模型或 PID 推断安全。 */
export async function recoveryPlan(root: string, parentRef: FileRef, intent: RunIntent) {
  const store = new ArtifactStore(root), parent = await store.load(parentRef, false) as Artifact<'run'>;
  if (parent.kind !== 'run') throw new WorkflowError('invalid-input', '恢复须引用正式父批次');
  const reconciled = await reconcileRun(root, parentRef);
  const summaryRef = parent.data.output_refs.find(r => r.path === `${posix.dirname(parentRef.path)}/execution-summary.json`);
  const summary = summaryRef ? JSON.parse(await readFile(await workspacePath(root, summaryRef.path), 'utf8')) : undefined;
  const unstarted = summary?.business_started === false;
  if (summaryRef) await verifyReferences(root, summaryRef);
  const blockers: string[] = [];
  if (parent.data.state !== 'finished') blockers.push('父批次活跃或中断；须先核对进程与未知业务写入，不能按点击序号恢复');
  if (!unstarted && !reconciled.details.complete) blockers.push('父批次证据或副作用未完整核对，不能盲目重放');
  const asset = await store.load(parent.data.asset_ref) as Artifact<'asset'>;
  const cases = await store.load(asset.data.cases_ref) as Artifact<'cases'>;
  const whole = cases.data.cases.map(c => ({ instance_id: `instance-${sha256(JSON.stringify([c.case_id, c.data_row_id, c.browser_project], null, 2) + '\n').slice(0, 32)}`,
    case_id: c.case_id, revision: asset.data.revision, data_row_id: c.data_row_id, browser_project: c.browser_project }));
  const selected = intent === 'rerun-all' ? whole : parent.data.plan.filter(p => reconciled.data.instances.some(i => i.instance_id === p.instance_id &&
    (intent === 'rerun-failed' ? ['failed', 'flaky'].includes(i.status) : unstarted || i.status === 'not-run')));
  if (!selected.length) blockers.push('选择集合为空；失败重跑不混入未执行实例，续跑不重做已完成实例');
  return { parent_run_ref: parentRef, parent_run_id: parent.id, intent, selected,
    excluded: whole.filter(p => !selected.some(s => s.instance_id === p.instance_id)).map(p => ({ instance_id: p.instance_id,
      reason: '不属于本次意图选择集合，保留父批次原结果' })),
    blockers, resume_unit: 'case-or-whole-business-chain-from-declared-initial-state',
    note: '新批次单独报告；失败子集通过不代表原全量计划通过，不合并部署版本。' };
}
