import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Type, type Static } from 'typebox';
import { ArtifactStore } from './store.js';
import { capabilities, fileRefSchema, stages, workflowModes, type Artifact, type FileRef } from './contracts.js';
import { checkDesign } from './design.js';
import { DesignReviewService } from './review.js';
import { checkReport, ResultReviewService } from './result-review.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
export const workflowStartSchema = Type.Object({ task_id: id, mode: Type.Enum([...workflowModes]),
  scope_ref: Type.Optional(fileRefSchema), asset_ref: Type.Optional(fileRefSchema), run_ref: Type.Optional(fileRefSchema),
  discovery: Type.Optional(Type.Enum(['source', 'browser', 'both'])),
}, { additionalProperties: false });
type Start = Static<typeof workflowStartSchema>;
type Stage = typeof stages[number];
type Mode = typeof workflowModes[number];
export type WorkflowRuntime = { tools: string[]; skills: string[] };
const validateStart = new Ajv({ strict: true, allErrors: true }).compile(workflowStartSchema);
const json = (value: unknown) => JSON.stringify(value);
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const paths: Record<Mode, Stage[]> = {
  new: ['discover-record', 'case-design', 'design-review'], record: ['discover-record', 'case-design', 'design-review'],
  execute: ['execute', 'analyze', 'result-review'], analyze: ['analyze', 'result-review'], view: ['analyze'],
  resume: ['execute', 'analyze', 'result-review'], 'rerun-failed': ['execute', 'analyze', 'result-review'], 'rerun-all': ['execute', 'analyze', 'result-review'],
};
const skills: Record<Stage, string> = { 'discover-record': 'ui-discover-record', 'case-design': 'ui-case-design',
  'design-review': 'ui-design-review', execute: 'ui-test-run', analyze: 'ui-result-analysis', 'result-review': 'ui-result-review' };
const tools: Record<Stage, string[]> = { 'discover-record': ['ui_discover_record'], 'case-design': ['ui_case_design'],
  'design-review': ['ui_design_review'], execute: ['ui_test_run'], analyze: ['ui_result_analysis'], 'result-review': ['ui_result_review'] };

