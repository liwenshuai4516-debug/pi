import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  authState,
  validateEnvironment,
  type UiEnvironment,
} from './environment.js';
import {
  observePrivateStorage,
  readPrivateStorageEvents,
} from './private-recording-storage-events.js';

const blocked = () =>
  new Error(
    'Private recording capture unavailable; withhold output and do not replay',
  );
const outside = (root: string, path: string) => {
  const rel = relative(root, path);
  return isAbsolute(rel) || rel === '..' || rel.startsWith('../');
};
async function privateDirectory(path: string, workspace: string) {
  const info = await lstat(path);
  if (
    !isAbsolute(path) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (await realpath(path)) !== path ||
    !outside(workspace, path) ||
    !outside(path, workspace)
  )
    throw blocked();
}

/** 受管 fixture 的单 page 捕获入口。只接受 1..8 顺序编号，不从 MCP 接受文件路径。 */
export async function installPrivateRecordingCapture(
  page: Page,
  input: UiEnvironment,
  workspace: string,
  directory: string,
) {
  let failed = false,
    disposed = false,
    busy = false,
    last = 0;
  let observer: Awaited<ReturnType<typeof observePrivateStorage>> | undefined;
  let tracing = false;
  const config = validateEnvironment(input);
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await observer?.dispose();
    if (tracing)
      await page
        .context()
        .tracing.stop()
        .catch(() => {});
  };
  try {
    workspace = await realpath(workspace);
    if (
      config.isolation !== 'context' ||
      config.auth.kind !== 'storage-state-env' ||
      !config.auth.reference?.startsWith('PI_UI_DATA_SPACE_')
    )
      throw blocked();
    await authState(config, workspace);
    await privateDirectory(directory, workspace);
    const output = join(directory, 'output');
    await mkdir(output, { mode: 0o700, recursive: true });
    await privateDirectory(output, workspace);
    const captureRoot = join(output, 'recording');
    // mkdir 无 recursive：一次新 context 不能覆盖旧捕获；重连必须由宿主核对归属。
    await mkdir(captureRoot, { mode: 0o700 });
    observer = await observePrivateStorage(
      page,
      join(captureRoot, 'storage-events.ndjson'),
    );
    await page
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: false });
    tracing = true;
    const current = async () => {
      if (failed || disposed) throw blocked();
      await authState(config, workspace);
      await privateDirectory(directory, workspace);
      await privateDirectory(output, workspace);
      await privateDirectory(captureRoot, workspace);
      if (failed || disposed) throw blocked();
    };
    const capture = async (ordinal: number): Promise<void> => {
      try {
        if (
          busy ||
          !Number.isInteger(ordinal) ||
          ordinal !== last + 1 ||
          ordinal < 1 ||
          ordinal > 8
        )
          throw blocked();
        busy = true;
        await current();
        await observer!.flush();
        // frame/page 历史和跨 origin 未覆盖时在完成标记前拒绝。
        readPrivateStorageEvents(
          join(captureRoot, 'storage-events.ndjson'),
          new URL(config.base_url).origin,
        );
        const target = join(captureRoot, 'capture-' + ordinal);
        await mkdir(target, { mode: 0o700 });
        for (const name of ['storage.json', 'trace.zip'])
          await writeFile(join(target, name), '', { mode: 0o600, flag: 'wx' });
        await page
          .context()
          .storageState({ path: join(target, 'storage.json') });
        await page
          .context()
          .tracing.stopChunk({ path: join(target, 'trace.zip') });
        await current();
        await privateDirectory(target, workspace);
        for (const name of ['storage.json', 'trace.zip']) {
          const file = join(target, name),
            info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink()) throw blocked();
          await chmod(file, 0o600);
        }
        await page.context().tracing.startChunk();
        await current();
        writeFileSync(
          join(target, 'complete.json'),
          JSON.stringify({ version: 1, ordinal }) + '\n',
          { mode: 0o600, flag: 'wx' },
        );
        last = ordinal;
      } catch {
        failed = true;
        throw blocked();
      } finally {
        busy = false;
      }
    };
    Object.defineProperty(page, '__pi_private_recording_capture', {
      value: capture,
    });
    page.once('close', () => {
      void dispose();
    });
    return { capture, dispose };
  } catch {
    await dispose();
    throw blocked();
  }
}
