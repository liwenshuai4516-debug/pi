import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Artifact, FileRef } from './contracts.js';
import { ArtifactStore } from './store.js';
import { DesignReviewService } from './review.js';
import { runDesignDiagnostics } from './diagnostics.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

type DiagnosticResult = Awaited<ReturnType<typeof runDesignDiagnostics>>;
type Request = { request_id: string; asset_ref: FileRef; review_ref: FileRef; spec_ref: FileRef;
  module_ids?: string[];
  state: 'pending' | 'completed' | 'failed' | 'unknown'; started: boolean; input_ref?: FileRef; summary_ref?: FileRef; error?: string };
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const key = (asset: FileRef, review: FileRef) => sha256(json([asset, review]));
// 老记录若没有范围信息，保持保守阻断；新记录只阻断有交集的模块。
const unresolved = (request: Request, modules: string[]) =>
  (request.state === 'pending' || request.state === 'unknown') &&
  (!request.module_ids?.length || request.module_ids.some(id => modules.includes(id)));
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
async function requests(directory: string): Promise<Request[]> {
  try { return await Promise.all((await readdir(directory)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(directory, n), 'utf8')))); }
  catch (error) { if (missing(error)) return []; throw error; }
}
async function rulesVersion() {
  return sha256(Buffer.concat(await Promise.all(['diagnostics.js', 'runtime-admission.js'].map(n => readFile(new URL(n, import.meta.url))))));
}

/** 仅把受控诊断路径的结果登记为运行证明；项目中的 JSON 不能自行授予权限。 */
export class RuntimeAdmissionService {
  readonly design: DesignReviewService;
  private readonly directory: string;
  constructor(readonly root: string, readonly authorityRoot: string) {
    this.design = new DesignReviewService(root, authorityRoot);
    this.directory = join(authorityRoot, 'runtime');
  }
  async status(requestId: string): Promise<Request & { runtime_ready: boolean }> {
    const request = (await requests(join(this.directory, 'requests'))).find(r => r.request_id === requestId);
    if (!request) throw new WorkflowError('precondition', '没有找到该诊断请求');
    let ready = false;
    if (request.state === 'completed') {
      try { await this.design.gate(request.asset_ref, request.review_ref); ready = true; }
      catch { /* 展示原始状态，失效或缺证据时不声明当前可运行。 */ }
    }
    return { ...request, runtime_ready: ready };
  }
  /** 只查询当前权威证明；不因新请求 ID 重跑诊断，不读取私密认证正文。 */
  async reuse(assetRef: FileRef, reviewRef: FileRef, specRef: FileRef) {
    await this.design.gate(assetRef, reviewRef);
    const summaryRef = await verifyRuntimeAdmission(this.root, this.authorityRoot, assetRef, reviewRef);
    const result = JSON.parse(await readFile(await workspacePath(this.root, summaryRef.path), 'utf8')) as DiagnosticResult;
    if (!same(result.spec_ref, specRef)) throw new WorkflowError('precondition', '诊断计划与当前输入不一致，不能复用');
    await verifyReferences(this.root, specRef);
    return { ...result, summary_ref: summaryRef, runtime_ready: true, reused: true,
      applicability: '仅当前登记的资产、规则、依赖、配置、部署、角色和数据声明；真实环境与数据仍须每批预检，未知变更不由此查询证明一致' };
  }
  async diagnose(assetRef: FileRef, reviewRef: FileRef, specRef: FileRef, requestId: string, signal?: AbortSignal): Promise<DiagnosticResult & { runtime_ready: boolean }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(requestId)) throw new WorkflowError('invalid-input', '诊断请求 ID 无效');
    await this.design.gate(assetRef, reviewRef, false);
    const asset = await this.design.store.load(assetRef) as Artifact<'asset'>;
    if (signal?.aborted) throw new WorkflowError('cancelled', '诊断已取消');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let release;
    try { release = await lockfile.lock(this.directory, { realpath: true, retries: 0 }); }
    catch { throw new WorkflowError('precondition', '当前项目已有诊断正在执行'); }
    const requestDirectory = join(this.directory, 'requests');
    const path = join(requestDirectory, `${sha256(requestId)}.json`);
    const receiptPath = join(this.directory, 'accepted', `${key(assetRef, reviewRef)}.json`);
    try {
      const history = await requests(requestDirectory), previous = history.find(r => r.request_id === requestId);
      if (previous) {
        if (!same(previous.asset_ref, assetRef) || !same(previous.review_ref, reviewRef) || !same(previous.spec_ref, specRef)) throw new WorkflowError('precondition', '同一诊断请求不能改变输入');
        if (previous.state !== 'completed' || !previous.summary_ref) throw new WorkflowError('precondition', '旧诊断未确认完成，不自动重放业务动作');
        const result = JSON.parse(await readFile(await workspacePath(this.root, previous.summary_ref.path), 'utf8'));
        await verifyReferences(this.root, previous.summary_ref); await verifyReferences(this.root, result);
        let ready = false;
        try { await verifyRuntimeAdmission(this.root, this.authorityRoot, assetRef, reviewRef); ready = true; }
        catch { /* 历史结果仍可查看，失效的登记不升级成当前运行授权。 */ }
        return { ...result, summary_ref: previous.summary_ref, runtime_ready: ready };
      }
      if (history.some(r => unresolved(r, asset.data.module_ids))) throw new WorkflowError('precondition', '相关模块已有结果不明的诊断，须核对旧执行与数据，不能换请求 ID 重放');
      const request: Request = { request_id: requestId, asset_ref: assetRef, review_ref: reviewRef, spec_ref: specRef,
        module_ids: asset.data.module_ids, state: 'pending', started: false };
      await atomic(path, request);
      // 新诊断不能在失败后悄悄退回旧运行证明；历史业务证据保留不动。
      await atomic(receiptPath, { state: 'invalidated', request_id: requestId, asset_ref: assetRef, review_ref: reviewRef });
      try {
        const result = await runDesignDiagnostics(this.root, assetRef, reviewRef, specRef, signal, async inputRef => {
          request.started = true; request.input_ref = inputRef; await atomic(path, request);
        }, this.authorityRoot);
        await this.design.gate(assetRef, reviewRef, false);
        await verifyReferences(this.root, result.summary_ref); await verifyReferences(this.root, result);
        const uncertain = result.status === 'cancelled' || result.unknown_effects;
        const complete = result.status === 'validated' && !uncertain;
        if (complete) await atomic(receiptPath, { state: 'accepted', request_id: requestId, asset_ref: assetRef,
          review_ref: reviewRef, spec_ref: specRef, summary_ref: result.summary_ref, rules_version: await rulesVersion() });
        await atomic(path, { ...request, state: uncertain ? 'unknown' : 'completed', summary_ref: result.summary_ref });
        return { ...result, runtime_ready: complete };
      } catch (error) {
        await atomic(path, { ...request, state: request.started ? 'unknown' : 'failed',
          error: error instanceof WorkflowError ? error.category : 'runner-error' });
        throw new WorkflowError(error instanceof WorkflowError ? error.category : 'runner-error',
          error instanceof WorkflowError ? error.message : '诊断调用未确认完成；查询旧请求与已保存证据', false,
          request.input_ref ? [request.input_ref] : []);
      }
    } finally { await release(); }
  }
}