/** 只选择阶段和保存交接；Agent 仍通过现有 Skill/工具执行，不另造任务执行循环。 */
export class UiWorkflowService {
  readonly store: ArtifactStore;
  constructor(readonly root: string, readonly authorityRoot: string, readonly runtime: WorkflowRuntime) { this.store = new ArtifactStore(root); }
  async catalog() {
    const index = await this.store.reindex();
    const invalid = [...index.invalid];
    const reviews = [];
    for (const entry of index.records.filter(r => r.kind === 'design-review')) {
      try { reviews.push({ ref: entry.ref, value: await this.store.load(entry.ref) as Artifact<'design-review'> }); }
      catch { invalid.push({ path: entry.ref.path, reason: '设计评估或直接依赖已失效，不作为有效批准' }); }
    }
    const assets = [];
    for (const entry of index.records.filter(r => r.kind === 'asset')) {
      let asset: Artifact<'asset'>;
      try { asset = await this.store.load(entry.ref, false) as Artifact<'asset'>; }
      catch { invalid.push({ path: entry.ref.path, reason: '资产摘要或登记已失效，须单独核对' });continue; }
      const approvals = [], readinessIssues: string[] = [];
      for (const review of reviews.filter(r => r.value.data.decision === 'approved' && same(r.value.data.subject_ref, entry.ref))) {
        try { await new DesignReviewService(this.root, this.authorityRoot).gate(entry.ref, review.ref);approvals.push(review.ref); }
        catch (error) { readinessIssues.push(error instanceof WorkflowError ? error.message : '批准或运行证明不可核验'); }
      }
      assets.push({ asset_ref: entry.ref, id: asset.id, revision: asset.data.revision, module_ids: asset.data.module_ids,
        scope_ref: asset.data.scope_ref, runtime_ready: !!approvals.length, review_refs: approvals,
        readiness_issues: approvals.length ? [] : readinessIssues.length ? readinessIssues : ['无可核验设计批准或诊断证明'] });
    }
    return { ...index, invalid, assets, capabilities, note: 'runtime_ready 是当前文件/批准检查，不替代本次环境预检；目录查询不启动浏览器。' };
  }
  private async requirements(task: Artifact<'task'>) {
    const mode = task.data.workflow!.mode, sequence = paths[mode];
    const required = mode === 'view' ? [] : sequence.filter(stage => !task.data.completed_stages.includes(stage));
    const blockers: { category: 'missing-capability' | 'incompatible-version' | 'precondition' | 'review-rejected'; message: string }[] = [];
    const directory = [];
    if (mode !== 'view' && !this.runtime.tools.includes('read')) blockers.push({ category: 'missing-capability', message: '缺少 Pi read 工具，不能按需读取 Skill' });
    for (const stage of required) {
      const name = skills[stage], path = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
      if (!this.runtime.skills.includes(name)) blockers.push({ category: 'missing-capability', message: `Pi 未发现 Skill：${name}` });
      try { await readFile(path, 'utf8'); } catch { blockers.push({ category: 'missing-capability', message: `Skill 文件不可读取：${name}` }); }
      for (const tool of tools[stage]) if (!this.runtime.tools.includes(tool)) blockers.push({ category: 'missing-capability', message: `缺少工具：${tool}` });
      directory.push({ stage, skill: name, path, tools: tools[stage] });
    }
    if (required.length) {
      try {
        const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent')), 'utf8'));
        if (metadata.version !== '1.2.0') blockers.push({ category: 'incompatible-version', message: `Pi 版本 ${metadata.version} 未验证，仅支持 1.2.0` });
      } catch { blockers.push({ category: 'missing-capability', message: '无法核对 Pi 运行版本' }); }
    }
    if (required.includes('execute') || (required.includes('discover-record') && task.data.workflow!.discovery !== 'source')) {
      try {
        const require = createRequire(join(this.root, 'package.json'));
        const metadata = JSON.parse(await readFile(require.resolve('playwright/package.json'), 'utf8'));
        if (metadata.version !== '1.62.1') blockers.push({ category: 'incompatible-version', message: `Playwright ${metadata.version} 未验证，仅支持 1.62.1` });
      } catch { blockers.push({ category: 'missing-capability', message: '被测项目缺少 Playwright CLI' }); }
    }
    if (required.includes('discover-record') && task.data.workflow!.discovery !== 'source') {
      const backend = this.runtime.tools.find(t => t.startsWith('mcp__') && t.endsWith('generator_setup_page'))?.slice(0, -'generator_setup_page'.length);
      const missing = ['generator_setup_page', 'generator_read_log', 'generator_write_test', 'browser_snapshot', 'browser_type', 'browser_click', 'browser_close']
        .filter(name => !backend || !this.runtime.tools.includes(backend + name));
      if (missing.length) blockers.push({ category: 'missing-capability', message: `缺少已验证测试 MCP 工具：${missing.join('、')}；不自动换浏览器后端` });
    }
    if (required.includes('execute')) {
      const catalog = await this.catalog(), selected = task.data.asset_refs[0];
      const asset = catalog.assets.find(a => selected && same(a.asset_ref, selected));
      // 目录提供就绪证据；真正的执行准入统一由 UiRunService 强制，不复制它的门禁或环境预检。
      for (const entry of catalog.records.filter(r => r.kind === 'task')) {
        const other = await this.store.load(entry.ref, false) as Artifact<'task'>;
        try {
          await readFile(await workspacePath(this.root, `qa/ui/tasks/${other.id}/active-run.json`), 'utf8');
          if (!same(other.data.scope_ref, task.data.scope_ref)) {
            const currentScope = await this.store.load(task.data.scope_ref, false) as Artifact<'scope'>;
            const oldScope = await this.store.load(other.data.scope_ref, false) as Artifact<'scope'>;
            const target = (scope: Artifact<'scope'>) => json([scope.data.project_id, scope.data.environment_id, scope.data.base_url ?? null]);
            if (target(currentScope) !== target(oldScope)) continue;
          }
          const related = [];
          for (const ref of other.data.asset_refs) {
            try { related.push(await this.store.load(ref, false) as Artifact<'asset'>); }
            catch { blockers.push({ category: 'precondition', message: `任务 ${other.id} 的活跃批次范围无法核对，禁止盲目启动` }); }
          }
          if (!related.length || related.some(a => a.data.module_ids.some(m => asset?.module_ids.includes(m)))) {
            blockers.push({ category: 'precondition', message: `任务 ${other.id} 有活跃或状态未核对批次；换任务 ID 不能重放相同业务动作` });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') blockers.push({ category: 'precondition', message: `任务 ${other.id} 的启动登记不可读取，须先核对` });
        }
      }
    }
    return { sequence, directory, blockers };
  }
  async start(input: Start) {
    if (!validateStart(input)) throw new WorkflowError('invalid-input', '工作流输入不符合契约');
    const mode = input.mode;
    const recovery = ['resume', 'rerun-failed', 'rerun-all'].includes(mode);
    if ((mode === 'execute') !== !!input.asset_ref || (['analyze', 'view'].includes(mode) || recovery) !== !!input.run_ref ||
        (input.discovery && !['new', 'record'].includes(mode))) throw new WorkflowError('invalid-input', '执行须指定资产，分析/查看须指定旧 run；发现方式仅用于新建/录制');
    let scopeRef = input.scope_ref;
    if (input.asset_ref) {
      const asset = await this.store.load(input.asset_ref) as Artifact<'asset'>;
      if (asset.kind !== 'asset') throw new WorkflowError('invalid-input', '执行入口需要资产修订');
      if (scopeRef && !same(scopeRef, asset.data.scope_ref)) throw new WorkflowError('precondition', '任务范围与资产不一致');
      scopeRef = asset.data.scope_ref;
    }
    let selectedAsset = input.asset_ref;
    if (input.run_ref) {
      const run = await this.store.load(input.run_ref, false) as Artifact<'run'>;
      if (run.kind !== 'run') throw new WorkflowError('invalid-input', '分析/查看需要正式 run');
      const asset = await this.store.load(run.data.asset_ref, false) as Artifact<'asset'>;
      if (recovery) selectedAsset = run.data.asset_ref;
      if (scopeRef && !same(scopeRef, asset.data.scope_ref)) throw new WorkflowError('precondition', '任务范围与旧批次不一致');
      scopeRef = asset.data.scope_ref;
    }
    if (!scopeRef) throw new WorkflowError('invalid-input', '新建或录制须指定已登记范围');
    const scope = await this.store.load(scopeRef, !['analyze', 'view'].includes(mode)) as Artifact<'scope'>;
    if (scope.kind !== 'scope') throw new WorkflowError('invalid-input', 'scope_ref 须引用范围');
    const normalized = { task_id: input.task_id, mode, scope_ref: scopeRef, asset_ref: input.asset_ref ?? null,
      run_ref: input.run_ref ?? null, discovery: ['new', 'record'].includes(mode) ? input.discovery ?? (scope.data.base_url ? 'both' : 'source') : null };
    const inputHash = sha256(json(normalized)), catalog = await this.store.reindex();
    const existing = catalog.records.find(r => r.kind === 'task' && r.id === input.task_id);
    if (existing) {
      const old = await this.store.load(existing.ref, false) as Artifact<'task'>;
      if (old.data.input_sha256 !== inputHash || !old.data.workflow) throw new WorkflowError('precondition', '同一工作流任务不能更换输入');
      return this.status(existing.ref);
    }
    const task: Artifact<'task'> = { schema_version: '1.0', kind: 'task', id: input.task_id, created_at: new Date().toISOString(),
      data: { intent: mode === 'new' ? 'record' : mode, workflow: { mode,
        ...(input.run_ref ? { source_run_ref: input.run_ref } : {}),
        ...(normalized.discovery ? { discovery: normalized.discovery as 'source' | 'browser' | 'both' } : {}) },
      scope_ref: scopeRef, state: 'running', stage: paths[mode][0], completed_stages: [], input_sha256: inputHash,
      asset_refs: selectedAsset ? [selectedAsset] : [], run_ids: [], output_refs: [], blockers: [] } };
    const requirements = await this.requirements(task);
    task.data.blockers = requirements.blockers.map(b => b.message);
    if (task.data.blockers.length) task.data.state = 'blocked';
    const taskRef = await this.store.put(task);
    return this.status(taskRef);
  }
  async status(taskRef: FileRef) {
    const task = await this.store.load(taskRef, false) as Artifact<'task'>;
    if (task.kind !== 'task' || !task.data.workflow) throw new WorkflowError('invalid-input', '需要已登记的 UI 工作流任务');
    const requirements = await this.requirements(task);
    return { task_ref: taskRef, task, ...requirements, next_stage: ['completed', 'cancelled'].includes(task.data.state) ? null : task.data.stage,
      next_skill: task.data.workflow.mode === 'view' || ['completed', 'cancelled'].includes(task.data.state) ? null : skills[task.data.stage],
      follow_up: task.data.state === 'completed' && task.data.workflow.mode === 'new'
        ? '资产准备已结束；根据原任务的新建并执行意图，为获批资产新建 execute 任务。仅 record 模式不得自动继续执行。' : null };
  }
  async find(taskId: string) {
    const entry = (await this.store.reindex()).records.find(r => r.kind === 'task' && r.id === taskId);
    if (!entry) throw new WorkflowError('precondition', '未找到工作流任务');
    return this.status(entry.ref);
  }
  async checkpoint(taskRef: FileRef, stage: Stage, outputRefs: FileRef[]) {
    const { task, sequence, blockers } = await this.status(taskRef);
    if (['completed', 'cancelled'].includes(task.data.state) || task.data.stage !== stage) throw new WorkflowError('precondition', '阶段与当前任务不一致或任务已终结');
    if (blockers.length) return this.block(taskRef, blockers.map(b => b.message));
    if (!outputRefs.length) throw new WorkflowError('invalid-input', '完成阶段须有真实产物');
    await verifyReferences(this.root, outputRefs);
    const artifacts = await Promise.all(outputRefs.map(ref => this.store.load(ref, false)));
    const kinds: Record<Stage, Artifact['kind'][]> = { 'discover-record': ['inventory', 'recording'], 'case-design': ['asset'],
      'design-review': ['asset', 'design-review'], execute: ['run'], analyze: task.data.workflow!.mode === 'view' ? ['run'] : ['report'],
      'result-review': ['report', 'result-review'] };
    if (artifacts.some(a => !kinds[stage].includes(a.kind))) throw new WorkflowError('invalid-input', '阶段产物类型不匹配');
    const allRefs = [...task.data.output_refs, ...outputRefs];
    // output_refs 也保留交付 Markdown；阶段选择只读取原生产物清单。
    const all = await Promise.all(allRefs.filter(ref => ref.path.endsWith('/manifest.json')).map(async ref => ({ ref, artifact: await this.store.load(ref, false) })));
    const scope = task.data.scope_ref;
    const pick = <K extends Artifact['kind']>(kind: K) => artifacts.find(a => a.kind === kind) as Artifact<K> | undefined;
    const asset = pick('asset');
    let deliveryRef: FileRef | undefined;
    const candidateSources = (candidate: Artifact<'asset'>) => {
      if (!same(candidate.data.scope_ref, scope)) throw new WorkflowError('precondition', '候选范围与任务不一致');
      const recordings = all.filter(a => a.artifact.kind === 'recording');
      if (recordings.some(r => !candidate.data.recording_refs.some(ref => same(ref, r.ref)))) throw new WorkflowError('precondition', '候选未关联本任务录制');
      const inventories = all.flatMap(a => a.artifact.kind === 'inventory' ? [a.ref]
        : a.artifact.kind === 'recording' ? [(a.artifact as Artifact<'recording'>).data.inventory_ref] : []);
      if (!candidate.data.inventory_ref || !inventories.some(ref => same(ref, candidate.data.inventory_ref!))) throw new WorkflowError('precondition', '候选未关联本任务发现的功能清单');
    };
    if (task.data.workflow!.mode === 'view') {
      if (!outputRefs.every(ref => same(ref, task.data.workflow!.source_run_ref!))) throw new WorkflowError('precondition', '查看任务仅登记选定旧批次，不启动其他阶段');
    } else if (stage === 'discover-record') {
      const recording = pick('recording'), inventory = pick('inventory');
      if (task.data.workflow!.discovery === 'source') {
        if (!inventory || !same(inventory.data.scope_ref, scope) || !inventory.data.draft_refs?.length ||
            inventory.data.features.some(f => f.discovery !== 'source')) throw new WorkflowError('precondition', '源码发现须有同范围清单及带来源草稿，不伪称浏览器录制');
      } else if (!recording || recording.data.status !== 'complete' || !same(recording.data.scope_ref, scope)) throw new WorkflowError('precondition', '录制未完整登记，保存缺口后阻塞，不直接进入生成');
    } else if (stage === 'case-design') {
      if (!asset || !same(asset.data.scope_ref, scope)) throw new WorkflowError('precondition', '用例设计须交接同范围资产候选');
      candidateSources(asset);
      const assetRef = outputRefs[artifacts.indexOf(asset)], checked = await checkDesign(this.root, assetRef);
      if (checked.issues.some(i => i.blocking)) throw new WorkflowError('precondition', '候选仍有静态设计阻断');
    } else if (stage === 'design-review') {
      const review = pick('design-review');
      const subject = review && all.find(a => a.artifact.kind === 'asset' && same(a.ref, review.data.subject_ref));
      if (!review || !subject) throw new WorkflowError('precondition', '设计评估须绑定已交接候选');
      candidateSources(subject.artifact as Artifact<'asset'>);
      await new DesignReviewService(this.root, this.authorityRoot).gate(review.data.subject_ref, outputRefs[artifacts.indexOf(review)], false);
    } else if (stage === 'execute') {
      const run = pick('run');
      if (!run || run.data.task_id !== task.id || run.data.state !== 'finished' || !task.data.run_ids.includes(run.id)) throw new WorkflowError('precondition', '须交接本任务已结束的正式 run；中断/未知批次先核对');
    } else if (stage === 'analyze') {
      const report = pick('report');
      const runRef = task.data.workflow!.mode === 'analyze' ? task.data.workflow!.source_run_ref : all.find(a => a.artifact.kind === 'run')?.ref;
      if (!report || !runRef || !same(report.data.run_ref, runRef)) throw new WorkflowError('precondition', '报告须来自本任务选定的旧批次或实际执行批次');
      const checked = await checkReport(this.root, outputRefs[artifacts.indexOf(report)]);
      if (checked.check.issues.some(i => i.rule === 'R5')) throw new WorkflowError('precondition', '报告正文或统计不一致');
    } else if (stage === 'result-review') {
      const review = pick('result-review');
      const report = [...all].reverse().find(a => a.artifact.kind === 'report' && (!review || same(a.ref, review.data.subject_ref)));
      if (!report) throw new WorkflowError('precondition', '结果评估须绑定已交接报告');
      const selectedRun = task.data.workflow!.mode === 'analyze' ? task.data.workflow!.source_run_ref : all.find(a => a.artifact.kind === 'run' &&
        (a.artifact as Artifact<'run'>).data.task_id === task.id)?.ref;
      if (!selectedRun || !same((report.artifact as Artifact<'report'>).data.run_ref, selectedRun)) throw new WorkflowError('precondition', '最终报告须来自任务选定批次，不能以另一批次替换');
      const delivered = await new ResultReviewService(this.root, this.authorityRoot).deliver(report.ref, review ? outputRefs[artifacts.indexOf(review)] : undefined);
      deliveryRef = delivered.delivery_ref;allRefs.push(deliveryRef);
      // 阶段文件已交付不等于完整任务完成；保留同一任务及产物供显式续跑。
      if (delivered.completeness !== 'complete' || !delivered.independently_approved) {
        const partial = report.artifact as Artifact<'report'>;
        const blockedRef = await this.store.updateTask(taskRef, { ...task, data: { ...task.data,
          state: 'blocked', stage, output_refs: [...new Map(allRefs.map(ref => [ref.path, ref])).values()],
          blockers: ['报告完整性未通过，最终交付未完成；修复缺口后续跑当前任务。', ...partial.data.limitations] } });
        return { ...await this.status(blockedRef), delivery_ref: deliveryRef };
      }
    }
    const completed = [...new Set([...task.data.completed_stages, stage])], next = sequence.find(s => !completed.includes(s));
    const nextRef = await this.store.updateTask(taskRef, { ...task, data: { ...task.data, state: next ? 'running' : 'completed',
      stage: next ?? stage, completed_stages: completed, output_refs: [...new Map(allRefs.map(ref => [ref.path, ref])).values()], blockers: [] } });
    return { ...await this.status(nextRef), ...(deliveryRef ? { delivery_ref: deliveryRef } : {}) };
  }
  async block(taskRef: FileRef, reasons: string[]) {
    if (!reasons.length || reasons.some(r => !r.trim())) throw new WorkflowError('invalid-input', '阻塞须有具体缺口');
    const task = await this.store.load(taskRef, false) as Artifact<'task'>;
    if (task.kind !== 'task' || !task.data.workflow) throw new WorkflowError('invalid-input', '需要工作流任务');
    const ref = await this.store.updateTask(taskRef, { ...task, data: { ...task.data, state: 'blocked', blockers: reasons } });
    return this.status(ref);
  }
  async resumeTask(taskRef: FileRef) {
    const { task, blockers } = await this.status(taskRef);
    if (['completed', 'cancelled'].includes(task.data.state)) throw new WorkflowError('precondition', '终态任务不续跑；查询结果或新建明确意图任务');
    await verifyReferences(this.root, task.data.output_refs);
    if (blockers.length) return this.block(taskRef, blockers.map(b => b.message));
    // 原阶段/产物与预算全部保留；半段录制和未知写入不从临时浏览器句柄恢复。
    const ref = await this.store.updateTask(taskRef, { ...task, data: { ...task.data, state: 'running', blockers: [] } });
    return this.status(ref);
  }
}
