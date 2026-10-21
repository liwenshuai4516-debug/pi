import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { schemas, capabilityResultSchema, type CapabilityResult, type Artifact, type ArtifactKind, type ErrorCategory, type FileRef } from './contracts.js';
export * from './contracts.js';

export class WorkflowError extends Error {
  constructor(readonly category: ErrorCategory, message: string, readonly recoverable = false, readonly artifact_refs: FileRef[] = []) { super(message); }
}
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]));
const validateResult = ajv.compile(capabilityResultSchema);
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** 产物中只保存项目相对路径；不能让绝对路径、反斜杠或 .. 绕过交接边界。 */
export function assertPortablePath(path: string): void {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') ||
      path.split('/').some(segment => !segment || segment === '.' || segment === '..') || /^[a-zA-Z]:/.test(path)) {
    throw new WorkflowError('invalid-input', `产物路径必须是规范的项目相对路径：${path}`);
  }
}
export function fileRefs(input: unknown): FileRef[] {
  if (!input || typeof input !== 'object') return [];
  if ('path' in input && 'sha256' in input && typeof input.path === 'string' && typeof input.sha256 === 'string') {
    return [{ path: input.path, sha256: input.sha256 }];
  }
  return Object.values(input).flatMap(fileRefs);
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new WorkflowError('invalid-input', `${label} 重复`);
}
export function validateArtifact(input: unknown): Artifact {
  const candidate = input as Partial<Artifact> | null;
  if (candidate?.schema_version !== '1.0') throw new WorkflowError('incompatible-version', '仅支持 schema_version 1.0');
  const kind = candidate.kind;
  if (!kind || !Object.hasOwn(validators, kind)) throw new WorkflowError('invalid-input', '未知的产物类型');
  const validate = validators[kind];
  if (!validate(input)) throw new WorkflowError('invalid-input', ajv.errorsText(validate.errors, { separator: '; ' }));
  const artifact = input as Artifact;
  if (!Number.isFinite(Date.parse(artifact.created_at))) throw new WorkflowError('invalid-input', 'created_at 必须是有效日期');
  for (const ref of fileRefs(artifact)) assertPortablePath(ref.path);
  if (artifact.kind === 'inventory') {
    const data = (artifact as Artifact<'inventory'>).data;
    unique(data.features.map(f => `${f.module_id}/${f.feature_id}`), 'module/feature');
    for (const feature of data.features) {
      unique(feature.scenarios.map(s => s.scenario_id), 'scenario_id');
      if (feature.discovery !== 'unconfirmed' && !feature.source_refs.length) throw new WorkflowError('invalid-input', '已发现功能须有来源引用');
      if (feature.discovery === 'source' && feature.coverage === 'explored') throw new WorkflowError('invalid-input', '仅源码不能标记已浏览器探索');
    }
  }
  if (artifact.kind === 'recording') {
    const data = (artifact as Artifact<'recording'>).data;
    unique(data.steps.map(s => s.step_id), 'recording step_id');
    if (data.status === 'complete' && (data.gaps.length || !data.script_refs.length || !data.steps.length || Object.values(data.completion).some(v => !v))) {
      throw new WorkflowError('invalid-input', '缺少完成检查、动作或脚本的录制只能登记 partial');
    }
  }
  if (artifact.kind === 'cases') {
    const data = artifact.data as Artifact<'cases'>['data'];
    unique(data.cases.map(c => c.case_id), 'case_id');
    unique(data.sources.map(s => s.source_id), 'source_id');
    unique(data.cases.flatMap(c => c.assertions.map(a => a.assertion_id)), 'assertion_id');
    for (const c of data.cases) {
      unique(c.steps.map(s => s.step_id), 'step_id');
      for (const a of c.assertions) {
        if (!c.steps.some(s => s.step_id === a.step_id && s.assertion_ids.includes(a.assertion_id))) {
          throw new WorkflowError('invalid-input', `断言 ${a.assertion_id} 缺少对应步骤`);
        }
        if (!data.sources.some(s => s.source_id === a.source_id && s.oracle_type === a.oracle_type)) {
          throw new WorkflowError('invalid-input', `断言 ${a.assertion_id} 缺少对应来源`);
        }
      }
      if (c.steps.some(s => s.assertion_ids.some(a => !c.assertions.some(x => x.assertion_id === a && x.step_id === s.step_id)))) {
        throw new WorkflowError('invalid-input', '步骤引用不存在或不匹配的断言');
      }
    }
  }
  if (artifact.kind === 'design-review' || artifact.kind === 'result-review') {
    const data = artifact.data as Artifact<'design-review'>['data'];
    const prefix = artifact.kind === 'design-review' ? 'D' : 'R';
    unique(data.checked_rules, 'checked_rules');
    unique(data.issues.map(i => i.id), 'issue_id');
    if ([...data.checked_rules, ...data.issues.map(i => i.rule)].some(r => !r.startsWith(prefix))) {
      throw new WorkflowError('invalid-input', '评估规则与评估类型不匹配');
    }
    if (data.decision === 'approved' && data.issues.some(i => i.blocking)) {
      throw new WorkflowError('invalid-input', '有阻断问题的评估不能批准');
    }
    if (data.decision === 'approved' && (prefix === 'D' ? 10 : 6) !== new Set(data.checked_rules).size) {
      throw new WorkflowError('invalid-input', '评估批准必须覆盖全部适用规则');
    }
    if (data.decision !== 'approved' && !data.issues.length) {
      throw new WorkflowError('invalid-input', '评估退回或阻塞必须给出具体问题');
    }
  }
  if (artifact.kind === 'run') unique((artifact.data as Artifact<'run'>['data']).plan.map(i => i.instance_id), 'instance_id');
  if (artifact.kind === 'results') {
    const data = (artifact as Artifact<'results'>).data;
    unique(data.instances.map(i => i.instance_id), 'results instance_id');
    if (data.planned_count !== data.instances.length || Object.entries(data.counts).some(([status, count]) =>
      count !== data.instances.filter(i => i.status === status).length)) {
      throw new WorkflowError('invalid-input', '统计数量必须与全部互斥实例终态一致');
    }
    for (const instance of data.instances) unique(instance.attempts.map(a => String(a.attempt)), 'attempt');
  }
  return artifact;
}

export async function workspacePath(root: string, path: string): Promise<string> {
  assertPortablePath(path);
  const actualRoot = await realpath(root), actual = await realpath(resolve(actualRoot, path));
  const rel = relative(actualRoot, actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new WorkflowError('invalid-input', '引用越过项目真实路径边界');
  return actual;
}
export async function verifyReferences(root: string, input: unknown): Promise<void> {
  for (const ref of fileRefs(input)) {
    try {
      const actual = await workspacePath(root, ref.path);
      if (sha256(await readFile(actual)) !== ref.sha256) throw new WorkflowError('precondition', `引用摘要不匹配：${ref.path}`);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('precondition', `引用不存在或不可读取：${ref.path}`);
    }
  }
}
export function artifactSchema(kind: ArtifactKind) {
  if (!Object.hasOwn(schemas, kind)) throw new WorkflowError('invalid-input', '未知的产物类型');
  return schemas[kind];
}
export function validateCapabilityResult(input: unknown): CapabilityResult {
  if (!validateResult(input)) throw new WorkflowError('invalid-input', ajv.errorsText(validateResult.errors));
  const result = input as CapabilityResult;
  if ((result.status === 'completed') !== (result.errors.length === 0)) {
    throw new WorkflowError('invalid-input', '能力状态与错误列表不一致');
  }
  return result;
}