/** 不执行浏览器动作；正式执行仍须独立完成当前环境、认证和数据预检。 */
export async function verifyRuntimeAdmission(root: string, authorityRoot: string, assetRef: FileRef, reviewRef: FileRef): Promise<FileRef> {
  const directory = join(authorityRoot, 'runtime');
  const asset = await new ArtifactStore(root).load(assetRef) as Artifact<'asset'>;
  if ((await requests(join(directory, 'requests'))).some(r => unresolved(r, asset.data.module_ids))) throw new WorkflowError('precondition', '相关模块存在未核对诊断，不能使用运行证明');
  let receipt;
  try { receipt = JSON.parse(await readFile(join(directory, 'accepted', `${key(assetRef, reviewRef)}.json`), 'utf8')); }
  catch (error) { if (!missing(error)) throw error; throw new WorkflowError('precondition', '运行就绪证明尚未登记；设计批准不能代替定位与断言诊断'); }
  if (receipt.state !== 'accepted' || !same(receipt.asset_ref, assetRef) || !same(receipt.review_ref, reviewRef) || receipt.rules_version !== await rulesVersion()) {
    throw new WorkflowError('precondition', '运行就绪证明失效或诊断规则已变化');
  }
  const request = (await requests(join(directory, 'requests'))).find(r => r.request_id === receipt.request_id);
  if (!request || request.state !== 'completed' || !request.summary_ref || !same(request.summary_ref, receipt.summary_ref)) throw new WorkflowError('precondition', '运行登记缺少对应的已完成诊断请求');
  await verifyReferences(root, receipt.summary_ref);
  const result = JSON.parse(await readFile(await workspacePath(root, receipt.summary_ref.path), 'utf8'));
  if (result.status !== 'validated' || result.unknown_effects || result.formal_run !== false || !same(result.asset_ref, assetRef) ||
      !same(result.review_ref, reviewRef) || !same(result.spec_ref, receipt.spec_ref)) throw new WorkflowError('precondition', '诊断结果与运行登记不符');
  await verifyReferences(root, result);
  return receipt.summary_ref;
}
