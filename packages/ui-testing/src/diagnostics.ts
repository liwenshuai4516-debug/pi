import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { Type, type Static } from 'typebox';
import { fileRefSchema, type Artifact, type FileRef } from './contracts.js';
import { ArtifactStore } from './store.js';
import { authState, validateEnvironment, type UiEnvironment } from './environment.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';
import { PrivateEvidence, privateCaptureConfig } from './private-evidence.js';

export const diagnosticSpecSchema = Type.Object({
  environment_ref: fileRefSchema, config_ref: fileRefSchema,
  control_environment_ref: Type.Optional(fileRefSchema),
  timeout_ms: Type.Integer({ minimum: 1000, maximum: 120000 }),
  probes: Type.Array(Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }),
    environment_ref: fileRefSchema, config_ref: fileRefSchema,
    mutation_refs: Type.Array(fileRefSchema, { minItems: 1 }), description: Type.String({ minLength: 1 }),
    assertion_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
}, { additionalProperties: false });
export type DiagnosticSpec = Static<typeof diagnosticSpecSchema>;
const validate = new Ajv({ strict: true, allErrors: true }).compile(diagnosticSpecSchema);
const execute = promisify(execFile);
const json = (input: unknown) => JSON.stringify(input, null, 2) + '\n';
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;

type Step = { title: string; error?: { message?: string }; steps?: Step[] };
type NativeResult = { status: string; retry: number; steps?: Step[]; attachments?: { name?: string; body?: string; path?: string }[] };
type NativeTest = { expectedStatus: string; results: NativeResult[] };
type NativeSpec = { title: string; file: string; tests: NativeTest[] };
type NativeSuite = { specs: NativeSpec[]; suites?: NativeSuite[] };
type NativeReport = { errors: unknown[]; suites: NativeSuite[] };
const steps = (input: Step[]): Step[] => input.flatMap(s => [s, ...steps(s.steps ?? [])]);

export async function preflightEnvironment(root: string, env: UiEnvironment, timeout: number, signal?: AbortSignal) {
  const { chromium, expect } = createRequire(join(root, 'package.json'))('playwright/test') as typeof import('@playwright/test');
  let phase = 'auth-reference', passed = false;
  try {
    const storageState = await authState(env, root);
    phase = 'browser';
    const browser = await chromium.launch({ headless: true, timeout });
    const abort = () => { void browser.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('cancelled');
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      phase = 'site';
      const response = await page.goto(env.base_url, { timeout: env.timeout_ms, waitUntil: 'domcontentloaded' });
      if (!response?.ok() || new URL(page.url()).origin !== new URL(env.base_url).origin) throw new Error('unavailable');
      phase = 'identity';
      await expect(page.locator(env.identity.selector)).toHaveText(env.identity.text, { timeout: env.timeout_ms });
      phase = 'initial-state';
      await expect(page.locator(env.initial_state.selector)).toHaveText(env.initial_state.text, { timeout: env.timeout_ms });
      passed = !signal?.aborted;
    } finally { signal?.removeEventListener('abort', abort); await browser.close(); }
  } catch { /* 仅登记阶段，底层认证错误不复制到普通业务资产。 */ }
  return { status: passed ? 'completed' : 'blocked', check: phase, environment_id: env.environment_id,
    deployment_version: env.deployment_version, role: env.role };
}

