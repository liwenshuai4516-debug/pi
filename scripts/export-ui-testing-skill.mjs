import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'packages/ui-testing');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) {
  throw new Error('用法：node scripts/export-ui-testing-skill.mjs <新建的 ui-testing-workflow 目录>');
}
const temporary = await mkdtemp(join(tmpdir(), 'ui-skill-export-'));
try {
  // 先在隔离目录编译，避免清理应用 dist 或混入旧构建；目标存在时拒绝覆盖。
  const compiled = join(temporary, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p',
    join(source, 'tsconfig.json'), '--outDir', compiled, '--sourceMap', 'false'], { cwd: root, stdio: 'inherit' });
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await cp(join(source, 'portable/ui-testing-workflow'), output, { recursive: true });
  const runtime = join(output, 'assets/runtime');
  await mkdir(runtime, { recursive: true });
  await cp(compiled, join(runtime, 'dist'), { recursive: true });
  for (const name of ['src', 'skills', 'examples']) {
    await cp(join(source, name), join(runtime, name), { recursive: true });
  }
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const typebox = JSON.parse(await readFile(join(root, 'node_modules/typebox/package.json'), 'utf8')).version;
  const nodeTypes = JSON.parse(await readFile(join(root, 'node_modules/@types/node/package.json'), 'utf8')).version;
  const lockTypes = JSON.parse(await readFile(join(root, 'node_modules/@types/proper-lockfile/package.json'), 'utf8')).version;
  // 原包依赖仓库父级 tsconfig；分发包带独立配置和源码，不依赖原客户端目录。
  metadata.files = ['dist', 'src', 'skills', 'examples', 'tsconfig.json'];
  metadata.scripts = { build: 'tsc -p tsconfig.json' };
  metadata.engines = { node: '>=22.19.0' };
  metadata.peerDependencies.typebox = typebox;
  metadata.devDependencies = { '@types/node': nodeTypes, '@types/proper-lockfile': lockTypes };
  await writeFile(join(runtime, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
  config.compilerOptions.declaration = true;
  config.compilerOptions.sourceMap = false;
  config.include = ['src/**/*.ts'];
  await writeFile(join(runtime, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', join(output, 'assets')], {
    cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files = {};
  async function inventory(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await inventory(join(directory, entry.name), relative + '/');
      else if (entry.isFile()) files[relative] = createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex');
      else throw new Error(`分发包不能包含符号链接：${relative}`);
    }
  }
  await inventory(output);
  await writeFile(join(output, 'bundle-manifest.json'), JSON.stringify({
    schema_version: '1.0', skill: 'ui-testing-workflow', runtime_version: metadata.version,
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source_note: '工作区快照；文件摘要为本包实际内容，未复制用户数据或批准。',
    node_version: process.version, generated_at: new Date().toISOString(), files,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ skill_directory: output, runtime_package: join(output, 'assets', `${metadata.name}-${metadata.version}.tgz`) }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
