import { spawn } from 'node:child_process';
import type { WorkspacePermission } from '../../shared/types.js';

export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** macOS 文件沙箱：工作区外只开放系统运行文件，命令及其子进程继承限制。 */
export function sandboxProfile(root: string, permission: WorkspacePermission, resourceRoots: string[] = []): string {
  const readRoots = [
    root,
    ...resourceRoots,
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/Library',
    '/opt/homebrew',
    '/private/etc',
    '/dev',
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))',
    // 根目录读取是 dyld 启动所需；不开放其他用户目录的内容读取。
    `(allow file-read* (literal "/") ${readRoots.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})`,
    `(allow file-write* (literal "/dev/null")${permission === 'workspace' ? ` (subpath ${JSON.stringify(root)})` : ''})`,
    '(allow network*)',
  ].join('\n');
}

export function sandboxEnvironment(root: string): NodeJS.ProcessEnv {
  // 不把主进程中的模型密钥、启动脚本或动态库注入变量传给受限命令。
  return {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    TMPDIR: root,
    LANG: 'en_US.UTF-8',
  };
}

/** 文件内容读写也在受限进程执行，避免路径校验与实际 I/O 之间的符号链接替换绕过。 */
export async function sandboxFile(
  profile: string,
  root: string,
  command: string,
  args: string[],
  input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], {
      cwd: root,
      env: sandboxEnvironment(root),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', () => {
      /* 子进程拒绝访问后可能提前关闭输入，统一由退出状态报告。 */
    });
    child.on('close', (code, signal) =>
      code === 0
        ? resolve(Buffer.concat(output))
        : reject(
            new Error(
              `工作区权限阻止或无法完成文件操作：${Buffer.concat(errors).toString().trim() || signal || code}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
}