/** JSON reporter 提供原始步骤；启动失败和业务断言失败必须分开核对。 */
export function checkDiagnosticReport(root: string, asset: Artifact<'asset'>, report: NativeReport, expected: string[] = []): string[] {
  const problems: string[] = [];
  if (!Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.suites)) return ['runner 报告缺失或包含全局错误'];
  const specs = report.suites.flatMap(function walk(s): NativeSpec[] { return [...s.specs, ...(s.suites ?? []).flatMap(walk)]; });
  const bindings = asset.data.bindings ?? [];
  if (specs.length !== bindings.length) problems.push('实际测试数与冻结 case 映射不符');
  for (const binding of bindings) {
    const matching = specs.filter(s => s.title === binding.test_title &&
      relative(root, resolve(root, s.file)).replaceAll('\\', '/') === binding.script_ref.path);
    if (matching.length !== 1 || matching[0].tests.length !== 1) { problems.push(`case 映射缺失或重复：${binding.case_id}`); continue; }
    const test = matching[0].tests[0], result = test.results[0];
    if (test.expectedStatus !== 'passed' || test.results.length !== 1 || !result || result.retry !== 0) {
      problems.push(`case 被跳过、改为预期失败或发生重试：${binding.case_id}`); continue;
    }
    const all = steps(result.steps ?? []), targets = binding.assertion_ids.filter(id => expected.includes(id));
    for (const attachment of result.attachments ?? []) if (attachment.name === 'ui-data-lifecycle') {
      try {
        if (!attachment.body) throw new Error('missing lifecycle body');
        const lifecycle = JSON.parse(Buffer.from(attachment.body, 'base64').toString());
        if (!Array.isArray(lifecycle.residual) || !Array.isArray(lifecycle.records)) throw new Error('missing lifecycle records');
        const retained = new Set(lifecycle.records.filter((r: { cleanup_state: string; cleanup_reason?: string }) =>
          r.cleanup_state === 'retained' && r.cleanup_reason).map((r: { business_key: string }) => r.business_key));
        if (lifecycle.residual.some((key: string) => !retained.has(key)) ||
            lifecycle.records.some((r: { cleanup_state: string; business_key: string }) =>
              r.cleanup_state !== 'cleaned' && !(r.cleanup_state === 'retained' && retained.has(r.business_key)))) throw new Error('unconfirmed cleanup');
      } catch { problems.push(`诊断数据清理失败或证据缺失：${binding.case_id}`); }
    }
    const find = (id: string) => all.filter(s => s.title === id || s.title.startsWith(id + ' '));
    if (!expected.length) {
      if (result.status !== 'passed') problems.push(`正对照未通过：${binding.case_id}`);
      for (const id of binding.assertion_ids) if (find(id).length !== 1 || find(id)[0].error) problems.push(`正对照缺少成功断言步骤：${id}`);
    } else if (targets.length) {
      if (result.status !== 'failed') problems.push(`错误结果未被断言检出：${binding.case_id}`);
      for (const id of targets) {
        const found = find(id);
        if (found.length !== 1 || !/expect\s*(?:\(|\.)/.test(found[0].error?.message ?? '')) problems.push(`失败不属于预期的 expect 断言步骤：${id}`);
      }
    } else if (result.status !== 'passed') problems.push(`非目标 case 发生失败，不能作为断言自检证明：${binding.case_id}`);
  }
  return problems;
}

