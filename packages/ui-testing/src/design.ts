import ts from 'typescript';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ArtifactStore } from './store.js';
import { fileRefs, sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';
import type { Artifact, FileRef } from './contracts.js';

export type DesignIssue = Artifact<'design-review'>['data']['issues'][number];
export type DesignCheck = { asset_ref: FileRef; issues: DesignIssue[]; coverage: { planned: string[]; covered: string[]; missing: string[] }; dependencies: { name: string; version: string }[] };
const sameRef = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const literal = (node: ts.Node): boolean => {
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(literal);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(p => ts.isPropertyAssignment(p) && literal(p.initializer));
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return literal(node.expression);
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.BigIntLiteral].includes(node.kind);
};
const children = (node: ts.Node): ts.Node[] => { const all: ts.Node[] = []; const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); }; visit(node); return all; };

/** 案例与脚本映射是业务规则；语法、类型及模块解析复用 TypeScript compiler API。 */
export async function checkDesign(root: string, ref: FileRef): Promise<DesignCheck> {
  root = await realpath(root);
  const store = new ArtifactStore(root), candidate = await store.load(ref);
  if (candidate.kind !== 'asset') throw new WorkflowError('invalid-input', '设计候选必须是资产修订');
  const asset = candidate as Artifact<'asset'>;
  if (!asset.data.inventory_ref || !asset.data.bindings?.length) throw new WorkflowError('precondition', '候选缺少功能清单或 case/脚本/断言映射');
  const inventory = await store.load(asset.data.inventory_ref) as Artifact<'inventory'>;
  const cases = await store.load(asset.data.cases_ref) as Artifact<'cases'>;
  if (inventory.kind !== 'inventory' || cases.kind !== 'cases' || !sameRef(inventory.data.scope_ref, asset.data.scope_ref) || !sameRef(cases.data.scope_ref, asset.data.scope_ref)) {
    throw new WorkflowError('precondition', '候选、用例与清单必须属于相同范围');
  }
  await store.load(asset.data.scope_ref);
  for (const recording of asset.data.recording_refs) {
    const saved = await store.load(recording) as Artifact<'recording'>;
    if (saved.kind !== 'recording' || !sameRef(saved.data.scope_ref, asset.data.scope_ref)) throw new WorkflowError('precondition', '录制来源与范围不匹配');
  }
  const issues: DesignIssue[] = [];
  const issue = (rule: string, reason: string, evidence: FileRef, caseId?: string, assertionId?: string) => {
    issues.push({ id: `static-${issues.length + 1}`, rule, reason, evidence_refs: [evidence], blocking: true,
      fix_condition: reason, ...(caseId ? { case_id: caseId } : {}), ...(assertionId ? { assertion_id: assertionId } : {}) });
  };
  const planned = inventory.data.features.filter(f => asset.data.module_ids.includes(f.module_id)).flatMap(f =>
    f.scenarios.map(s => `${f.module_id}/${f.feature_id}/${s.scenario_id}`));
  const covered = cases.data.cases.map(c => `${c.module_id}/${c.feature_id}/${c.scenario_id}`);
  const missing = planned.filter(s => !covered.includes(s));
  for (const scenario of missing) issue('D1', `选定主链场景没有用例：${scenario}`, asset.data.inventory_ref);
  for (const c of cases.data.cases) {
    if (!planned.includes(`${c.module_id}/${c.feature_id}/${c.scenario_id}`)) issue('D1', '用例不属于所选清单场景', asset.data.cases_ref, c.case_id);
    const matching = asset.data.bindings.filter(b => b.case_id === c.case_id);
    if (matching.length !== 1) { issue('D6', '每个 case 必须恰好映射一个测试', ref, c.case_id); continue; }
    const binding = matching[0];
    if (!asset.data.files.some(f => sameRef(f, binding.script_ref)) ||
        binding.assertion_ids.length !== c.assertions.length || new Set(binding.assertion_ids).size !== binding.assertion_ids.length ||
        c.assertions.some(a => !binding.assertion_ids.includes(a.assertion_id))) issue('D6', '脚本文件或断言映射不完整/重复', ref, c.case_id);
  }
  if (asset.data.bindings.some(b => !cases.data.cases.some(c => c.case_id === b.case_id))) issue('D6', '存在未登记 case 的脚本映射', ref);

  const optionsFile = ts.findConfigFile(root, ts.sys.fileExists);
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  if (optionsFile) {
    const config = ts.readConfigFile(optionsFile, ts.sys.readFile);
    if (config.error) throw new WorkflowError('invalid-input', '项目 TypeScript 配置不可读取');
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(optionsFile));
    if (parsed.errors.length) throw new WorkflowError('invalid-input', '项目 TypeScript 配置无效');
    options = { ...options, ...parsed.options };
  }
  options = { ...options, rootDir: root, noEmit: true, incremental: false, composite: false, skipLibCheck: true,
    allowJs: true, checkJs: true, allowImportingTsExtensions: true, resolveJsonModule: true };
  const scriptRefs = [...new Map(asset.data.bindings.map(b => [b.script_ref.path, b.script_ref])).values()];
  const paths = await Promise.all(scriptRefs.map(f => workspacePath(root, f.path)));
  const program = ts.createProgram(paths, options);
  for (const diagnostic of ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error)) {
    const path = diagnostic.file ? relative(root, diagnostic.file.fileName).replaceAll('\\', '/') : undefined;
    issue('D3', `TypeScript TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      scriptRefs.find(r => r.path === path) ?? ref);
  }
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file) || program.isSourceFileFromExternalLibrary(file)) continue;
    const path = relative(root, file.fileName).replaceAll('\\', '/');
    if (path.startsWith('../') || isAbsolute(path)) { issue('D10', '测试使用了项目外的未登记源码依赖', ref); continue; }
    if (!asset.data.files.some(f => f.path === path)) issue('D10', `本地测试依赖未纳入修订摘要：${path}`, ref);
    for (const node of file.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) continue;
      const mod = ts.resolveModuleName(node.moduleSpecifier.text, file.fileName, options, ts.sys).resolvedModule;
      if (mod?.packageId && !mod.packageId.name.startsWith('@types/') &&
          !asset.data.dependencies.some(dep => dep.name === mod.packageId!.name && dep.version === mod.packageId!.version)) {
        issue('D10', `导入依赖未锁定：${mod.packageId.name}@${mod.packageId.version}`, asset.data.files.find(f => f.path === path) ?? ref);
      }
    }
  }
  const installed: DesignCheck['dependencies'] = [];
  const require = createRequire(join(root, 'package.json'));
  for (const dep of asset.data.dependencies) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(dep.name)) throw new WorkflowError('invalid-input', '依赖包名称无效');
    try {
      let path: string;
      try { path = require.resolve(`${dep.name}/package.json`); }
      catch { path = require.resolve(dep.name); }
      let dir = dirname(path), found: { name: string; version: string } | undefined;
      while (dirname(dir) !== dir) {
        try { const info = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); if (info.name === dep.name) { found = info; break; } }
        catch { /* 入口可能位于多层 dist，继续寻找同一包的公开 package.json。 */ }
        dir = dirname(dir);
      }
      if (!found || found.version !== dep.version) issue('D3', `依赖版本不匹配：${dep.name}@${dep.version}`, ref);
      else installed.push({ name: found.name, version: found.version });
    } catch { issue('D3', `依赖未安装：${dep.name}@${dep.version}`, ref); }
  }
  // 同时检查本地 helper，避免把恒真断言移到共享函数后绕过检查。
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) continue;
    const localPath = relative(root, source.fileName).replaceAll('\\', '/');
    const scriptRef = asset.data.files.find(f => f.path === localPath);
    if (!scriptRef) continue;
    const nodes = children(source), calls = nodes.filter(ts.isCallExpression);
    const testAliases = new Set(['test']), expectAliases = new Set(['expect']);
    for (const node of source.statements.filter(ts.isImportDeclaration)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) {
        if ((el.propertyName?.text ?? el.name.text) === 'test') testAliases.add(el.name.text);
        if ((el.propertyName?.text ?? el.name.text) === 'expect') expectAliases.add(el.name.text);
      }
    }
    const isExpect = (call: ts.CallExpression) => (ts.isIdentifier(call.expression) && expectAliases.has(call.expression.text)) ||
      (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
        expectAliases.has(call.expression.expression.text) && ['soft', 'poll'].includes(call.expression.name.text));
    const containsExpect = (node: ts.Node, visited = new Set<ts.Node>()): boolean => {
      if (visited.has(node)) return false; visited.add(node);
      for (const call of children(node).filter(ts.isCallExpression)) {
        if (isExpect(call)) return true;
        let symbol = program.getTypeChecker().getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = program.getTypeChecker().getAliasedSymbol(symbol);
        for (const declaration of symbol?.declarations ?? []) {
          if (!declaration.getSourceFile().isDeclarationFile && containsExpect(declaration, visited)) return true;
        }
      }
      return false;
    };
    const testCalls = calls.filter(c => ts.isIdentifier(c.expression) && testAliases.has(c.expression.text));
    const stepCalls = calls.filter(c => ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression) &&
      testAliases.has(c.expression.expression.text) && c.expression.name.text === 'step');
    for (const c of calls) {
      if (isExpect(c) && c.arguments[0] && literal(c.arguments[0])) issue('D4', `不能对固定字面量进行业务断言：${c.getText(source)}`, scriptRef);
      if (ts.isPropertyAccessExpression(c.expression)) {
        const method = c.expression.name.text, receiver = c.expression.expression;
        if (ts.isIdentifier(receiver) && testAliases.has(receiver.text) && ['skip', 'fixme', 'only'].includes(method)) issue('D6', `候选不能静默排除或限定计划：test.${method}`, scriptRef);
        if (ts.isCallExpression(receiver) && isExpect(receiver) && ['toBe', 'toEqual', 'toStrictEqual'].includes(method) &&
            receiver.arguments[0]?.getText(source) === c.arguments[0]?.getText(source)) issue('D4', '断言的实际值与预期来自同一表达式', scriptRef);
      }
    }
    for (const binding of asset.data.bindings.filter(b => b.script_ref.path === scriptRef.path)) {
      const matches = testCalls.filter(c => c.arguments[0] && ts.isStringLiteralLike(c.arguments[0]) && c.arguments[0].text === binding.test_title);
      if (matches.length !== 1) { issue('D3', '映射的测试标题缺失或重复', scriptRef, binding.case_id); continue; }
      const bodyNodes = new Set(children(matches[0]));
      for (const assertionId of binding.assertion_ids) {
        const steps = stepCalls.filter(c => bodyNodes.has(c) && c.arguments[0] && ts.isStringLiteralLike(c.arguments[0]) &&
          (c.arguments[0].text === assertionId || c.arguments[0].text.startsWith(assertionId + ' ')));
        if (steps.length !== 1 || !containsExpect(steps[0])) {
          issue('D4', '每条断言必须映射到含真实 expect 的唯一 test.step(assertion_id)', scriptRef, binding.case_id, assertionId);
        }
      }
    }
    const titles = asset.data.bindings.filter(b => b.script_ref.path === scriptRef.path).map(b => b.test_title);
    if (testCalls.some(c => !c.arguments[0] || !ts.isStringLiteralLike(c.arguments[0]) || !titles.includes(c.arguments[0].text))) issue('D6', '脚本包含不在冻结 case 映射中的测试或动态测试标题', scriptRef);
  }
  return { asset_ref: ref, issues, coverage: { planned, covered, missing }, dependencies: installed };
}

/** 评估输入取自真实文件；不把生成者总结或聊天历史作为事实包。 */
export async function designEvidence(root: string, assetRef: FileRef, maxBytes = 1024 * 1024) {
  const store = new ArtifactStore(root), seen = new Set<string>();
  const files: { ref: FileRef; content: string }[] = [];
  let bytes = 0;
  const visit = async (ref: FileRef): Promise<void> => {
    const key = `${ref.path}:${ref.sha256}`; if (seen.has(key)) return; seen.add(key);
    if (/(^|\/)(?:\.pi|\.env(?:\.[^/]*)?|auth\.json|storage[-_]?state\.json)(\/|$)|\.(?:pem|key)$/i.test(ref.path)) {
      throw new WorkflowError('invalid-input', '私有认证文件不能进入评估输入');
    }
    await verifyReferences(root, ref);
    const content = await readFile(await workspacePath(root, ref.path), 'utf8');
    bytes += Buffer.byteLength(content); if (bytes > maxBytes) throw new WorkflowError('insufficient-evidence', '评估输入超过预算，请拆分范围；不截断后声称完成审查');
    files.push({ ref, content });
    if (ref.path.endsWith('/manifest.json')) {
      const artifact = await store.load(ref);
      for (const nested of fileRefs(artifact)) await visit(nested);
    }
  };
  await visit(assetRef);
  return files;
}
