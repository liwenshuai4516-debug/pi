import { join } from 'node:path';
import type { DefaultResourceLoader, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import type { McpAction, McpInventory, McpServerView } from '../../shared/types.js';
import { mcpConfigModule } from './mcp.js';

/** 桌面管理只复用原生 MCP 运行器与配置操作，不另建连接或执行模型任务。 */
export class McpManager {
  constructor(private agentDir: string, private resources: DefaultResourceLoader, private runner: ExtensionRunner) {}
  private command() {
    const command = this.runner.getCommand('mcp');
    if (command?.sourceInfo.path !== 'builtin:mcp') throw new Error('Pi 内置 MCP 已关闭或被其他扩展替换，请使用对应扩展管理');
    return command;
  }
  private async entries() {
    const ctx = this.runner.createContext();
    const config = await mcpConfigModule();
    const loaded = config.loadMcpConfig({ agentDir: this.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    const registered = this.resources.getExtensions().runtime.mcpServers.list();
    const namespaces = new Set(loaded.servers.map(item => item.name.replace(/-/g, '_')));
    return { config, loaded, entries: [
      ...loaded.servers,
      ...registered.filter(item => !namespaces.has(item.name.replace(/-/g, '_'))).map(item => ({
        name: item.name, config: item.config, source: item.extensionPath, scope: 'extension' as const, override: undefined,
      })),
    ] };
  }
  async list(): Promise<McpInventory> {
    try { this.command(); } catch (error) {
      return { available: false, servers: [], diagnostics: [(error as Error).message] };
    }
    const { loaded, entries } = await this.entries();
    let status = '';
    const ctx = this.runner.createCommandContext();
    await this.command().handler('', { ...ctx, mode: 'rpc', ui: { ...ctx.ui, notify: message => { status = message; } } });
    // SDK 1.2 尚无结构化状态接口：隔离适配其原生 RPC /mcp 状态行，未知状态不推断成功。
    const lines = status.split('\n');
    const definitions = this.runner.getAllRegisteredTools();
    const servers: McpServerView[] = entries.map(entry => {
      const line = lines.find(value => value.startsWith(`${entry.name}: `))?.slice(entry.name.length + 2) ?? '';
      const state = ['connected', 'connecting', 'disconnected', 'disabled', 'failed', 'closed', 'starting'].find(value => line.startsWith(value))
        ?? (line.startsWith('needs sign-in') ? 'needs-auth' : 'unknown');
      const namespace = `mcp__${entry.name.replace(/-/g, '_')}__`;
      return {
        name: entry.name, scope: entry.override ? 'project' : entry.scope ?? 'global', source: entry.override ?? entry.source,
        transport: 'url' in entry.config ? 'http' : 'stdio', enabled: state === 'disabled' ? false : line ? true : entry.config.enabled !== false,
        exposure: (line.match(/\((codemode|deferred|direct|hidden)\)$/)?.[1] as McpServerView['exposure']) ?? entry.config.exposure ?? 'codemode', state,
        canLogin: 'url' in entry.config && !Object.keys(entry.config.headers ?? {}).some(key => key.toLowerCase() === 'authorization') && !entry.config.auth,
        toolCount: Number(line.match(/, (\d+) tools/)?.[1] ?? 0),
        tools: state === 'connected' ? definitions.filter(item => item.definition.name.startsWith(namespace) && item.definition.exposure !== 'hidden').map(item => ({ name: item.definition.name, description: item.definition.description })) : [],
      };
    });
    return { available: true, servers, diagnostics: loaded.errors.length ? ['MCP 配置无效，请检查 mcp.json 的格式与服务条目。'] : [] };
  }
  private async reload(): Promise<void> {
    // 仅重启内置 MCP 的处理器；不重放第三方扩展或 Agent 的会话生命周期。
    const extension = this.resources.getExtensions().extensions.find(item => item.path === 'builtin:mcp');
    if (!extension) throw new Error('未加载 Pi 内置 MCP');
    const ctx = this.runner.createContext();
    for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown' }, ctx);
    // 原生注册表保留历史工具供渲染；重新连接前将旧声明隐藏，避免移除后仍向模型提供。
    for (const tool of extension.tools.values()) tool.definition = { ...tool.definition, exposure: 'hidden' };
    for (const handler of extension.handlers.get('session_start') ?? []) await handler({ type: 'session_start', reason: 'resume' }, ctx);
  }
  async action(name: string, action: McpAction): Promise<McpInventory> {
    this.command();
    const { config, entries } = await this.entries();
    const entry = entries.find(item => item.name === name);
    if (!entry) throw new Error('MCP 服务不存在');
    if (['login', 'logout', 'reconnect'].includes(action)) {
      const ctx = this.runner.createCommandContext();
      let failure: string | undefined;
      await this.command().handler(`${action} ${name}`, { ...ctx, ui: { ...ctx.ui, notify: (message, type) => {
        ctx.ui.notify(message, type);
        if (type === 'error') failure = message;
      } } });
      if (failure) throw new Error(failure);
    } else if (entry.scope === 'extension') {
      if (action === 'remove') throw new Error('此服务由扩展注册，请在 Packages 中管理对应扩展');
      const registry = this.resources.getExtensions().runtime.mcpServers;
      const registered = registry.get(name)!;
      registry.register({ ...registered, config: { ...registered.config,
        ...(['enable', 'disable'].includes(action) ? { enabled: action === 'enable' } : { exposure: action as McpServerView['exposure'] }),
      } });
    } else {
      const path = entry.override ?? entry.source;
      if (action === 'remove') config.removeMcpServerConfig(path, name);
      else config.updateMcpServerConfig(path, name,
        ['enable', 'disable'].includes(action) ? { enabled: action === 'enable' } : { exposure: action as McpServerView['exposure'] },
        { override: entry.override !== undefined });
      await this.reload();
    }
    return this.list();
  }
  async add(name: string, raw: string): Promise<McpInventory> {
    this.command();
    const { config, entries } = await this.entries();
    if (entries.some(item => item.name.replace(/-/g, '_') === name.replace(/-/g, '_'))) throw new Error('服务名称已存在，请使用其他名称');
    const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
    const validation = await import(new URL('./core/mcp-servers.js', sdk).href) as typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('服务配置不是有效的 JSON，请检查格式'); }
    const validated = validation.validateMcpServerConfig(name, parsed);
    if (typeof validated === 'string') throw new Error(validated);
    config.addMcpServerConfig(join(this.agentDir, 'mcp.json'), name, validated);
    await this.reload();
    return this.list();
  }
}