/** 使用原版 Playwright CLI/config/reporter；诊断独立保存且永不计入正式 run。 */
export async function runDesignDiagnostics(root: string, assetRef: FileRef, reviewRef: FileRef, specRef: FileRef, signal?: AbortSignal,
  onStart?: (inputRef: FileRef) => Promise<void>, authorityRoot?: string) {
  root = await realpath(root);
  const store = new ArtifactStore(root), asset = await store.load(assetRef) as Artifact<'asset'>;
  await verifyReferences(root, specRef);
  const spec: DiagnosticSpec = JSON.parse(await readFile(await workspacePath(root, specRef.path), 'utf8'));
  if (!validate(spec)) throw new WorkflowError('invalid-input', '诊断计划不符合环境、错误结果和断言映射契约');
  if (asset.kind !== 'asset' || !asset.data.bindings?.length) throw new WorkflowError('invalid-input', '诊断输入不是可映射的候选');
  const inputs = [specRef, spec.environment_ref, spec.config_ref, ...(spec.control_environment_ref ? [spec.control_environment_ref] : []),
    ...spec.probes.flatMap(p => [p.environment_ref, p.config_ref, ...p.mutation_refs])];
  if (inputs.some(r => !asset.data.files.some(f => same(f, r)))) throw new WorkflowError('precondition', '诊断配置、环境和错误副本来源必须纳入获批修订');
  await verifyReferences(root, inputs);
  const review = await store.load(reviewRef) as Artifact<'design-review'>;
  if (review.kind !== 'design-review' || review.data.decision !== 'approved' || !same(review.data.subject_ref, assetRef)) {
    throw new WorkflowError('review-rejected', '诊断需要匹配候选摘要的设计评估，诊断本身不登记运行授权');
  }
  if (new Set(spec.probes.map(p => p.id)).size !== spec.probes.length || spec.probes.some(p => p.id === 'positive')) throw new WorkflowError('invalid-input', '诊断探针 ID 重复或使用保留名称');
  const assertions = asset.data.bindings.flatMap(b => b.assertion_ids), tested = spec.probes.flatMap(p => p.assertion_ids);
  if (tested.some(id => !assertions.includes(id)) || assertions.some(id => !tested.includes(id))) throw new WorkflowError('precondition', '断言自检计划缺失或引用未知断言');
  const environments = await Promise.all([spec.environment_ref, ...spec.probes.map(p => p.environment_ref)].map(async ref =>
    validateEnvironment(JSON.parse(await readFile(await workspacePath(root, ref.path), 'utf8')))));
  const target = environments[0];
  const control = spec.control_environment_ref ? validateEnvironment(JSON.parse(await readFile(await workspacePath(root, spec.control_environment_ref.path), 'utf8'))) : target;
  const scope = await store.load(asset.data.scope_ref) as Artifact<'scope'>;
  if (environments[0].environment_id !== scope.data.environment_id || environments.some(e => e.role !== scope.data.role) ||
      (scope.data.base_url && environments[0].base_url !== scope.data.base_url)) {
    throw new WorkflowError('precondition', '正对照环境与测试范围不符，或错误副本角色发生变化');
  }
  if (control.role !== scope.data.role || control.isolation !== 'context' || environments.some(e => e.isolation !== 'context') ||
      environments.slice(1).some(e => [target, control].some(c => new URL(e.base_url).origin === new URL(c.base_url).origin))) {
    throw new WorkflowError('precondition', '诊断首期仅支持 context 隔离；错误应用副本必须与正对照使用不同 origin');
  }
  if (signal?.aborted) throw new WorkflowError('cancelled', '诊断已取消');
  const require = createRequire(join(root, 'package.json'));
  let cli: string;
  try {
    const metadataPath = require.resolve('playwright/package.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.version !== '1.62.1') throw new WorkflowError('incompatible-version', '诊断仅验证过 Playwright 1.62.1');
    if (typeof metadata.bin?.playwright !== 'string') throw new Error('missing bin');
    cli = join(dirname(metadataPath), metadata.bin.playwright);
  }
  catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError('missing-capability', '被测项目没有可用的 Playwright CLI'); }
  const id = `diagnostic-${randomUUID()}`, base = `${posix.dirname(assetRef.path)}/diagnostics/${id}`;
  const inputRef = await store.putFile(`${base}/input.json`, json({ purpose: 'design-validation', formal_run: false,
    asset_ref: assetRef, review_ref: reviewRef, spec_ref: specRef, environments, control }));
  await onStart?.(inputRef);
  const output: { id: string; report_ref?: FileRef; process_ref?: FileRef; evidence_refs: FileRef[]; problems: string[] }[] = [];
  let targetPreflightRef: FileRef | undefined, targetPassed = true, unknownEffects = false;
  if (spec.control_environment_ref) {
    const result = await preflightEnvironment(root, target, spec.timeout_ms, signal);
    targetPreflightRef = await store.putFile(`${base}/target-preflight.json`, json(result));
    targetPassed = result.status === 'completed';
    if (!targetPassed) output.push({ id: 'target', evidence_refs: [targetPreflightRef], problems: [`目标环境前置检查失败：${result.check}`] });
  }
  const rounds = [{ id: 'positive', config_ref: spec.config_ref, assertion_ids: [] as string[] }, ...spec.probes];
  for (const [index, round] of rounds.entries()) {
    if (signal?.aborted || !targetPassed) break;
    const directory = `${base}/${round.id}`, env = index === 0 ? control : environments[index];
    const preflightResult = await preflightEnvironment(root, env, spec.timeout_ms, signal);
    const preflightRef = await store.putFile(`${directory}/preflight.json`, json(preflightResult));
    if (preflightResult.status !== 'completed') {
      output.push({ id: round.id, evidence_refs: [preflightRef], problems: [`前置检查失败：${preflightResult.check}，未运行候选脚本`] });
      break;
    }
    const reportPath = join(root, directory, 'native.json'), outputDir = join(root, directory, 'output');
    const capture = await PrivateEvidence.create(root, authorityRoot, env, directory);
    const configRef = await store.putFile(`${directory}/playwright.config.mjs`,
      `import base from ${JSON.stringify(pathToFileURL(await workspacePath(root, round.config_ref.path)).href)};\n` +
      `export default {...base,...${JSON.stringify({ testDir: root, testMatch: [...new Set(asset.data.bindings.map(b => join(root, b.script_ref.path)))],
        retries: 0, repeatEach: 1, workers: 1, fullyParallel: false, forbidOnly: true, globalTimeout: spec.timeout_ms,
        outputDir, reporter: [['json', { outputFile: reportPath }]],
        ...(asset.data.compiler_config_ref ? { tsconfig: await workspacePath(root, asset.data.compiler_config_ref.path) } : {}),
        projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
      })},${capture ? privateCaptureConfig : ''}grep:undefined,grepInvert:undefined,shard:null,use:{...base.use,baseURL:${JSON.stringify(env.base_url)},` +
      `uiEnvironment:${JSON.stringify(env)},uiProjectRoot:${JSON.stringify(root)},uiOwner:${JSON.stringify({ task_id: id, kind: 'recording', id })},` +
      `storageState:${env.auth.kind === 'none' ? 'undefined' : `process.env[${JSON.stringify(env.auth.reference)}]`},headless:true,trace:${capture ? "'on'" : "'retain-on-failure'"}}};\n`);
    const args = [cli, 'test', '--config', join(root, configRef.path)];
    const processToken = randomUUID();
    const intentRef = await store.putFile(`${directory}/launch-intent.json`, json({ command: process.execPath, args,
      config_ref: configRef, process_token: processToken, created_at: new Date().toISOString() }));
    // 超时/取消不重试业务动作；原生 fixture teardown 及其残留由后续诊断证据核对。
    const running = execute(process.execPath, args, { cwd: root, signal,
      env: { ...process.env, PI_UI_PRIVATE_EVIDENCE_DIR: undefined, ...capture?.env, PI_UI_DIAGNOSTIC_PROCESS_TOKEN: processToken },
      timeout: spec.timeout_ms + 5000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGINT' });
    // 先挂接拒绝处理，再等待存盘；取消不能产生未处理的 Promise 拒绝。
    const kill = setTimeout(() => running.child.kill('SIGKILL'), spec.timeout_ms + 10000);
    const completion = running
      .then(r => ({ code: 0 as number | string | null, signal: null as string | null, stdout: r.stdout, stderr: r.stderr }),
        (error: { code?: number | string; signal?: string; stdout?: string; stderr?: string }) => ({ code: error.code ?? null,
          signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
      .finally(() => clearTimeout(kill));
    const startedRef = await store.putFile(`${directory}/process-started.json`, json({ intent_ref: intentRef,
      process_token: processToken, pid: running.child.pid ?? null, observed_at: new Date().toISOString() }));
    const rawProcessResult = await completion;
    const processResult = capture ? await capture.process(rawProcessResult) : rawProcessResult;
    const processRef = await store.putFile(`${directory}/process.json`, json({ command: process.execPath, args,
      config_ref: configRef, intent_ref: intentRef, started_ref: startedRef, process_token: processToken, ...processResult }));
    const evidence: FileRef[] = [preflightRef, configRef, intentRef, startedRef], problems: string[] = [];
    let reportRef: FileRef | undefined;
    try {
      if (capture) evidence.push(await capture.publish(store));
      const bytes = await readFile(reportPath), report: NativeReport = JSON.parse(bytes.toString());
      reportRef = await store.putFile(`${directory}/report.json`, bytes);
      problems.push(...checkDiagnosticReport(root, asset, report, round.assertion_ids));
      const specs = report.suites.flatMap(function walk(s): NativeSpec[] { return [...s.specs, ...(s.suites ?? []).flatMap(walk)]; });
      for (const attachment of specs.flatMap(s => s.tests.flatMap(t => t.results.flatMap(r => r.attachments ?? [])))) {
        if (!attachment.path) continue;
        const path = relative(root, attachment.path).replaceAll('\\', '/');
        if (!path.startsWith(directory + '/output/')) throw new WorkflowError('precondition', '诊断附件不属于本次输出目录');
        const bytes = await readFile(await workspacePath(root, path));
        evidence.push({ path, sha256: sha256(bytes) });
      }
    } catch (error) { problems.push(error instanceof Error ? error.message : '原生报告或附件无法读取'); }
    const expectedCode = index === 0 ? 0 : 1;
    if (processResult.signal || typeof processResult.code !== 'number') unknownEffects = true;
    if (processResult.code !== expectedCode || processResult.signal || signal?.aborted) problems.push('进程未按预期完成，不认定断言自检有效');
    output.push({ id: round.id, ...(reportRef ? { report_ref: reportRef } : {}), process_ref: processRef, evidence_refs: evidence, problems });
    if (problems.length) break;
  }
  const integrity: string[] = [];
  try { await verifyReferences(root, inputs); await verifyReferences(root, asset); }
  catch { integrity.push('诊断期间候选或输入摘要变化，不登记运行证明；保留已收集证据'); }
  const complete = !integrity.length && output.length === rounds.length && output.every(r => !r.problems.length) && !signal?.aborted;
  const summary = { schema_version: '1.0', purpose: 'design-validation', formal_run: false, asset_ref: assetRef,
    review_ref: reviewRef, spec_ref: specRef, environment_ref: spec.environment_ref, input_ref: inputRef,
    ...(targetPreflightRef ? { target_preflight_ref: targetPreflightRef } : {}), unknown_effects: unknownEffects,
    status: complete ? 'validated' : signal?.aborted ? 'cancelled' : 'blocked', integrity_problems: integrity, rounds: output };
  const summaryRef = await store.putFile(`${base}/summary.json`, json(summary));
  return { summary_ref: summaryRef, ...summary };
}
