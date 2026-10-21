import { build } from 'esbuild';
import { copyFile, mkdir, rm, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// 迁移模块后清除旧编译路径，避免生成目录留有第二份旧入口。
await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
// 默认提示词作为运行资源随 dist 一起分发，不能依赖源码目录或当前工作区。
await cp('src/main/agent/prompts', 'dist/main/agent/prompts', { recursive: true });
await mkdir('dist/renderer', { recursive: true });
await build({
  entryPoints: ['src/renderer/app.ts'],
  bundle: true,
  outfile: 'dist/renderer/app.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
  sourcemap: true,
});
for (const name of ['index.html', 'styles.css'])
  await copyFile(`src/renderer/${name}`, `dist/renderer/${name}`);

await cp('src/renderer/styles', 'dist/renderer/styles', { recursive: true });
