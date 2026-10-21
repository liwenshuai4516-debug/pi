import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Type, type Static } from 'typebox';
import { Ajv } from 'ajv';
import { ArtifactStore } from './store.js';
import { WorkflowError, type FileRef } from './validation.js';

const probe = Type.Object({ selector: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const environmentSchema = Type.Object({
  schema_version: Type.Literal('1.0'), environment_id: Type.String({ pattern: '^[a-zA-Z0-9._-]+$' }),
  deployment_version: Type.String({ minLength: 1 }), base_url: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }), identity: probe, initial_state: probe,
  auth: Type.Object({ kind: Type.Enum(['none', 'storage-state-env']),
    reference: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' })) }, { additionalProperties: false }),
  isolation: Type.Enum(['context', 'shared']), timeout_ms: Type.Integer({ minimum: 100, maximum: 60000 }),
}, { additionalProperties: false });
export type UiEnvironment = Static<typeof environmentSchema>;
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(environmentSchema);
export function validateEnvironment(input: unknown): UiEnvironment {
  if (!validate(input)) throw new WorkflowError('invalid-input', ajv.errorsText(validate.errors));
  const config = input as UiEnvironment;
  let url: URL;
  try { url = new URL(config.base_url); } catch { throw new WorkflowError('invalid-input', '测试地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WorkflowError('invalid-input', '测试入口必须是无凭据、查询参数或片段的 HTTP(S) 地址');
  }
  if (config.auth.kind === 'storage-state-env' && !config.auth.reference) throw new WorkflowError('invalid-input', '认证状态缺少环境变量引用');
  if (config.auth.kind === 'none' && config.auth.reference) throw new WorkflowError('invalid-input', '匿名环境不能声明认证引用');
  return config;
}

/** 仅在执行进程中解析私有认证文件，不把文件路径及 cookies 写入普通资产。 */
export async function authState(config: UiEnvironment): Promise<string | undefined> {
  if (config.auth.kind === 'none') return undefined;
  const path = process.env[config.auth.reference!];
  if (!path) throw new WorkflowError('precondition', '认证引用未配置');
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('invalid');
  } catch { throw new WorkflowError('precondition', '认证状态文件缺失或无效'); }
  return path;
}

export type DataOwner = { task_id: string; kind: 'run' | 'recording'; id: string };
export type DataRecord = {
  schema_version: '1.0'; data_id: string; owner_task_id: string; owner_kind: 'run' | 'recording'; owner_id: string;
  business_key: string; creation_method: string; fixture_version: string; environment_id: string; role: string;
  object_ids: string[];
  created_at: string; expires_at: string; shared: boolean; cleanup_method: string;
  state: 'preparing' | 'ready' | 'prepare-failed'; cleanup_state: 'pending' | 'cleaned' | 'failed' | 'retained';
  cleanup_reason?: string; evidence_refs: FileRef[];
};
type OwnedData = { record: DataRecord; cleanup?: () => Promise<void> };

/** 唯一业务键先落盘，再准备数据；清理只调用此作用域显式登记的归属操作。 */
export class UiDataScope {
  private owned: OwnedData[] = [];
  private closed = false;
  readonly namespace = `qa-${randomUUID()}`;
  private readonly base: string;
  constructor(readonly store: ArtifactStore, readonly owner: DataOwner, readonly environment: UiEnvironment) {
    if (![owner.task_id, owner.id].every(v => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(v))) {
      throw new WorkflowError('invalid-input', '数据归属 ID 无效');
    }
    this.base = `qa/ui/${owner.kind === 'run' ? 'runs' : 'recordings'}/${owner.id}/data/${this.namespace}`;
  }
  private async record(item: OwnedData, event: string): Promise<FileRef> {
    return this.store.putFile(`${this.base}/${item.record.data_id}/${event}.json`, JSON.stringify(item.record, null, 2) + '\n');
  }
  async prepare<T>(options: { creation_method: string; fixture_version: string; ttl_ms: number;
    cleanup_method: string; retain_reason?: string; create: (businessKey: string) => Promise<T>;
    identify?: (value: T) => string[];
    cleanup?: (businessKey: string) => Promise<void> }): Promise<{ value: T; business_key: string; data_id: string }> {
    if (this.closed) throw new WorkflowError('precondition', '数据作用域已清理，不能继续创建数据');
    if (!options.creation_method || !options.fixture_version || !options.cleanup_method ||
        !Number.isFinite(options.ttl_ms) || options.ttl_ms <= 0 || (!options.cleanup && !options.retain_reason)) {
      throw new WorkflowError('invalid-input', '数据准备须声明版本、有效期及归属清理方法或保留原因');
    }
    const dataId = randomUUID(), key = `${this.namespace}-${dataId}`;
    const entry: OwnedData = { record: { schema_version: '1.0', data_id: dataId, owner_task_id: this.owner.task_id,
      owner_kind: this.owner.kind, owner_id: this.owner.id, business_key: key, creation_method: options.creation_method,
      fixture_version: options.fixture_version, environment_id: this.environment.environment_id, role: this.environment.role,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + options.ttl_ms).toISOString(),
      shared: this.environment.isolation === 'shared', cleanup_method: options.cleanup_method,
      state: 'preparing', cleanup_state: 'pending', object_ids: [], evidence_refs: [] },
      cleanup: options.cleanup ? () => options.cleanup!(key) : undefined };
    if (!options.cleanup) { entry.record.cleanup_state = 'retained'; entry.record.cleanup_reason = options.retain_reason; }
    await this.record(entry, 'preparing');
    this.owned.push(entry);
    try {
      const value = await options.create(key);
      entry.record.object_ids = options.identify ? options.identify(value) : [key];
      if (!Array.isArray(entry.record.object_ids) || entry.record.object_ids.some(id => typeof id !== 'string' || !id)) {
        throw new WorkflowError('invalid-input', '数据对象标识必须是非空字符串');
      }
      entry.record.state = 'ready'; await this.record(entry, 'ready');
      return { value, business_key: key, data_id: dataId };
    } catch (error) {
      entry.record.state = 'prepare-failed'; await this.record(entry, 'prepare-failed');
      throw error;
    }
  }
  async cleanup(): Promise<DataRecord[]> {
    this.closed = true;
    for (const item of [...this.owned].reverse()) {
      if (item.record.cleanup_state !== 'pending' || !item.cleanup) continue;
      // 先保存尝试记录，进程被强制终止时不能把“尝试”误认成清理成功。
      await this.record(item, 'cleanup-attempt');
      try { await item.cleanup(); item.record.cleanup_state = 'cleaned'; }
      catch { item.record.cleanup_state = 'failed'; item.record.cleanup_reason = 'cleanup-operation-failed'; }
      await this.record(item, 'cleanup-result');
    }
    return this.records();
  }
  records(): DataRecord[] { return structuredClone(this.owned.map(item => item.record)); }
}
