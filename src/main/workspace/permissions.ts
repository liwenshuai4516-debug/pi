import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import type { WorkspacePermission } from '../../shared/types.js';
import { sandboxEnvironment, sandboxFile, sandboxProfile, shellQuote } from './sandbox.js';

export const PERMISSION_ENTRY = 'pi-agent-client:workspace-permission';
export function isWorkspacePermission(value: unknown): value is WorkspacePermission {
  return value === 'read-only' || value === 'workspace' || value === 'full-access';
}

/** 不改变 SDK 的工具协议或调度；仅通过公开 operations/spawnHook 接入文件权限。 */
export async function createWorkspaceTools(cwd: string, permission: WorkspacePermission) {
  if (!isWorkspacePermission(permission)) throw new Error('无效的工作区权限');
  if (permission === 'full-access') return createCodingTools(cwd);
  const root = await realpath(cwd);
  const profile = sandboxProfile(root, permission);
  const supported = process.platform === 'darwin';
  const inside = (path: string): boolean => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  };
  async function guard(path: string, writing = false): Promise<string> {
    if (!supported)
      throw new Error('当前系统尚未接入受限文件沙箱；请使用 macOS 或明确选择完全访问');
    if (writing && permission === 'read-only') throw new Error('工作区当前为只读，不能修改文件');
    const absolute = resolve(path);
    // 新文件可能没有 realpath：逐级找到已存在的祖先，检查链接解析后的真实位置。
    let ancestor = absolute;
    while (true) {
      try {
        if (!inside(await realpath(ancestor)))
          throw new Error('工作区权限禁止通过符号链接访问项目目录以外的文件');
        if (writing && ancestor === absolute) {
          const target = await stat(absolute);
          if (target.isFile() && target.nlink > 1)
            throw new Error('工作区权限禁止修改有多个硬链接的文件');
        }
        return absolute;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  const read = async (path: string) => {
    const target = await guard(path);
    if (!(await stat(target)).isFile()) throw new Error('只支持读取普通文件');
    return sandboxFile(profile, root, '/bin/cat', ['--', target]);
  };
  const write = async (path: string, content: string) => {
    const target = await guard(path, true);
    try {
      if (!(await stat(target)).isFile()) throw new Error('只支持写入普通文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await sandboxFile(
      profile,
      root,
      '/bin/sh',
      ['-c', 'cat > "$1"', 'pi-file-write', target],
      content,
    );
  };
  return createCodingTools(root, {
    read: {
      operations: {
        readFile: read,
        access: async (path) => {
          await access(await guard(path));
        },
        detectImageMimeType: async (path) => {
          const mime = (
            await sandboxFile(profile, root, '/usr/bin/file', [
              '-b',
              '--mime-type',
              await guard(path),
            ])
          )
            .toString()
            .trim();
          if (mime === 'image/x-ms-bmp') return 'image/bmp';
          return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mime)
            ? mime
            : null;
        },
      },
    },
    write: {
      operations: {
        writeFile: write,
        mkdir: async (path) => {
          await sandboxFile(profile, root, '/bin/mkdir', ['-p', await guard(path, true)]);
        },
      },
    },
    edit: {
      operations: {
        readFile: read,
        writeFile: write,
        access: async (path) => {
          await access(await guard(path, true));
        },
      },
    },
    bash: {
      shellPath: '/bin/bash',
      exposeSessionEnvironment: false,
      spawnHook: (context) => {
        if (!supported) throw new Error('当前系统尚未接入命令沙箱，已拒绝执行');
        return {
          cwd: root,
          env: sandboxEnvironment(root),
          command: `exec /usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/bash --noprofile --norc -c ${shellQuote(context.command)}`,
        };
      },
    },
  });
}
