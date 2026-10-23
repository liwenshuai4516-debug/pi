import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { Type, type Static } from 'typebox';
import { fileRefSchema, type Artifact, type FileRef } from './contracts.js';
import { ArtifactStore } from './store.js';
import { DesignReviewService } from './review.js';
import { preflightEnvironment } from './diagnostics.js';
import { PrivateEvidence, privateCaptureConfig } from './private-evidence.js';
import { validateEnvironment } from './environment.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';
import { recoveryPlan } from './recovery.js';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
export const runRequestSchema = Type.Object({ task_id: id, request_id: id,
  asset_ref: fileRefSchema, review_ref: fileRefSchema, environment_ref: fileRefSchema, config_ref: fileRefSchema,
  timeout_ms: Type.Integer({ minimum: 1000, maximum: 600000 }),
  parent_run_ref: Type.Optional(fileRefSchema),
}, { additionalProperties: false });
export type RunRequest = Static<typeof runRequestSchema>;
const validate = new Ajv({ strict: true, allErrors: true }).compile(runRequestSchema);
const execute = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const identity = (task: string, request: string) => `run-${sha256(json([task, request])).slice(0, 32)}`;
const inputKey = (input: RunRequest) => json([input.task_id, input.request_id, input.asset_ref.path, input.asset_ref.sha256,
  input.review_ref.path, input.review_ref.sha256, input.environment_ref.path, input.environment_ref.sha256,
  input.config_ref.path, input.config_ref.sha256, input.timeout_ms, input.parent_run_ref ?? null]);
type NativeStep = { title: string; steps?: NativeStep[]; [key: string]: unknown };
type NativeAttempt = { retry: number; status: string; steps?: NativeStep[]; errors?: unknown[];
  attachments?: { path?: string; [key: string]: unknown }[] };
type NativeSpec = { id?: string; file: string; title: string; tests: { projectName: string; results: NativeAttempt[] }[] };
type NativeSuite = { specs?: NativeSpec[]; suites?: NativeSuite[] };
const nativeSpecs = (suite: NativeSuite): NativeSpec[] => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(nativeSpecs)];
const nativeSteps = (steps: NativeStep[]): NativeStep[] => steps.flatMap(s => [s, ...nativeSteps(s.steps ?? [])]);

