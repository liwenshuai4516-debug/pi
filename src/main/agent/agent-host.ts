import {
  createWorkspaceTools,
  isWorkspacePermission,
  PERMISSION_ENTRY,
} from '../workspace/permissions.js';
import { listSavedSessions } from '../sessions/catalog.js';
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt.js';
import { ClientExtensions } from './extensions.js';
import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import {
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  convertToLlm,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { Agent, type AgentMessage, type AgentEvent } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type {
  ChatMessage,
  ImageAttachment,
  FileAttachment,
  ModelChoice,
  SessionSummary,
  SessionView,
  ThinkingLevel,
  ToolProgress,
  WorkspacePermission,
} from '../../shared/types.js';

type Entry = {
  agent: Agent;
  manager: SessionManager;
  resources: DefaultResourceLoader;
  extensions?: ClientExtensions;
  permission: WorkspacePermission;
  hasModel: boolean;
  busy: boolean;
  completion?: Promise<void>;
  error: string | null;
  warning: string | null;
  live?: AgentMessage;
  tools: Map<string, ToolProgress>;
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
const choice = (model: {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}): ModelChoice => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
  reasoning: model.reasoning,
});
function outputText(result: unknown): string {
  const value = result as { content?: { type: string; text?: string }[] } | undefined;
  return (
    value?.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n') ?? ''
  );
}
export class AgentHost {
  readonly agentDir: string;
  private entries = new Map<string, Entry>();
  private opening = new Map<string, Promise<SessionView>>();
  private managing = new Set<string>();
  private modelRuntime?: ModelRuntime;
  constructor(
    private onView: (view: SessionView) => void,
    private onList: (list: SessionSummary[]) => void,
    agentDir = getAgentDir(),
  ) {
    this.agentDir = agentDir;
  }
  private async modelsRuntime(): Promise<ModelRuntime> {
    this.modelRuntime ??= await ModelRuntime.create({
      authPath: join(this.agentDir, 'auth.json'),
      modelsPath: join(this.agentDir, 'models.json'),
    });
    return this.modelRuntime;
  }
  async models(refresh = false): Promise<ModelChoice[]> {
    const runtime = await this.modelsRuntime();
    if (refresh) await runtime.refresh({ allowNetwork: false });
    const models = await runtime.getAvailable();
    if (runtime.getError()) throw new Error(runtime.getError());
    return models.map(choice);
  }
  async list(): Promise<SessionSummary[]> {
    const saved = await listSavedSessions(this.agentDir);
    const map = new Map(
      saved.map((item) => [
        item.id,
        {
          id: item.id,
          cwd: item.cwd,
          name: item.name || item.firstMessage.slice(0, 48) || '新会话',
          modified: item.modified.toISOString(),
          running: this.entries.get(item.id)?.busy ?? false,
        },
      ]),
    );
    for (const [id, entry] of this.entries) {
      if (!map.has(id))
        map.set(id, {
          id,
          cwd: entry.manager.getCwd(),
          name: entry.manager.getSessionName() || '新会话',
          modified: new Date().toISOString(),
          running: entry.busy,
        });
      else map.get(id)!.running = entry.busy;
    }
    return [...map.values()].sort((a, b) => b.modified.localeCompare(a.modified));
  }
  async create(cwd: string, trusted: boolean): Promise<SessionView> {
    if (!(await stat(cwd)).isDirectory()) throw new Error('请选择有效的项目目录');
    return this.load(cwd, undefined, trusted);
  }
  async open(id: string, trusted: (cwd: string) => Promise<boolean>): Promise<SessionView> {
    this.assertAvailable(id);
    if (this.entries.has(id)) return this.view(id);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const load = (async () => {
      const info = (await listSavedSessions(this.agentDir)).find((item) => item.id === id);
      if (!info) throw new Error('会话不存在');
      if (!(await stat(info.cwd)).isDirectory()) throw new Error('会话的项目目录已不存在');
      return this.load(info.cwd, SessionManager.open(info.path), await trusted(info.cwd));
    })();
    this.opening.set(id, load);
    try {
      return await load;
    } finally {
      this.opening.delete(id);
    }
  }
  private assertAvailable(id: string): void {
    if (this.managing.has(id)) throw new Error('会话正在处理，请稍后重试');
  }
  private async manage<T>(id: string, action: (manager: SessionManager) => Promise<T>): Promise<T> {
    this.assertAvailable(id);
    this.managing.add(id);
    try {
      // 等待已开始的打开操作，避免磁盘管理器与即将加载的 Agent 使用不同历史。
      await this.opening.get(id);
      let manager = this.entries.get(id)?.manager;
      if (!manager) {
        const saved = (await listSavedSessions(this.agentDir)).find((item) => item.id === id);
        if (!saved) throw new Error('会话不存在');
        manager = SessionManager.open(saved.path);
      }
      return await action(manager);
    } finally {
      this.managing.delete(id);
    }
  }
  async rename(id: string, name: string): Promise<void> {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 120 ||
      /[\r\n\x00-\x1f]/.test(name)
    )
      throw new Error('会话名称须为 1–120 个字符的单行文本');
    await this.manage(id, async (manager) => {
      manager.appendSessionInfo(name.trim());
      if (this.entries.has(id)) this.emit(id);
      await this.publishList();
    });
  }
  async fork(id: string): Promise<string> {
    return this.manage(id, async (manager) => {
      const source = manager.getSessionFile(),
        leaf = manager.getLeafId();
      if (!source || !leaf || !manager.buildSessionContext().messages.length)
        throw new Error('暂无已保存的消息，请先发送任务再创建分支');
      // createBranchedSession 会切换调用者的文件；必须用独立管理器，不能改动源 Agent。
      // 同步捕获叶节点并复制，只包含已完成消息，不携带仍在流式生成的内容。
      const copy = SessionManager.open(source);
      copy.createBranchedSession(leaf);
      copy.appendSessionInfo(`${(manager.getSessionName() || '新会话').slice(0, 115)} · 分支`);
      await this.publishList();
      return copy.getSessionId();
    });
  }
  async delete(id: string): Promise<void> {
    await this.manage(id, async (manager) => {
      const entry = this.entries.get(id);
      if (entry) {
        entry.extensions?.abort();
        await entry.agent.waitForIdle();
        // 等待 send 的持久化、列表刷新和 finally 全部收尾，再删除文件，防止历史被重新写回。
        await entry.completion;
      }
      const path = manager.getSessionFile();
      await entry?.extensions?.close();
      if (path) {
        try {
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (entry) {
        entry.unsubscribe();
        if (entry.timer) clearTimeout(entry.timer);
        this.entries.delete(id);
      }
      await this.publishList();
    });
  }
  private async load(
    cwd: string,
    manager: SessionManager | undefined,
    trusted: boolean,
  ): Promise<SessionView> {
    const settings = SettingsManager.create(cwd, this.agentDir);
    settings.setProjectTrusted(trusted);
    manager ??= SessionManager.create(cwd, join(this.agentDir, 'sessions'));
    const runtime = await this.modelsRuntime();
    const context = manager.buildSessionContext();
    const available = await runtime.getAvailable();
    const preferred = context.model ?? {
      provider: settings.getDefaultProvider() ?? '',
      modelId: settings.getDefaultModel() ?? '',
    };
    const model =
      available.find(
        (item) => item.provider === preferred.provider && item.id === preferred.modelId,
      ) ?? available[0];
    // 资源加载遵循 SDK 项目信任；扩展生命周期由独立适配器绑定至直接创建的 Agent。
    const resources = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager: settings,
    });
    await resources.reload();
    const systemPrompt = [
      resources.getSystemPrompt() ?? DEFAULT_SYSTEM_PROMPT,
      ...resources.getAppendSystemPrompt(),
      `Working directory: ${cwd}`,
      ...resources.getAgentsFiles().agentsFiles.map((file) => `${file.path}\n${file.content}`),
    ].join('\n\n');
    const storedPermission = manager
      .getEntries()
      .reverse()
      .find((item) => item.type === 'custom' && item.customType === PERMISSION_ENTRY);
    const requestedPermission =
      storedPermission?.type === 'custom'
        ? (storedPermission.data as { mode?: unknown })?.mode
        : undefined;
    const permission: WorkspacePermission = isWorkspacePermission(requestedPermission)
      ? requestedPermission
      : 'workspace';
    const tools = await createWorkspaceTools(cwd, permission);
    const levels = model ? getSupportedThinkingLevels(model) : ['off'];
    const requested = manager.getEntries().length
      ? context.thinkingLevel
      : (settings.getDefaultThinkingLevel() ?? 'off');
    // Agent 自身负责模型循环、工具调度和取消；客户端只提供模型流、工具与持久化适配。
    const sessionId = manager.getSessionId();
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt,
        tools,
        messages: context.messages,
        thinkingLevel: (levels.includes(requested as ThinkingLevel)
          ? requested
          : 'off') as ThinkingLevel,
      },
      sessionId,
      convertToLlm,
      streamFn: (selected, transcript, options) => {
        // 使用本次实际选择的模型生成请求上下文，避免切换或恢复历史后沿用旧身份。
        // 仅注入本次请求，不改写历史；配置标识不能证明服务端真实模型的来源。
        const mode = this.entries.get(sessionId)?.permission ?? permission;
        return runtime.streamSimple(
          selected,
          {
            messages: [
              ...transcript.messages,
              {
                role: 'system',
                content: '',
                timestamp: Date.now(),
                sections: {
                  workspace_policy: `Workspace: ${cwd}\nFile permission: ${mode}. ${mode === 'full-access' ? 'Use the current OS account permissions.' : 'Access project files only; system runtime files may be read by shell commands. ' + (mode === 'read-only' ? 'Do not modify files.' : 'Write only inside the workspace.')} Network access is not restricted by this file policy.`,
                  client_model: [
                    '<client_model>',
                    'Pi Agent is the desktop client name. It does not identify the underlying model or its developer.',
                    `Configured provider: ${selected.provider}`,
                    `Configured model ID: ${selected.id}`,
                    'When asked which model is in use, report this configured provider and model ID. These are client configuration, not independent verification of server identity. Do not infer model provenance from the client name or previous assistant self-descriptions.',
                    '</client_model>',
                  ].join('\n'),
                },
              },
            ],
          },
          options,
        );
      },
    });
    const id = manager.getSessionId();
    const entry: Entry = {
      agent,
      manager,
      resources,
      permission,
      hasModel: !!model,
      busy: false,
      error: null,
      warning:
        process.platform === 'darwin'
          ? null
          : '当前系统受限文件和命令沙箱不可用，受限操作将被拒绝。',
      tools: new Map(),
      unsubscribe: () => {},
    };
    this.entries.set(id, entry);
    try {
      const warnings = new Set(entry.warning ? [entry.warning] : []);
      entry.extensions = new ClientExtensions(
        agent, manager, resources, settings, runtime, systemPrompt,
        (message) => {
          warnings.add(message);
          entry.warning = [...warnings].join('\n');
          this.emit(id);
        },
      );
      entry.unsubscribe = agent.subscribe(async (event) => {
        await entry.extensions!.event(event);
        this.handleEvent(id, event);
      });
      // 扩展可在工厂阶段注册提供商；绑定后重新选择，避免错过扩展新增的默认模型。
      const extensionModels = await runtime.getAvailable();
      const selected =
        extensionModels.find(
          (item) => item.provider === preferred.provider && item.id === preferred.modelId,
        ) ??
        extensionModels.find(
          (item) => item.provider === agent.state.model.provider && item.id === agent.state.model.id,
        ) ?? extensionModels[0];
      if (selected) agent.state.model = selected;
      entry.hasModel = !!selected;
      await entry.extensions.start(context.messages.length ? 'resume' : 'new');
      if (
        entry.hasModel &&
        (context.model?.provider !== agent.state.model.provider ||
          context.model?.modelId !== agent.state.model.id)
      )
        manager.appendModelChange(agent.state.model.provider, agent.state.model.id);
    } catch (error) {
      await entry.extensions?.close();
      entry.unsubscribe();
      this.entries.delete(id);
      throw error;
    }
    this.emit(id);
    await this.publishList();
    return this.view(id);
  }
  view(id: string): SessionView {
    const entry = this.get(id);
    const agent = entry.agent;
    const messages: AgentMessage[] = agent.state.messages.filter(
      (message) => message.role !== 'system',
    );
    if (entry.live && entry.live.role !== 'system') {
      const last = messages[messages.length - 1];
      if (
        last &&
        last.role === entry.live.role &&
        'timestamp' in last &&
        'timestamp' in entry.live &&
        last.timestamp === entry.live.timestamp
      )
        messages[messages.length - 1] = entry.live;
      else messages.push(entry.live);
    }
    return {
      id,
      cwd: entry.manager.getCwd(),
      name: entry.manager.getSessionName() || '新会话',
      messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
      tools: [...entry.tools.values()],
      model: entry.hasModel ? choice(agent.state.model) : null,
      thinking: agent.state.thinkingLevel,
      thinkingLevels: entry.hasModel ? getSupportedThinkingLevels(agent.state.model) : ['off'],
      permission: entry.permission,
      running: entry.busy || agent.state.isStreaming,
      error: entry.error,
      warning: entry.warning,
      templates: entry.resources
        .getPrompts()
        .prompts.map(({ name, description }) => ({ name, description })),
    };
  }
  private handleEvent(id: string, event: AgentEvent): void {
    const entry = this.get(id);
    if (event.type === 'message_start' || event.type === 'message_update')
      entry.live = event.message;
    if (event.type === 'message_end') {
      entry.live = undefined;
      // 只保存已完成的消息，重启恢复时不重新执行历史工具调用。
      if (
        event.message.role === 'user' ||
        event.message.role === 'assistant' ||
        event.message.role === 'toolResult' ||
        event.message.role === 'system'
      ) {
        entry.manager.appendMessage(event.message);
      } else if (event.message.role === 'custom')
        entry.manager.appendCustomMessageEntry(
          event.message.customType, event.message.content, event.message.display, event.message.details,
        );
      if (event.message.role === 'assistant' && event.message.errorMessage)
        entry.error = event.message.errorMessage;
    }
    if (event.type === 'tool_execution_start')
      entry.tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        output: '',
        status: 'running',
      });
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = entry.tools.get(event.toolCallId);
      if (tool) {
        tool.output = outputText(
          event.type === 'tool_execution_end' ? event.result : event.partialResult,
        );
        if (event.type === 'tool_execution_end') tool.status = event.isError ? 'error' : 'done';
      }
    }
    if (event.type === 'message_update' || event.type === 'tool_execution_update') {
      entry.timer ??= setTimeout(() => {
        entry.timer = undefined;
        this.emit(id);
      }, 40);
    } else this.emit(id);
  }
  async send(
    id: string,
    text: string,
    images: ImageAttachment[],
    files: FileAttachment[],
  ): Promise<void> {
    this.assertAvailable(id);
    const entry = this.get(id);
    if (entry.busy || entry.agent.state.isStreaming)
      throw new Error('当前任务仍在运行，请先停止或等待完成');
    if (!text.trim() && !images.length && !files.length) throw new Error('请输入任务');
    entry.error = null;
    entry.busy = true;
    entry.extensions!.begin();
    let finish!: () => void;
    entry.completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      if (!entry.manager.getSessionName())
        entry.manager.appendSessionInfo(text.trim().slice(0, 48) || '附件任务');
      this.emit(id);
      const references = files
        .map((file) => `\n附件文件路径：${JSON.stringify(file.path)}`)
        .join('');
      const prepared = await entry.extensions!.prepare(
        text + references,
        images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
      );
      if (prepared) {
        if (!entry.hasModel) throw new Error('请先配置并选择模型');
        await entry.agent.prompt(prepared);
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : '任务执行失败';
      throw error;
    } finally {
      entry.extensions!.finish();
      entry.busy = false;
      entry.live = undefined;
      try {
        this.emit(id);
        await this.publishList();
      } finally {
        finish();
      }
    }
  }
  async stop(id: string): Promise<void> {
    const entry = this.get(id);
    entry.extensions!.abort();
    await entry.agent.waitForIdle();
    await entry.completion;
  }
  async setModel(id: string, provider: string, modelId: string): Promise<SessionView> {
    this.assertAvailable(id);
    const entry = this.get(id);
    if (entry.busy) throw new Error('任务运行时不能切换模型');
    const runtime = await this.modelsRuntime();
    await runtime.refresh({ allowNetwork: false });
    this.assertAvailable(id);
    this.get(id);
    if (entry.busy) throw new Error('任务运行时不能切换模型');
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error('模型不存在，请刷新模型配置');
    entry.agent.state.model = model;
    entry.hasModel = true;
    entry.manager.appendModelChange(provider, modelId);
    if (!getSupportedThinkingLevels(model).includes(entry.agent.state.thinkingLevel)) {
      entry.agent.state.thinkingLevel = 'off';
      entry.manager.appendThinkingLevelChange('off');
    }
    entry.error = null;
    this.emit(id);
    return this.view(id);
  }
  async setPermission(id: string, permission: WorkspacePermission): Promise<SessionView> {
    this.assertAvailable(id);
    if (!isWorkspacePermission(permission)) throw new Error('无效的工作区权限');
    const entry = this.get(id);
    if (entry.busy) throw new Error('任务运行时不能修改工作区权限');
    const tools = await createWorkspaceTools(entry.manager.getCwd(), permission);
    this.assertAvailable(id);
    if (this.get(id) !== entry || entry.busy)
      throw new Error('会话状态已变化，请等待任务结束后重试');
    entry.manager.appendCustomEntry(PERMISSION_ENTRY, { mode: permission });
    entry.extensions!.refreshTools(tools);
    entry.permission = permission;
    this.emit(id);
    return this.view(id);
  }
  setThinking(id: string, level: ThinkingLevel): SessionView {
    this.assertAvailable(id);
    const entry = this.get(id);
    if (entry.busy) throw new Error('任务运行时不能切换思考级别');
    if (
      !(entry.hasModel ? getSupportedThinkingLevels(entry.agent.state.model) : ['off']).includes(
        level,
      )
    )
      throw new Error('当前模型不支持该思考级别');
    entry.agent.state.thinkingLevel = level;
    entry.manager.appendThinkingLevelChange(level);
    this.emit(id);
    return this.view(id);
  }
  get active(): boolean {
    return [...this.entries.values()].some((entry) => entry.busy || entry.agent.state.isStreaming);
  }
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        // abort 只发送取消信号；等待工具和事件回调收尾后再解除订阅。
        entry.extensions?.abort();
        await entry.agent.waitForIdle();
        await entry.completion;
        await entry.extensions?.close();
        entry.unsubscribe();
        if (entry.timer) clearTimeout(entry.timer);
      }),
    );
    this.entries.clear();
  }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('请先打开会话');
    return entry;
  }
  private emit(id: string): void {
    this.onView(this.view(id));
  }
  private async publishList(): Promise<void> {
    this.onList(await this.list());
  }
}
