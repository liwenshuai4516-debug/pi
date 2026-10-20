import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../../dist/main/workspace/permissions.js';

// 在有中文、空格和引号的真实目录验证权限，不依赖提示词约束模型。
test(
  'workspace permissions: file tools and shell enforce read-only/workspace/full modes',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-permissions-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "项目 'workspace'"),
      outside = join(root, 'outside.txt');
    await mkdir(cwd);
    await writeFile(outside, 'private outside');
    await writeFile(join(cwd, 'inside.txt'), 'inside');
    await symlink(outside, join(cwd, 'escape'));
    await symlink(root, join(cwd, 'escape-directory'));
    await link(outside, join(cwd, 'hardlink'));
    const tools = async (mode) =>
      new Map((await createWorkspaceTools(cwd, mode)).map((tool) => [tool.name, tool]));
    const execute = (tools, name, args) =>
      tools.get(name).execute('test', args, new AbortController().signal);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const workspace = await tools('workspace');
    assert.match(
      JSON.stringify(await execute(workspace, 'read', { path: 'inside.txt' })),
      /inside/,
    );
    await execute(workspace, 'write', { path: 'new/nested.txt', content: 'allowed' });
    assert.equal(await readFile(join(cwd, 'new/nested.txt'), 'utf8'), 'allowed');
    for (const path of [outside, '../outside.txt', 'escape', 'escape-directory/outside.txt']) {
      await assert.rejects(execute(workspace, 'read', { path }), /工作区/);
      await assert.rejects(execute(workspace, 'write', { path, content: 'forbidden' }), /工作区/);
    }
    await assert.rejects(
      execute(workspace, 'write', { path: 'hardlink', content: 'forbidden' }),
      /硬链接/,
    );
    await assert.rejects(
      execute(workspace, 'edit', {
        path: 'escape',
        edits: [{ oldText: 'private', newText: 'oops' }],
      }),
      /工作区/,
    );
    await execute(workspace, 'bash', { command: 'printf shell-ok > shell.txt' });
    assert.equal(await readFile(join(cwd, 'shell.txt'), 'utf8'), 'shell-ok');
    assert.equal(
      (await execute(workspace, 'bash', { command: `printf forbidden > ${quote(outside)}` }))
        .isError,
      true,
    );
    assert.equal(
      (await execute(workspace, 'bash', { command: `cat ${quote(outside)}` })).isError,
      true,
    );
    assert.equal((await execute(workspace, 'bash', { command: 'cat escape' })).isError, true);
    const readonly = await tools('read-only');
    await assert.rejects(
      execute(readonly, 'write', { path: 'inside.txt', content: 'forbidden' }),
      /只读/,
    );
    await assert.rejects(
      execute(readonly, 'edit', {
        path: 'inside.txt',
        edits: [{ oldText: 'inside', newText: 'oops' }],
      }),
      /只读/,
    );
    assert.equal(
      (await execute(readonly, 'bash', { command: 'echo forbidden > inside.txt' })).isError,
      true,
    );
    assert.match(
      JSON.stringify(await execute(readonly, 'bash', { command: 'cat inside.txt' })),
      /inside/,
    );
    assert.equal(await readFile(outside, 'utf8'), 'private outside');
    const png = join(cwd, 'pixel.png');
    await writeFile(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const image = await execute(readonly, 'read', { path: png });
    assert.ok(
      image.content.some((block) => block.type === 'image'),
      'restricted read preserves SDK image support',
    );
    const full = await tools('full-access');
    await execute(full, 'write', { path: outside, content: 'explicit full access' });
    assert.equal(await readFile(outside, 'utf8'), 'explicit full access');
    await assert.rejects(createWorkspaceTools(cwd, 'forged-mode'), /权限/);
  },
);
