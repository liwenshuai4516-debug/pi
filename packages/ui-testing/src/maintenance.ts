import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, open, mkdir, lstat, realpath } from 'node:fs/promises';
import { posix, join } from 'node:path';
import ts from 'typescript';
import { ArtifactStore } from './store.js';
import { checkDesign } from './design.js';
import type { Artifact, FileRef } from './contracts.js';
import { assertPortablePath, fileRefs, sha256, validateArtifact, verifyReferences, workspacePath, WorkflowError } from './validation.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const privatePath = (path: string) => /(^|\/)(?:auth|models|settings|credentials|storage[-_]?state|cookies|\.env)(?:[.-]|$)/i.test(path) || /\.(pem|key)$/i.test(path) || path.includes('/ui-review-authority/');
function privatePayload(path: string, bytes: Buffer) {
  if (!path.endsWith('.json')) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const data = value as Record<string, unknown>;
    if ((Array.isArray(data.cookies) && Array.isArray(data.origins)) || ['api_key', 'oauth'].includes(String(data.type))) return true;
    return Object.entries(data).some(([key, v]) => /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)$/i.test(key) && typeof v === 'string' && !!v || visit(v));
  };
  try { return visit(JSON.parse(bytes.toString())); } catch { return false; }
}
/** 迁移保持原字节及相对路径；不放宽普通 putFile 对元数据的写入门禁。 */
async function transferFile(root: string, path: string, bytes: Buffer) {
  assertPortablePath(path);
  if (privatePath(path) || path.split('/').some(p => p.startsWith('.') || p === 'node_modules')) throw new WorkflowError('precondition', '不迁移私有配置或依赖安装目录');
  let directory = await realpath(root);
  for (const part of path.split('/').slice(0, -1)) {
    directory = join(directory, part);
    try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkflowError('precondition', '迁移目录不可使用符号链接');
  }
  const target = join(directory, posix.basename(path));
  let file;
  try { file = await open(target, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await lstat(target);
    if (!stat.isSymbolicLink() && stat.isFile() && sha256(await readFile(target)) === sha256(bytes)) return { path, sha256: sha256(bytes) };
    throw new WorkflowError('precondition', `迁移目标已存在不同内容，不覆盖：${path}`);
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { path, sha256: sha256(bytes) };
}
/** 依赖闭包来自已登记引用，不猜测未绑定文件。失配/缺失均显式报告。 */
async function closure(root: string, seed: FileRef) {
  const found = new Map<string, FileRef>(), problems: string[] = [];
  const visit = async (ref: FileRef): Promise<void> => {
    const old = found.get(ref.path);
    if (old) { if (old.sha256 !== ref.sha256) problems.push(`同路径存在冲突摘要：${ref.path}`);return; }
    if (found.size >= 5000) throw new WorkflowError('insufficient-evidence', '依赖闭包超出预算，不声称完整');
    found.set(ref.path, ref);
    try {
      await verifyReferences(root, ref);
      if (ref.path.endsWith('.json')) {
        const value = JSON.parse(await readFile(await workspacePath(root, ref.path), 'utf8'));
        for (const child of fileRefs(value)) await visit(child);
      }
    } catch { problems.push(`依赖缺失、变更或不可解析：${ref.path}`); }
  };
  await visit(seed);return { refs: [...found.values()], problems };
}

export async function changeImpact(root: string, paths?: string[], gitRef?: string) {
  if (paths && gitRef) throw new WorkflowError('invalid-input', '变更清单与 Git 基准二选一');
  if (gitRef) {
    if (gitRef.startsWith('-') || !/^[a-zA-Z0-9_./~^@{}-]+$/.test(gitRef)) throw new WorkflowError('invalid-input', 'Git 基准无效');
    const execute = promisify(execFile);
    const diff = await execute('git', ['diff', '--name-only', '-z', gitRef, '--'], { cwd: root, maxBuffer: 1024 * 1024 });
    const untracked = await execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1024 * 1024 });
    paths = [...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean);
  }
  if (!paths) throw new WorkflowError('invalid-input', '提供 changed_paths 或 Git 基准');
  for (const path of paths) assertPortablePath(path);
  const store = new ArtifactStore(root), index = await store.reindex(), assets = [];
  for (const record of index.records.filter(r => r.kind === 'asset')) {
    const dependencies = await closure(root, record.ref);
    const matched = dependencies.refs.filter(ref => paths!.includes(ref.path)).map(ref => ref.path);
    assets.push({ asset_ref: record.ref, dependencies: dependencies.refs, matched, problems: dependencies.problems,
      requires_review: !!matched.length || !!dependencies.problems.length || !!index.invalid.length,
      reason: dependencies.problems.length || index.invalid.length ? '依赖不完整或索引含不可核验对象，保守重审' : matched.length ? '已登记依赖发生变化' : '未命中已登记依赖；不证明未登记代码无影响' });
  }
  return { schema_version: '1.0', changed_paths: paths, assets, invalid: index.invalid,
    precision: 'registered-dependencies-only', next_action: '仅补录/修订受影响候选并走设计评估/诊断；新部署仍运行有效旧用例，不按新行为改预期。' };
}

