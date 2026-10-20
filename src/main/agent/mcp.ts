import { join } from 'node:path';
import {
  createMcpExtension, createCodemodeExtension, createToolSearchExtension, type InlineExtension,
} from '@earendil-works/pi-coding-agent';

/** SDK 1.2 的配置与凭据适配器尚未从根入口导出，按同一 SDK 安装位置解析。 */
export async function builtinMcpExtensions(agentDir: string): Promise<InlineExtension[]> {
  const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
  const config = await import(new URL('./extensions/mcp/config.js', sdk).href) as typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js');
  const oauth = await import(new URL('./extensions/mcp/oauth.js', sdk).href) as typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js');
  const auth = await import(new URL('./core/auth-storage.js', sdk).href) as typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
  return [
    { name: 'codemode', factory: createCodemodeExtension() },
    { name: 'tool-search', factory: createToolSearchExtension() },
    { name: 'mcp', factory: createMcpExtension({
      loadConfig: (ctx) => config.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }),
      credentials: new oauth.McpOAuthCredentialStore(new auth.FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), agentDir),
      logPath: join(agentDir, 'mcp.log'),
      openUrl: (url) => {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('不支持的 MCP 登录地址');
        // 登录通知同时显示地址，系统浏览器无法启动时仍可手动打开。
        void import('electron').then(({ shell }) => shell.openExternal(url)).catch((error) => {
          console.error('无法打开 MCP 登录浏览器，请使用会话提示中的地址', error);
        });
      },
    }) },
  ];
}