/** 只登记业务批次和调用原生 CLI；测试调度、断言与生命周期仍由 Playwright 完成。 */
export class UiRunService {
  readonly store: ArtifactStore;
  constructor(readonly root: string, readonly authorityRoot: string) { this.store = new ArtifactStore(root); }
  async status(taskId: string, requestId: string) {
    if (![taskId, requestId].every(v => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(v))) throw new WorkflowError('invalid-input', '任务或请求 ID 无效');
    const catalog = await this.store.reindex();
    const entry = catalog.records.find(r => r.kind === 'run' && r.id === identity(taskId, requestId));
    if (!entry) throw new WorkflowError('precondition', '未找到正式执行批次');
    const run = await this.store.load(entry.ref, false) as Artifact<'run'>;
    await verifyReferences(this.root, run.data.output_refs);
    return { run_ref: entry.ref, run, replayed: true };
  }
  async start(input: RunRequest, signal?: AbortSignal) {
    if (!validate(input)) throw new WorkflowError('invalid-input', '正式执行请求不符合契约');
    const root = await realpath(this.root), runId = identity(input.task_id, input.request_id), base = `qa/ui/runs/${runId}`;
    const release = await this.store.acquireResource(`execution:${input.task_id}`);
    let runRef: FileRef | undefined;
    try {
      const catalog = await this.store.reindex();
      if (catalog.records.some(r => r.kind === 'run' && r.id === runId)) {
        const savedInput = JSON.parse(await readFile(await workspacePath(root, `${base}/input.json`), 'utf8'));
        if (inputKey(savedInput) !== inputKey(input)) throw new WorkflowError('precondition', '同一执行请求不能改变输入');
        // 查看旧请求不再预检或执行，不要求旧资产仍是当前有效版本。
        return await this.status(input.task_id, input.request_id);
      }
      if (signal?.aborted) throw new WorkflowError('cancelled', '正式执行已取消');
      await new DesignReviewService(root, this.authorityRoot).gate(input.asset_ref, input.review_ref);
      const asset = await this.store.load(input.asset_ref) as Artifact<'asset'>;
      const taskEntry = catalog.records.find(r => r.kind === 'task' && r.id === input.task_id);
      if (!taskEntry) throw new WorkflowError('precondition', '缺少已登记任务');
      const task = await this.store.load(taskEntry.ref) as Artifact<'task'>;
      if (!['execute', 'resume', 'rerun-failed', 'rerun-all'].includes(task.data.intent) || !same(task.data.scope_ref, asset.data.scope_ref)) {
        throw new WorkflowError('precondition', '正式执行需要同范围的执行任务');
      }
      const scope = await this.store.load(asset.data.scope_ref) as Artifact<'scope'>;
      const cases = await this.store.load(asset.data.cases_ref) as Artifact<'cases'>;
      const intent = task.data.intent;
      if ((intent !== 'execute') !== !!input.parent_run_ref) throw new WorkflowError('precondition', '续跑/重跑须绑定父批次；普通执行不能伪装子集');
      const recovery = input.parent_run_ref ? await recoveryPlan(root, input.parent_run_ref, intent as 'resume' | 'rerun-failed' | 'rerun-all') : undefined;
      if (recovery?.blockers.length) throw new WorkflowError('precondition', recovery.blockers.join('；'));
      if (recovery) {
        const parent = await this.store.load(input.parent_run_ref!, false) as Artifact<'run'>;
        if (!same(parent.data.asset_ref, input.asset_ref) || (task.data.workflow?.source_run_ref && !same(task.data.workflow.source_run_ref, input.parent_run_ref!))) {
          throw new WorkflowError('precondition', '恢复须沿用父批次同一资产修订及任务父引用；修改脚本须重新设计并新建执行');
        }
      }
      const selectedCases = recovery ? cases.data.cases.filter(c => recovery.selected.some(p => p.case_id === c.case_id && p.data_row_id === c.data_row_id && p.browser_project === c.browser_project)) : cases.data.cases;
      const selectedBindings = asset.data.bindings!.filter(b => selectedCases.some(c => c.case_id === b.case_id));
      // 使用原生 grep 选择完整 test；标题后缀必须唯一，不能误带未选测试。
      if (recovery && selectedBindings.some(b => asset.data.bindings!.some(other => other.case_id !== b.case_id &&
        (other.test_title.endsWith(' ' + b.test_title) || other.test_title === b.test_title)))) throw new WorkflowError('precondition', '恢复测试标题不唯一，不能可靠筛选');
      const selectionRef = recovery ? await this.store.putFile(`${base}/selection.json`, json(recovery)) : undefined;
      await verifyReferences(root, [input.environment_ref, input.config_ref]);
      if (!asset.data.files.some(r => same(r, input.config_ref))) throw new WorkflowError('precondition', '执行配置必须属于获批修订');
      const environment = validateEnvironment(JSON.parse(await readFile(await workspacePath(root, input.environment_ref.path), 'utf8')));
      if (environment.environment_id !== scope.data.environment_id || environment.role !== scope.data.role ||
          (scope.data.base_url && environment.base_url !== scope.data.base_url)) throw new WorkflowError('precondition', '当前执行环境与获批范围不符');
      if (cases.data.cases.some(c => c.browser_project !== 'chromium')) throw new WorkflowError('precondition', '首期正式执行仅支持 chromium 项目');
      const require = createRequire(join(root, 'package.json'));
      let cli: string;
      try {
        const metadataPath = require.resolve('playwright/package.json'), metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (metadata.version !== '1.62.1') throw new WorkflowError('incompatible-version', '正式执行仅验证过 Playwright 1.62.1');
        if (typeof metadata.bin?.playwright !== 'string') throw new Error('missing bin');
        cli = join(dirname(metadataPath), metadata.bin.playwright);
      } catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError('missing-capability', '缺少原生 Playwright CLI'); }
      const inputRef = await this.store.putFile(`${base}/input.json`, json(input));
      const reportPath = join(root, base, 'native.json'), outputDir = join(root, base, 'output');
      let capture: PrivateEvidence | undefined;
      const configRef = await this.store.putFile(`${base}/playwright.config.mjs`,
        `import base from ${JSON.stringify(pathToFileURL(await workspacePath(root, input.config_ref.path)).href)};\n` +
        `export default {...base,...${JSON.stringify({ testDir: root,
          testMatch: [...new Set(selectedBindings.map(b => join(root, b.script_ref.path)))],
          retries: 0, repeatEach: 1, workers: 1, fullyParallel: false, forbidOnly: true, globalTimeout: input.timeout_ms,
          outputDir, reporter: [['json', { outputFile: reportPath }]],
          ...(asset.data.compiler_config_ref ? { tsconfig: await workspacePath(root, asset.data.compiler_config_ref.path) } : {}),
          projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
        })},${environment.auth.kind !== 'none' ? privateCaptureConfig : ''}grep:${recovery ? `new RegExp(${JSON.stringify('(?:^| )(?:' + selectedBindings.map(b => b.test_title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')})` : 'undefined'},grepInvert:undefined,shard:null,use:{...base.use,baseURL:${JSON.stringify(environment.base_url)},` +
        `uiEnvironment:${JSON.stringify(environment)},uiProjectRoot:${JSON.stringify(root)},` +
        `uiOwner:${JSON.stringify({ task_id: input.task_id, kind: 'run', id: runId })},` +
        `storageState:${environment.auth.kind === 'none' ? 'undefined' : `process.env[${JSON.stringify(environment.auth.reference)}]`},` +
        `headless:true,trace:'retain-on-failure',screenshot:'only-on-failure'}};\n`);
      const args = [cli, 'test', '--config', join(root, configRef.path)];
      const processToken = sha256(inputKey(input));
      const run: Artifact<'run'> = { schema_version: '1.0', kind: 'run', id: runId, created_at: new Date().toISOString(), data: {
        task_id: input.task_id, request_id: input.request_id, asset_ref: input.asset_ref,
        ...(recovery ? { parent_run_id: recovery.parent_run_id } : {}),
        environment_id: environment.environment_id, deployment_version: environment.deployment_version, role: environment.role,
        plan: selectedCases.map(c => ({ instance_id: `instance-${sha256(json([c.case_id, c.data_row_id, c.browser_project])).slice(0, 32)}`,
          case_id: c.case_id, revision: asset.data.revision, data_row_id: c.data_row_id, browser_project: c.browser_project })),
        state: 'pending', command: [process.execPath, ...args], process_token: processToken, output_refs: [inputRef, configRef, ...(selectionRef ? [selectionRef] : [])],
      } };
      const reservation = await this.store.reserveRun(run); runRef = reservation.ref;
      if (!reservation.created) return await this.status(input.task_id, input.request_id);
      const preflight = await preflightEnvironment(root, environment, Math.min(input.timeout_ms, 30000), signal);
      if (preflight.status === 'completed') {
        try { capture = await PrivateEvidence.create(root, this.authorityRoot, environment, base); }
        catch { preflight.status = 'blocked'; preflight.check = 'private-evidence'; }
      }
      const preflightRef = await this.store.putFile(`${base}/preflight.json`, json(preflight));
      let status = preflight.status === 'completed' ? 'completed' : 'blocked';
      const evidence: FileRef[] = [inputRef, configRef, preflightRef, ...(selectionRef ? [selectionRef] : [])];
      const collectionProblems: string[] = [];
      if (preflight.status === 'completed' && !signal?.aborted) {
        await new DesignReviewService(root, this.authorityRoot).gate(input.asset_ref, input.review_ref);
        await verifyReferences(root, [input.environment_ref, input.config_ref]);
        const intent = await this.store.putFile(`${base}/launch-intent.json`, json({ command: process.execPath, args,
          process_token: processToken, config_ref: configRef, created_at: new Date().toISOString() }));
        evidence.push(intent);
        const running = execute(process.execPath, args, { cwd: root, signal, timeout: input.timeout_ms + 5000,
          maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGINT', env: { ...process.env, PI_UI_PRIVATE_EVIDENCE_DIR: undefined, ...capture?.env, PI_UI_RUN_PROCESS_TOKEN: processToken } });
        const kill = setTimeout(() => running.child.kill('SIGKILL'), input.timeout_ms + 10000);
        const completion = running.then(r => ({ code: 0 as number | string | null, signal: null as string | null, stdout: r.stdout, stderr: r.stderr }),
          (e: { code?: number | string; signal?: string; stdout?: string; stderr?: string }) => ({ code: e.code ?? null,
            signal: e.signal ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' })).finally(() => clearTimeout(kill));
        const startedRef = await this.store.putFile(`${base}/process-started.json`, json({ intent_ref: intent,
          process_token: processToken, pid: running.child.pid ?? null, observed_at: new Date().toISOString() }));
        evidence.push(startedRef);
        if (running.child.pid) runRef = await this.store.markRunStarted(runRef, running.child.pid, processToken);
        const rawResult = await completion;
        const result = capture ? await capture.process(rawResult) : rawResult;
        evidence.push(await this.store.putFile(`${base}/process.json`, json({ ...result, command: process.execPath, args,
          intent_ref: intent, started_ref: startedRef, process_token: processToken })));
        status = result.signal || typeof result.code !== 'number' ? 'unknown' : [0, 1].includes(result.code) ? 'completed' : 'blocked';
        try {
          if (capture) evidence.push(await capture.publish(this.store));
          const bytes = await readFile(reportPath), report = JSON.parse(bytes.toString());
          const rawRef = await this.store.putFile(`${base}/report.json`, bytes); evidence.push(rawRef);
          if (!Array.isArray(report.suites)) throw new Error('missing suites');
          if (!Array.isArray(report.errors) || report.errors.length) {
            collectionProblems.push('原生报告存在全局错误；保留超时或启动错误原文，业务副作用须核对');
            status = 'unknown';
          }
          const bindings = asset.data.bindings!;
          const specs: NativeSpec[] = report.suites.flatMap(nativeSpecs);
          for (const spec of specs) for (const test of spec.tests) for (const attempt of test.results) {
            const attachments: FileRef[] = [];
            for (const attachment of attempt.attachments ?? []) {
              if (!attachment.path) continue;
              const path = relative(root, attachment.path).replaceAll('\\', '/');
              if (!path.startsWith(`${base}/output/`)) throw new WorkflowError('precondition', '执行附件不属于本批次');
              const bytes = await readFile(await workspacePath(root, path));
              attachments.push({ path, sha256: sha256(bytes) });
            }
            const binding = bindings.find(b => b.test_title === spec.title &&
              b.script_ref.path === relative(root, resolve(root, spec.file)).replaceAll('\\', '/'));
            const instance = run.data.plan.find(p => p.case_id === binding?.case_id && p.browser_project === test.projectName);
            if (!binding || !instance) {
              collectionProblems.push('实际启动测试无法对应冻结 case/实例；保留原始记录，不推断通过');
              status = status === 'unknown' ? status : 'blocked';
            }
            evidence.push(...attachments);
            const record = { run_id: runId, case_id: binding?.case_id ?? null,
              instance_id: instance?.instance_id ?? null,
              attempt: attempt.retry, native_status: attempt.status, native_test_id: spec.id ?? null, script_file: spec.file,
              test_title: spec.title, steps: attempt.steps ?? [], errors: attempt.errors ?? [],
              assertion_steps: (binding?.assertion_ids ?? []).map(id => ({ assertion_id: id,
                steps: nativeSteps(attempt.steps ?? []).filter(s => s.title === id || s.title.startsWith(id + ' ')) })),
              attachments: attempt.attachments ?? [], evidence_refs: attachments, raw_ref: rawRef };
            evidence.push(await this.store.putFile(`${base}/attempts/${sha256(json([spec.file, spec.title, test.projectName, attempt.retry]))}.json`, json(record)));
          }
        } catch {
          collectionProblems.push('原生报告或本批次附件无法完整读取；保留已有证据');
          status = status === 'unknown' ? status : 'blocked';
        }
        try { await new DesignReviewService(root, this.authorityRoot).gate(input.asset_ref, input.review_ref);
          await verifyReferences(root, [input.environment_ref, input.config_ref]); }
        catch { collectionProblems.push('执行期间资产、环境、规则或批准证据变化；结果不能作为当前修订的完整证据');
          status = status === 'unknown' ? status : 'blocked'; }
        const code = typeof result.code === 'number' ? result.code : null;
        const interrupted = signal?.aborted || status === 'unknown';
        if (signal?.aborted) status = 'cancelled';
        const summary = await this.store.putFile(`${base}/execution-summary.json`, json({ status, formal_run: true,
          input_ref: inputRef, evidence_refs: evidence, collection_problems: collectionProblems, test_outcome: 'see-native-report',
          note: '进程完成不等于用例通过；统计与完整性由结果对账阶段判定' }));
        runRef = await this.store.finishRun(runRef, code, [...evidence, summary], interrupted);
      } else {
        if (signal?.aborted) status = 'cancelled';
        const summary = await this.store.putFile(`${base}/execution-summary.json`, json({ status, formal_run: true,
          input_ref: inputRef, evidence_refs: evidence, business_started: false }));
        runRef = await this.store.finishRun(runRef, null, [...evidence, summary]);
      }
      return { run_ref: runRef, run: await this.store.load(runRef, false) as Artifact<'run'>, replayed: false };
    } catch (error) {
      throw new WorkflowError(error instanceof WorkflowError ? error.category : 'runner-error',
        error instanceof WorkflowError ? error.message : '正式执行未确认完成；查询已登记批次，不自动重放', false, runRef ? [runRef] : []);
    } finally { await release(); }
  }
}