export async function inspectImport(root: string, scriptPath: string) {
  assertPortablePath(scriptPath);
  if (!/\.[cm]?[jt]sx?$/.test(scriptPath)) throw new WorkflowError('invalid-input', '导入入口只接受测试脚本');
  const bytes = await readFile(await workspacePath(root, scriptPath)), source = ts.createSourceFile(scriptPath, bytes.toString(), ts.ScriptTarget.Latest, true);
  const tests: { title: string; line: number }[] = [], dynamic: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.expression.getText(source) === 'test' || /^test\.(only|skip|fixme)$/.test(node.expression.getText(source)))) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) tests.push({ title: node.arguments[0].text, line });else dynamic.push(line);
    }
    ts.forEachChild(node, visit);
  };visit(source);
  return { script_ref: { path: scriptPath, sha256: sha256(bytes) }, tests, dynamic_titles_at: dynamic,
    readiness: 'unmapped-import', required: ['scope/角色/来源', 'case/步骤/断言预期与原测试映射', 'fixture/helper/config/依赖版本', '数据归属与清理', '独立设计评估与诊断'],
    note: '只发现已有标题，不运行或批准脚本，不把当前行为当验收预期；调用 ui-case-design 创建新候选，动态测试须先明确实例映射。' };
}

export async function exportAsset(root: string, assetRef: FileRef, bundleId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(bundleId)) throw new WorkflowError('invalid-input', '迁移包 ID 无效');
  const store = new ArtifactStore(root), asset = await store.load(assetRef) as Artifact<'asset'>;
  if (asset.kind !== 'asset') throw new WorkflowError('invalid-input', '导出须引用资产');
  const dependencies = await closure(root, assetRef);
  if (dependencies.problems.length) throw new WorkflowError('insufficient-evidence', dependencies.problems.join('；'));
  const design = await checkDesign(root, assetRef);
  if (design.issues.some(i => i.blocking && ['D8', 'D10'].includes(i.rule))) throw new WorkflowError('precondition', '资产含个人路径或依赖未完整绑定，先修订后迁移');
  const base = `qa/ui-transfers/${bundleId}`;
  for (const ref of dependencies.refs) {
    if (privatePath(ref.path)) {
      throw new WorkflowError('precondition', `私有配置/认证状态不得导出：${ref.path}`);
    }
    const bytes = await readFile(await workspacePath(root, ref.path));
    if (privatePayload(ref.path, bytes)) throw new WorkflowError('precondition', `认证状态或凭据内容不得导出：${ref.path}`);
    if (/\.[cm]?[jt]sx?$/.test(ref.path) && /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:\/|file:|[A-Z]:\\)/.test(bytes.toString())) {
      throw new WorkflowError('precondition', `存在不可迁移的绝对模块路径：${ref.path}`);
    }
  }
  // 只复制显式引用闭包，不复制会话、凭据、批准 authority 或整个工作区。
  for (const ref of dependencies.refs) await transferFile(root, `${base}/files/${ref.path}`, await readFile(await workspacePath(root, ref.path)));
  const manifest = { schema_version: '1.0', asset_ref: assetRef, files: dependencies.refs, dependencies: asset.data.dependencies,
    approval: 'not-transferred; re-review and diagnose in destination', created_at: new Date().toISOString() };
  return { bundle_ref: await transferFile(root, `${base}/bundle.json`, Buffer.from(json(manifest))), file_count: dependencies.refs.length };
}

