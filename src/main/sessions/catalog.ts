import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/** 只枚举历史，不创建 Agent，不执行历史任务。 */
export async function listSavedSessions(agentDir: string) {
  const root = join(agentDir, 'sessions');
  let directories;
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // SDK 的 listAll 只读取当前目录；逐个读取项目子目录，仍由 Pi 解析历史格式。
  const groups = await Promise.all([
    SessionManager.listAll(root),
    ...directories
      .filter((item) => item.isDirectory() || item.isSymbolicLink())
      .map((item) => SessionManager.listAll(join(root, item.name))),
  ]);
  return groups.flat();
}
