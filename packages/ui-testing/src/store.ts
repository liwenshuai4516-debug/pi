import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Artifact, ArtifactKind, FileRef } from './contracts.js';
import { assertPortablePath, sha256, validateArtifact, verifyReferences, WorkflowError, workspacePath } from './validation.js';

const prefix = 'qa/ui';
const json = (input: unknown) => JSON.stringify(input, null, 2) + '\n';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export function assetDigest(asset: Artifact<'asset'>): string {
  const { content_sha256: _digest, ...content } = asset.data;
  return sha256(JSON.stringify(canonical(content)));
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
async function exists(path: string) { try { await access(path); return true; } catch (e) { if (missing(e)) return false; throw e; } }

export type Catalog = { schema_version: '1.0'; records: { kind: ArtifactKind; id: string; ref: FileRef }[];
  incomplete: string[]; invalid: { path: string; reason: string }[] };

/** 文件是权威状态，catalog 仅可重建缓存；所有业务元数据由同一对象锁串行登记。 */
export class ArtifactStore {
  constructor(readonly projectRoot: string) {}

  private async directory(path: string): Promise<string> {
    assertPortablePath(path);
    let current = await realpath(this.projectRoot);
    for (const segment of path.split('/')) {
      current = join(current, segment);
      try { await mkdir(current); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkflowError('invalid-input', '存储目录不能使用符号链接或普通文件');
    }
    return current;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const root = await this.directory(prefix);
    const release = await lockfile.lock(root, { realpath: true, retries: { retries: 40, minTimeout: 20, maxTimeout: 100 } });
    try { return await action(); } finally { await release(); }
  }
  private async atomic(path: string, bytes: string | Buffer): Promise<FileRef> {
    const parent = await this.directory(posix.dirname(path));
    const target = join(parent, posix.basename(path)), temp = `${target}.tmp-${randomUUID()}`;
    const file = await open(temp, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // 完成后原子替换单个 manifest；中断留下的临时文件不作完整产物。
    await rename(temp, target);
    return { path, sha256: sha256(bytes) };
  }
  private location(artifact: Artifact): string {
    switch (artifact.kind) {
      case 'asset': return `${prefix}/assets/${artifact.id}/revisions/${(artifact as Artifact<'asset'>).data.revision}/manifest.json`;
      case 'design-review': case 'result-review': {
        const subject = (artifact as Artifact<'design-review'>).data.subject_ref.path;
        if (!subject.startsWith(prefix + '/')) throw new WorkflowError('invalid-input', '评估对象必须是项目内已登记产物');
        return `${posix.dirname(subject)}/reviews/${artifact.id}/manifest.json`;
      }
      case 'results': case 'analysis': case 'report': {
        const runRef = (artifact as Artifact<'results'>).data.run_ref.path;
        if (!runRef.startsWith(`${prefix}/runs/`)) throw new WorkflowError('invalid-input', '运行产物必须引用已登记批次');
        return `${posix.dirname(runRef)}/${artifact.kind}/${artifact.id}/manifest.json`;
      }
      default: {
        const group = { scope: 'scopes', inventory: 'inventories', recording: 'recordings', cases: 'cases', task: 'tasks', run: 'runs' };
        return `${prefix}/${group[artifact.kind]}/${artifact.id}/manifest.json`;
      }
    }
  }
  private async snapshot(path: string): Promise<{ artifact: Artifact; ref: FileRef }> {
    const bytes = await readFile(await workspacePath(this.projectRoot, path));
    const artifact = validateArtifact(JSON.parse(bytes.toString('utf8')));
    if (path !== this.location(artifact)) throw new WorkflowError('precondition', '产物位置与登记身份不匹配');
    return { artifact, ref: { path, sha256: sha256(bytes) } };
  }
  async load(ref: FileRef, verifyDependencies = true): Promise<Artifact> {
    assertPortablePath(ref.path);
    let saved;
    try { saved = await this.snapshot(ref.path); }
    catch (e) { if (missing(e)) throw new WorkflowError('precondition', `产物未完成或不存在：${ref.path}`); throw e; }
    if (saved.ref.sha256 !== ref.sha256) throw new WorkflowError('precondition', `产物摘要不匹配：${ref.path}`);
    if (saved.artifact.kind === 'asset' && assetDigest(saved.artifact as Artifact<'asset'>) !== (saved.artifact as Artifact<'asset'>).data.content_sha256) {
      throw new WorkflowError('precondition', '资产依赖摘要不匹配');
    }
    if (verifyDependencies) await verifyReferences(this.projectRoot, saved.artifact);
    return saved.artifact;
  }
  private async save(artifact: Artifact, mutable = false): Promise<FileRef> {
    validateArtifact(artifact);
    if (artifact.kind === 'design-review' || artifact.kind === 'result-review') {
      const review = artifact as Artifact<'design-review'>;
      const subject = await this.load(review.data.subject_ref);
      const expectedKind = artifact.kind === 'design-review' ? 'asset' : 'report';
      if (subject.kind !== expectedKind || review.data.subject_sha256 !== review.data.subject_ref.sha256) {
        throw new WorkflowError('precondition', '评估对象类型或版本摘要不匹配');
      }
    }
    if (artifact.kind === 'results' || artifact.kind === 'analysis' || artifact.kind === 'report') {
      if ((await this.load((artifact as Artifact<'results'>).data.run_ref, false)).kind !== 'run') {
        throw new WorkflowError('precondition', '运行产物必须引用批次');
      }
    }
    if (artifact.kind === 'asset' && assetDigest(artifact as Artifact<'asset'>) !== (artifact as Artifact<'asset'>).data.content_sha256) {
      throw new WorkflowError('precondition', '资产内容摘要未覆盖当前文件、来源和依赖');
    }
    await verifyReferences(this.projectRoot, artifact);
    const path = this.location(artifact), bytes = json(artifact);
    if (await exists(join(this.projectRoot, path))) {
      const old = await this.snapshot(path);
      if (old.ref.sha256 === sha256(bytes)) return old.ref;
      if (!mutable) throw new WorkflowError('precondition', '不可覆盖既有产物或资产修订，请新建 ID/revision');
    }
    await this.atomic(`${posix.dirname(path)}/.incomplete.json`, json({ id: artifact.id, kind: artifact.kind }));
    return this.atomic(path, bytes);
  }
  async put(artifact: Artifact): Promise<FileRef> {
    if (artifact.kind === 'run') throw new WorkflowError('invalid-input', '批次必须通过 reserveRun 登记');
    return this.locked(async () => {
      const ref = await this.save(artifact);
      await this.catalog();
      return ref;
    });
  }
  async putFile(path: string, bytes: string | Buffer): Promise<FileRef> {
    assertPortablePath(path);
    const parts = path.split('/');
    const groups = ['scopes', 'inventories', 'recordings', 'cases', 'assets', 'runs'];
    if (!path.startsWith(prefix + '/') || parts.some(p => p.startsWith('.')) || parts.length < 5 ||
        !groups.includes(parts[2]) ||
        ['manifest.json', 'catalog.json', 'active-run.json'].includes(posix.basename(path)) ||
        (parts[2] === 'assets' && (parts[4] !== 'revisions' || parts.length < 7))) {
      throw new WorkflowError('invalid-input', '附件只能写入 qa/ui 业务目录，不能覆盖元数据');
    }
    return this.locked(async () => {
      const target = join(this.projectRoot, path);
      if (await exists(target)) {
        const actual = await workspacePath(this.projectRoot, path);
        if (sha256(await readFile(actual)) === sha256(bytes)) return { path, sha256: sha256(bytes) };
        throw new WorkflowError('precondition', '附件不可覆盖，请创建新修订');
      }
      const owner = parts[2] === 'assets' ? parts.slice(0, 6).join('/') : parts.slice(0, 4).join('/');
      await this.atomic(`${owner}/.incomplete.json`, json({ attachment: path }));
      return this.atomic(path, bytes);
    });
  }
  private async catalog(): Promise<Catalog> {
    const index: Catalog = { schema_version: '1.0', records: [], incomplete: [], invalid: [] };
    const walk = async (path: string) => {
      const entries = await readdir(join(this.projectRoot, path), { withFileTypes: true });
      if (entries.some(e => e.name === '.incomplete.json') && !entries.some(e => e.name === 'manifest.json')) index.incomplete.push(path);
      for (const e of entries) {
        const child = `${path}/${e.name}`;
        if (e.isSymbolicLink()) { index.invalid.push({ path: child, reason: '存储目录中存在符号链接' }); continue; }
        if (e.isDirectory() && !e.name.endsWith('.lock')) await walk(child);
        else if (e.name === 'manifest.json') {
          try {
            const saved = await this.snapshot(child);
            index.records.push({ kind: saved.artifact.kind, id: saved.artifact.id, ref: saved.ref });
          } catch (error) { index.invalid.push({ path: child, reason: error instanceof Error ? error.message : String(error) }); }
        }
      }
    };
    await walk(prefix);
    index.records.sort((a, b) => a.ref.path.localeCompare(b.ref.path));
    await this.atomic(`${prefix}/catalog.json`, json(index));
    return index;
  }
  async reindex(): Promise<Catalog> { return this.locked(() => this.catalog()); }

  async updateTask(expected: FileRef, next: Artifact<'task'>): Promise<FileRef> {
    return this.locked(async () => {
      const previous = await this.load(expected, false);
      if (previous.kind !== 'task' || previous.id !== next.id) throw new WorkflowError('invalid-input', '任务 ID 不匹配');
      const old = previous as Artifact<'task'>;
      const allowed: Record<Artifact<'task'>['data']['state'], string[]> = { pending: ['running', 'blocked', 'cancelled'], running: ['running', 'blocked', 'completed', 'cancelled'],
        blocked: ['running', 'blocked', 'cancelled'], completed: [], cancelled: [] };
      if (!allowed[old.data.state].includes(next.data.state) || old.data.completed_stages.some(s => !next.data.completed_stages.includes(s))) {
        throw new WorkflowError('precondition', '任务不能回退完成阶段或改写终态');
      }
      const frozen = (task: Artifact<'task'>) => ({ created_at: task.created_at, intent: task.data.intent,
        scope_ref: task.data.scope_ref, input_sha256: task.data.input_sha256, asset_refs: task.data.asset_refs, run_ids: task.data.run_ids });
      if (JSON.stringify(canonical(frozen(next))) !== JSON.stringify(canonical(frozen(old)))) {
        throw new WorkflowError('precondition', '任务输入或已登记批次不能改写，请新建任务');
      }
      const ref = await this.save(next, true);
      await this.catalog(); return ref;
    });
  }
  async reserveRun(run: Artifact<'run'>): Promise<{ ref: FileRef; created: boolean }> {
    validateArtifact(run);
    if (run.data.state !== 'pending' || run.data.pid !== undefined) throw new WorkflowError('invalid-input', '启动登记必须是无 PID 的 pending 批次');
    return this.locked(async () => {
      const taskPath = `${prefix}/tasks/${run.data.task_id}/manifest.json`;
      const task = (await this.snapshot(taskPath)).artifact as Artifact<'task'>;
      if (task.kind !== 'task') throw new WorkflowError('precondition', '缺少任务');
      const requestPath = `${prefix}/tasks/${task.id}/requests/${run.data.request_id}.json`;
      if (await exists(join(this.projectRoot, requestPath))) {
        const existing = JSON.parse(await readFile(await workspacePath(this.projectRoot, requestPath), 'utf8'));
        const saved = await this.snapshot(existing.path);
        const requestInput = (value: Artifact<'run'>) => {
          const { state: _state, pid: _pid, exit_code: _exit, output_refs: _outputs, ...input } = value.data;
          return JSON.stringify(canonical(input));
        };
        if (saved.artifact.kind !== 'run' || requestInput(saved.artifact as Artifact<'run'>) !== requestInput(run)) {
          throw new WorkflowError('precondition', '同一启动请求的批次或输入不能变化');
        }
        return { ref: saved.ref, created: false };
      }
      const activePath = `${prefix}/tasks/${task.id}/active-run.json`;
      if (await exists(join(this.projectRoot, activePath))) throw new WorkflowError('precondition', '任务已有活跃或状态未核对批次，不能重复启动');
      if (['completed', 'cancelled'].includes(task.data.state)) throw new WorkflowError('precondition', '终态任务不能新增批次');
      if (!task.data.asset_refs.some(ref => ref.path === run.data.asset_ref.path && ref.sha256 === run.data.asset_ref.sha256) ||
          (await this.load(run.data.asset_ref)).kind !== 'asset') throw new WorkflowError('precondition', '批次资产不属于任务冻结输入');
      await verifyReferences(this.projectRoot, run);
      // 先保留启动意图；崩溃后即使没有 PID 也不盲目重放外部业务动作。
      await this.atomic(activePath, json({ run_id: run.id, process_token: run.data.process_token }));
      const ref = await this.save(run);
      await this.atomic(requestPath, json({ path: ref.path }));
      await this.save({ ...task, data: { ...task.data, state: 'running', run_ids: [...task.data.run_ids, run.id] } }, true);
      await this.catalog(); return { ref, created: true };
    });
  }
  async markRunStarted(expected: FileRef, pid: number, processToken: string): Promise<FileRef> {
    return this.locked(async () => {
      const run = await this.load(expected, false) as Artifact<'run'>;
      if (run.kind !== 'run' || run.data.state !== 'pending' || run.data.process_token !== processToken) {
        throw new WorkflowError('precondition', '批次状态或进程令牌不匹配');
      }
      const ref = await this.save({ ...run, data: { ...run.data, state: 'running', pid } }, true);
      await this.catalog(); return ref;
    });
  }
  async finishRun(expected: FileRef, exitCode: number | null, outputRefs: FileRef[], interrupted = false): Promise<FileRef> {
    return this.locked(async () => {
      const run = await this.load(expected, false) as Artifact<'run'>;
      if (run.kind !== 'run' || !['pending', 'running'].includes(run.data.state)) throw new WorkflowError('precondition', '批次已终结');
      const active = `${prefix}/tasks/${run.data.task_id}/active-run.json`;
      const reservation = JSON.parse(await readFile(await workspacePath(this.projectRoot, active), 'utf8'));
      if (reservation.run_id !== run.id || reservation.process_token !== run.data.process_token) {
        throw new WorkflowError('precondition', '启动登记与批次不匹配');
      }
      const ref = await this.save({ ...run, data: { ...run.data, state: interrupted ? 'interrupted' : 'finished',
        exit_code: exitCode, output_refs: outputRefs } }, true);
      if (!interrupted) {
        await unlink(join(this.projectRoot, active));
      }
      await this.catalog(); return ref;
    });
  }
}