export async function importAsset(root: string, bundleRef: FileRef) {
  const store = new ArtifactStore(root);await verifyReferences(root, bundleRef);
  const manifest = JSON.parse(await readFile(await workspacePath(root, bundleRef.path), 'utf8'));
  if (manifest.schema_version !== '1.0' || !Array.isArray(manifest.files) || manifest.files.length > 5000 || !manifest.asset_ref) throw new WorkflowError('incompatible-version', '迁移包结构或版本不受支持');
  const files = manifest.files as FileRef[], base = posix.dirname(bundleRef.path), problems: string[] = [];
  if (!files.some(ref => ref.path === manifest.asset_ref.path && ref.sha256 === manifest.asset_ref.sha256)) throw new WorkflowError('invalid-input', '迁移包未登记目标资产摘要');
  for (const ref of files) {
    assertPortablePath(ref.path);
    if (privatePath(ref.path)) throw new WorkflowError('precondition', '不能导入私有认证或应用配置');
    try {
      const sourceRef = { path: `${base}/files/${ref.path}`, sha256: ref.sha256 };
      await verifyReferences(root, sourceRef);
      if (privatePayload(ref.path, await readFile(await workspacePath(root, sourceRef.path)))) throw new Error('private credential payload');
      if (posix.basename(ref.path) === 'manifest.json') {
        const value = validateArtifact(JSON.parse(await readFile(await workspacePath(root, sourceRef.path), 'utf8')));
        if (!['scope', 'inventory', 'recording', 'cases', 'asset'].includes(value.kind)) throw new Error('private runtime metadata');
      }
    }
    catch { problems.push(`迁移包缺少或损坏依赖：${ref.path}`); }
  }
  if (problems.length) return { imported: false, problems };
  // putFile 对既有同路径不同内容拒绝覆盖；半途异常不产生批准或假成功。
  for (const ref of files) await transferFile(root, ref.path, await readFile(await workspacePath(root, `${base}/files/${ref.path}`)));
  const asset = await store.load(manifest.asset_ref) as Artifact<'asset'>;
  if (asset.kind !== 'asset') throw new WorkflowError('invalid-input', '迁移包未包含有效资产');
  const checked = await checkDesign(root, manifest.asset_ref);
  return { imported: true, asset_ref: manifest.asset_ref, runtime_ready: false, issues: checked.issues,
    next_action: '核对当前依赖/环境/身份，独立重审并诊断；未迁移私有批准，不重生成全部资产。' };
}

export async function auditEvidence(root: string, retentionDays: number, auditId: string) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(auditId)) throw new WorkflowError('invalid-input', '保留天数或审计 ID 无效');
  const store = new ArtifactStore(root), index = await store.reindex(), evidence = [];
  for (const record of index.records.filter(r => r.kind === 'run')) {
    const run = await store.load(record.ref, false) as Artifact<'run'>;
    const expired = Date.parse(run.created_at) < Date.now() - retentionDays * 86400000;
    // 尚无外部缺陷关闭可信源，默认保护全部已登记 run，宁可保留，不猜测可删除。
    for (const ref of run.data.output_refs) {
      let valid = true;try { await verifyReferences(root, ref); } catch { valid = false; }
      evidence.push({ ref, run_id: run.id, expired, verifiable: valid, protected: true,
        reason: '被正式 run/评估/报告或潜在未结缺陷引用；未确认解除引用，不自动删除' });
    }
  }
  const report = { schema_version: '1.0', audited_at: new Date().toISOString(), retention_days: retentionDays, evidence, invalid: index.invalid, deleted_count: 0 };
  return { audit_ref: await store.putFile(`qa/ui/maintenance/${auditId}/audit.json`, json(report)), ...report };
}
