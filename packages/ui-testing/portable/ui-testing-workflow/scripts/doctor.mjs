import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [projectArg, option] = process.argv.slice(2);
if (!projectArg || (option && option !== '--browser') || process.argv.length > 4) {
  console.error('用法：node doctor.mjs <被测项目目录> [--browser]');
  process.exit(2);
}
const checks = [];
async function check(name, operation) {
  try { checks.push({ name, status: 'passed', detail: await operation() }); }
  catch (error) { checks.push({ name, status: 'failed', reason: error.message }); }
}
const project = resolve(projectArg);
const require = createRequire(join(project, 'package.json'));
await check('Node.js', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 19), '需要 Node >=22.19.0');
  return process.version;
});
await check('project', async () => {
  assert.ok((await stat(project)).isDirectory(), '项目目录不存在');
  JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  return project;
});
// 按目标项目的 Node 搜索目录读元数据，兼容仅有 ESM export 和未导出 package.json 的包。
async function metadata(name) {
  for (const modules of require.resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    try {
      const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (value.name === name) return { directory, value };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`找不到 ${name} 的 package.json`);
}
const versions = {
  'pi-ui-testing': '0.1.0', '@earendil-works/pi-coding-agent': '1.2.0',
  '@earendil-works/pi-agent-core': '1.2.0', typebox: '1.3.27',
  '@earendil-works/pi-ai': '1.2.0', '@earendil-works/pi-mcp': '1.2.0',
  '@earendil-works/pi-codemode': '1.2.0', '@earendil-works/pi-telemetry': '1.2.0',
  '@earendil-works/pi-tui': '1.2.0',
  '@playwright/test': '1.62.1', playwright: '1.62.1',
};
for (const [name, version] of Object.entries(versions)) {
  await check(name, async () => {
    const { value } = await metadata(name);
    assert.equal(value.version, version, `需要 ${version}，实际 ${value.version}`);
    return value.version;
  });
}
await check('runtime resources and tool definitions', async () => {
  const { directory } = await metadata('pi-ui-testing');
  for (const name of ['ui-test-workflow', 'ui-discover-record', 'ui-case-design', 'ui-design-review',
    'ui-test-run', 'ui-result-analysis', 'ui-result-review', 'ui-artifact-check']) {
    assert.ok((await readFile(join(directory, 'skills', name, 'SKILL.md'), 'utf8')).includes(`name: ${name}`));
  }
  for (const name of ['ui-design-review', 'ui-result-review']) {
    assert.ok((await readFile(join(directory, 'skills', name, 'references/rules.md'), 'utf8')).length > 0);
  }
  const definitions = [];
  const extension = await import(pathToFileURL(join(directory, 'dist/extension.js')).href);
  extension.default({ registerTool: tool => definitions.push(tool.name), on() {} });
  assert.deepEqual(definitions.sort(), ['ui_asset_maintain', 'ui_case_design', 'ui_design_diagnose',
    'ui_design_review', 'ui_discover_record', 'ui_result_analysis', 'ui_result_review',
    'ui_test_run', 'ui_test_workflow', 'ui_validate_artifact'].sort());
  return '8 个阶段 Skills、2 套评估规则、10 个工具定义可加载；不是宿主接线验证';
});
await check('contract and storage', async () => {
  const { directory } = await metadata('pi-ui-testing');
  const runtime = await import(pathToFileURL(join(directory, 'dist/index.js')).href);
  const scope = JSON.parse(await readFile(join(directory, 'examples/scope.valid.json'), 'utf8'));
  runtime.validateArtifact(scope);
  assert.throws(() => runtime.validateArtifact({ ...scope, schema_version: 'unsupported' }));
  const temporary = await mkdtemp(join(tmpdir(), 'ui-skill-doctor-'));
  try {
    const store = new runtime.ArtifactStore(temporary);
    const ref = await store.put(scope);
    assert.deepEqual(await new runtime.ArtifactStore(temporary).load(ref), scope);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const schema = JSON.parse(execFileSync(process.execPath, [join(directory, 'dist/cli.js'), 'schema', 'run-request'], { cwd: project, encoding: 'utf8' }));
  assert.equal(schema.type, 'object');
  return '有效产物、未知版本拒绝、跨实例存储读取、CLI schema';
});
if (option === '--browser') await check('Chromium', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>UI skill smoke</button>');
    assert.equal(await page.getByRole('button').textContent(), 'UI skill smoke');
    return '真实启动/关闭、本地 DOM 读取；未访问业务站点';
  } finally { await browser.close(); }
});
console.log(JSON.stringify({ status: checks.every(c => c.status === 'passed') ? 'passed' : 'blocked', checks,
  not_checked: ['宿主扩展及 MCP 实际连接', '模型认证和独立评估', '业务环境/身份/数据规则', '业务测试闭环'] }, null, 2));
if (checks.some(c => c.status !== 'passed')) process.exitCode = 1;
