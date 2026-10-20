import {
  Agent, runToolCall, type AgentEvent, type AgentMessage, type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getCurrentSystemMessage, getSupportedThinkingLevels, type ImageContent, type JsonObject,
} from '@earendil-works/pi-ai';
import {
  ExtensionRunner,
  formatSkillsForPrompt,
  stripFrontmatter,
  ModelRegistry,
  SessionManager,
  convertToLlm,
  estimateTokens,
  initTheme,
  wrapRegisteredTools,
  type BuildSystemPromptOptions,
  type DefaultResourceLoader,
  type ModelRuntime,
  type SessionBoundaryDraft,
  type BoundaryContextPreview,
  type AgentActivityOutcome,
  type ExtensionShortcut,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { expandTemplate } from './prompt-templates.js';

function unsupported(): never {
  throw new Error('当前桌面扩展运行器尚不支持此操作');
}

/** 复用 SDK 扩展运行器；Agent 仍独立负责模型循环、工具执行和取消。 */
export class ClientExtensions {
  readonly runner: ExtensionRunner;
  private baseTools: AgentTool[];
  private tools = new Map<string, AgentTool>();
  private activeTools?: Set<string>;
  private controller?: AbortController;
  private closed = false;
  private prompt: string;
  private nestedCall = 0;
  private pendingMessages: AgentMessage[] = [];
  private ending = false;
  private messageIds = new WeakMap<AgentMessage, string>();
  private shortcutHandlers = new Map<string, ExtensionShortcut>();
  private shortcutSignal = new AbortController();

  constructor(
    private agent: Agent,
    private manager: SessionManager,
    private resources: DefaultResourceLoader,
    private settings: SettingsManager,
    runtime: ModelRuntime,
    private basePrompt: string,
    private report: (message: string) => void,
  ) {
    this.baseTools = agent.state.tools;
    this.prompt = basePrompt;
    const loaded = resources.getExtensions();
    // 无终端 UI 的扩展也可能用 theme 格式化文本；初始化内置主题且不启动文件监听。
    initTheme('light', false);
    this.runner = new ExtensionRunner(
      loaded.extensions, loaded.runtime, manager.getCwd(), manager, new ModelRegistry(runtime),
    );
    const runner = this.runner;
    runner.setUIContext(undefined, 'print');
    runner.onError((error) => report(`扩展 ${error.extensionPath}（${error.event}）：${error.error}`));
    for (const error of loaded.errors) report(`扩展加载失败 ${error.path}：${error.error}`);
    for (const warning of loaded.warnings ?? []) report(`扩展 ${warning.path}：${warning.warning}`);

    runner.bindCore({
      sendMessage: (message, options) => {
        const custom = { ...message, role: 'custom' as const, timestamp: Date.now() };
        if (options?.triggerTurn && (!this.controller || this.ending)) unsupported();
        if (options?.triggerTurn && !agent.state.isStreaming) this.pendingMessages.push(custom);
        else if (agent.state.isStreaming && !this.ending && options?.deliverAs !== 'nextTurn') {
          if (options?.deliverAs === 'steer') agent.steer(custom);
          else agent.followUp(custom);
        } else {
          agent.state.messages = [...agent.state.messages, custom];
          manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        }
      },
      sendUserMessage: (content, options) => {
        // 新任务必须经宿主管理；命令阶段先收集，进入 Agent 后使用 SDK 队列。
        if (!this.controller || this.ending) unsupported();
        const message = { role: 'user' as const, content, timestamp: Date.now() };
        if (!agent.state.isStreaming) this.pendingMessages.push(message);
        else if (options?.deliverAs === 'steer') agent.steer(message);
        else agent.followUp(message);
      },
      appendEntry: (type, data) => { manager.appendCustomEntry(type, data); },
      setSessionName: (name) => {
        if (!name.trim() || name.length > 120 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('会话名称无效');
        manager.appendSessionInfo(name.trim());
      },
      getSessionName: () => manager.getSessionName(),
      setLabel: (id, label) => { manager.appendLabelChange(id, label); },
      getActiveTools: () => agent.state.tools.map((tool) => tool.name),
      getAllTools: () => [...this.tools.values()].map((tool) => {
        const registered = runner.getAllRegisteredTools().find(({ definition }) => definition.name === tool.name);
        return registered ? { ...registered.definition, exposure: registered.definition.exposure ?? 'direct', sourceInfo: registered.sourceInfo }
          : { ...tool, exposure: 'direct', sourceInfo: { source: 'builtin', path: `builtin:${tool.name}`, scope: 'temporary', origin: 'top-level' } };
      }),
      getSettings: () => settings.getSettings(),
      setActiveTools: (names) => { this.activeTools = new Set(names); this.refreshTools(); },
      refreshTools: () => this.refreshTools(),
      getCommands: () => runner.getRegisteredCommands().map((command) => ({
        name: command.invocationName, description: command.description, source: 'extension', sourceInfo: command.sourceInfo,
      })),
      setModel: async (model) => {
        const selected = runtime.getModel(model.provider, model.id);
        if (!selected || !runtime.hasConfiguredAuth(selected.provider)) return false;
        const previousModel = agent.state.model;
        agent.state.model = selected;
        manager.appendModelChange(selected.provider, selected.id);
        if (!getSupportedThinkingLevels(selected).includes(agent.state.thinkingLevel)) {
          agent.state.thinkingLevel = 'off';
          manager.appendThinkingLevelChange('off');
        }
        await runner.emit({ type: 'model_select', model: selected, previousModel, source: 'set' });
        return true;
      },
      getThinkingLevel: () => agent.state.thinkingLevel,
      setThinkingLevel: (level) => {
        if (!getSupportedThinkingLevels(agent.state.model).includes(level)) throw new Error('当前模型不支持该思考级别');
        agent.state.thinkingLevel = level;
        manager.appendThinkingLevelChange(level);
      },
    }, {
      getModel: () => runtime.getModel(agent.state.model.provider, agent.state.model.id),
      getScopedModels: () => [],
      isIdle: () => !this.controller && !agent.state.isStreaming,
      isProjectTrusted: () => settings.isProjectTrusted(),
      getSignal: () => agent.signal ?? this.controller?.signal ?? this.shortcutSignal.signal,
      abort: () => this.abort(),
      hasPendingMessages: () => agent.hasQueuedMessages(),
      shutdown: () => this.abort(),
      getContextUsage: () => undefined,
      compact: unsupported,
      getSystemPrompt: () => this.prompt,
      getSystemPromptOptions: () => this.promptOptions(),
      getCallableTools: () => [...this.tools.values()],
      executeTool: (parentId, name, args, options) => {
        const message = [...agent.state.messages].reverse().find((item) => item.role === 'assistant');
        if (!message || message.role !== 'assistant') throw new Error('嵌套工具调用缺少助手消息');
        return runToolCall({ id: `${parentId}/${++this.nestedCall}`, name, arguments: args as JsonObject, type: 'toolCall' }, {
          tools: [...this.tools.values()], assistantMessage: message,
          context: { messages: agent.state.messages, tools: agent.state.tools },
          signal: options.signal ?? agent.signal ?? this.controller?.signal,
          onUpdate: options.onUpdate,
          beforeToolCall: ({ toolCall, args }) => runner.emitToolCall({ type: 'tool_call', toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId: parentId, input: args as Record<string, unknown> }),
          afterToolCall: ({ toolCall, args, result, isError }) => runner.emitToolResult({ type: 'tool_result', toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId: parentId, input: args as Record<string, unknown>, ...result, isError }),
        });
      },
    });
    runner.bindCommandContext({
      waitForIdle: () => agent.waitForIdle(),
      newSession: unsupported, fork: unsupported, navigateTree: unsupported,
      switchSession: unsupported, reload: unsupported,
    });
    this.refreshTools();
    agent.beforeToolCall = ({ toolCall, args }) => runner.emitToolCall({ type: 'tool_call', toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown> });
    agent.afterToolCall = ({ toolCall, args, result, isError }) => runner.emitToolResult({ type: 'tool_result', toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>, ...result, isError });
    agent.transformContext = async (messages) => {
      // 提示词变更只作用于本轮请求；保留 SDK 的工具声明，避免污染持久化历史。
      const system = getCurrentSystemMessage(messages);
      const transformed = system ? [{ ...system, content: this.prompt, sections: undefined }, ...messages.filter((message) => message.role !== 'system')] : messages;
      return runner.emitContext(transformed);
    };
    agent.onPayload = (payload) => runner.emitBeforeProviderRequest(payload);
    // 只在 Agent 原生调度边界提出续跑决定，不自行创建模型执行循环。
    agent.finishTurn = async (turn) => {
      const outcome: AgentActivityOutcome = turn.message.stopReason === 'aborted' ? 'aborted'
        : turn.message.stopReason === 'error' ? 'error' : 'completed';
      const messageEntryId = this.messageIds.get(turn.message);
      let continueRun = false;
      if (runner.hasHandlers('turn_end') && messageEntryId) {
        const result = await runner.emitBoundary({
          type: 'turn_end', turnIndex: Math.max(0, this.turnIndex - 1),
          message: turn.message, toolResults: turn.toolResults, messageEntryId,
          toolResultEntryIds: turn.toolResults.flatMap((message) => this.messageIds.get(message) ?? []),
          outcome,
        }, (drafts) => this.previewBoundary(drafts));
        if (result.valid) this.commitBoundary(result.entries);
        continueRun = result.continue && this.previewBoundary([]).canContinue;
        if (result.continue && !continueRun) this.report('扩展 turn_end 请求续跑，但没有可执行的模型上下文');
      }
      if (!continueRun && outcome === 'completed' && !turn.toolResults.length && !agent.hasQueuedMessages() && runner.hasHandlers('agent_before_settle')) {
        const result = await runner.emitBoundary({ type: 'agent_before_settle', outcome }, (drafts) => this.previewBoundary(drafts));
        if (result.valid) this.commitBoundary(result.entries);
        continueRun = result.continue && this.previewBoundary([]).canContinue;
        if (result.continue && !continueRun) this.report('扩展 agent_before_settle 请求续跑，但没有可执行的模型上下文');
      }
      return continueRun ? { action: 'continue' } : undefined;
    };
    agent.prepareNextTurnWithContext = () => ({
      context: { messages: [...agent.state.messages], tools: [...agent.state.tools] },
      model: agent.state.model, thinkingLevel: agent.state.thinkingLevel,
    });
    this.shortcutHandlers = new Map([...runner.getShortcuts({})].filter(([key]) => {
      const parts = key.toLowerCase().split('+');
      return (parts.some((part) => ['ctrl', 'alt', 'meta'].includes(part)) || /^f\d+$/.test(key)) &&
        !parts.some((part) => ['enter', 'escape'].includes(part)) &&
        !(parts.some((part) => ['ctrl', 'meta'].includes(part)) && ['n', 'k', ','].includes(parts[parts.length - 1]));
    }));
    for (const ext of loaded.extensions) {
      const unsupportedEvents = [...ext.handlers.keys()].filter((name) => ![
        'session_start', 'session_shutdown', 'input', 'before_agent_start', 'context', 'context_with_system',
        'agent_start', 'agent_end', 'agent_settled', 'agent_before_settle', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
        'tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
        'before_provider_request', 'resources_discover', 'mcp_servers_change',
        'model_select', 'thinking_level_select', 'session_before_fork',
        // 可选监听器在对应操作发生时才运行；注册本身不要求客户端具备该操作入口。
        'session_tree', 'session_before_tree', 'session_before_switch',
        'session_before_compact', 'session_compact', 'session_compact_failed',
      ].includes(name));
      if (unsupportedEvents.length) report(`扩展 ${ext.path} 的事件尚不支持：${unsupportedEvents.join('、')}`);
    }
  }

  recordMessage(message: AgentMessage, id: string): void { this.messageIds.set(message, id); }

  private applyDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): void {
    for (const draft of drafts) {
      switch (draft.type) {
        case 'custom': manager.appendCustomEntry(draft.customType, draft.data); break;
        case 'custom_message': manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details); break;
        case 'context_edit': manager.appendContextEdit(draft.targetId, draft.replacement); break;
        case 'compaction':
          manager.appendCompaction(draft.summary, draft.firstKeptEntryId,
            manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0),
            draft.details, true, draft.usage);
          break;
        default: throw new Error('无效的扩展边界条目');
      }
    }
  }

  private previewBoundary(drafts: SessionBoundaryDraft[]): BoundaryContextPreview {
    const header = this.manager.getHeader();
    if (!header) throw new Error('会话头不存在');
    const preview = SessionManager.inMemory(this.manager.getCwd(), undefined, [header, ...this.manager.getBranch()]);
    this.applyDrafts(preview, drafts);
    const projection = preview.buildSessionProjection();
    const llmMessages = convertToLlm(projection.messages);
    const pendingMessages = [...this.agent.peekQueuedMessages(), ...this.pendingMessages];
    return {
      contextEntries: projection.entries, contextMessages: projection.messages, llmMessages, pendingMessages,
      canContinue: pendingMessages.length > 0 ||
        (llmMessages.some((message) => message.role !== 'system') && llmMessages.at(-1)?.role !== 'assistant'),
    };
  }

  private commitBoundary(drafts: SessionBoundaryDraft[]): void {
    if (!drafts.length) return;
    this.applyDrafts(this.manager, drafts);
    const system = getCurrentSystemMessage(this.agent.state.messages);
    const projection = this.manager.buildSessionProjection();
    this.agent.state.messages = system && projection.messages[0]?.role !== 'system'
      ? [system, ...projection.messages] : projection.messages;
  }

  get shortcuts(): { key: string; description: string }[] {
    return [...this.shortcutHandlers].map(([key, shortcut]) => ({ key, description: shortcut.description ?? key }));
  }

  async shortcut(key: string): Promise<void> {
    if (this.closed) throw new Error('会话已关闭');
    const shortcut = this.shortcutHandlers.get(key);
    if (!shortcut) throw new Error('扩展快捷键不存在或已被客户端保留');
    if (this.shortcutSignal.signal.aborted) this.shortcutSignal = new AbortController();
    await shortcut.handler(this.runner.createContext());
  }

  async beforeFork(entryId: string): Promise<void> {
    const result = await this.runner.emit({ type: 'session_before_fork', entryId, position: 'at' });
    if (result?.cancel) throw new Error('扩展已取消创建分支');
  }

  private promptOptions(): BuildSystemPromptOptions {
    return { cwd: this.manager.getCwd(), customPrompt: this.basePrompt, skills: this.resources.getSkills().skills, selectedTools: this.agent.state.tools.map((tool) => tool.name) };
  }

  refreshTools(baseTools = this.baseTools): void {
    this.baseTools = baseTools;
    const registered = this.runner.getAllRegisteredTools();
    this.tools = new Map(baseTools.map((tool) => [tool.name, tool]));
    for (const tool of wrapRegisteredTools(registered, this.runner)) this.tools.set(tool.name, tool);
    const inactive = new Set(registered.filter(({ definition }) => definition.defaultActive === false || (definition.exposure && !['direct', 'model-only'].includes(definition.exposure))).map(({ definition }) => definition.name));
    this.agent.state.tools = [...this.tools.values()].filter((tool) => this.activeTools ? this.activeTools.has(tool.name) : !inactive.has(tool.name));
  }

  async start(reason: 'new' | 'resume'): Promise<void> {
    const paths = await this.runner.emitResourcesDiscover(this.manager.getCwd(), 'startup');
    const metadata = (path: string) => this.resources.getExtensions().extensions.find((ext) => ext.path === path)?.sourceInfo ?? { source: 'extension', scope: 'temporary' as const, origin: 'top-level' as const };
    this.resources.extendResources({
      skillPaths: paths.skillPaths.map((item) => ({ path: item.path, metadata: metadata(item.extensionPath) })),
      promptPaths: paths.promptPaths.map((item) => ({ path: item.path, metadata: metadata(item.extensionPath) })),
      themePaths: paths.themePaths.map((item) => ({ path: item.path, metadata: metadata(item.extensionPath) })),
    });
    await this.runner.emit({ type: 'session_start', reason });
    this.runner.reportUnhandledMcpServers();
    this.refreshTools();
  }

  begin(): void {
    this.controller = new AbortController();
    this.turnIndex = 0;
    this.ending = false;
  }
  async finish(ran = false): Promise<void> {
    const last = this.agent.state.messages.at(-1);
    const aborted = !!this.controller?.signal.aborted ||
      (last?.role === 'assistant' && last.stopReason === 'aborted');
    if (this.controller?.signal.aborted) this.agent.clearAllQueues();
    this.controller = undefined;
    this.pendingMessages = [];
    if (ran) await this.runner.emit({ type: 'agent_settled', aborted });
  }
  abort(): void { this.controller?.abort(); this.shortcutSignal.abort(); this.agent.abort(); }

  async prepare(text: string, images: ImageContent[]): Promise<AgentMessage[] | undefined> {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const command = match && this.runner.getCommand(match[1]);
    if (command && match) {
      await command.handler(match[2] ?? '', this.runner.createCommandContext());
      if (!this.pendingMessages.length) return undefined;
    } else {
      const input = await this.runner.emitInput(text, images, 'interactive');
      if (input.action === 'handled') return undefined;
      if (input.action === 'transform') { text = input.text; images = input.images ?? images; }
      const skillCommand = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (skillCommand) {
        if (!this.settings.getEnableSkillCommands()) throw new Error('当前 Pi 配置已关闭 Skill 命令');
        const skill = this.resources.getSkills().skills.find((item) => item.name === skillCommand[1]);
        if (!skill) throw new Error(`未找到 Skill：${skillCommand[1]}`);
        const content = stripFrontmatter(await readFile(skill.filePath, 'utf8')).trim();
        text = `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${content}
</skill>

${skillCommand[2] ?? ''}`;
      } else text = expandTemplate(this.resources.getPrompts().prompts, text);
      this.pendingMessages.push({ role: 'user', content: [{ type: 'text', text }, ...images], timestamp: Date.now() });
    }
    const messages = this.pendingMessages.splice(0);
    const last = messages[messages.length - 1];
    const userContent = last.role === 'user' ? last.content : text;
    const trigger = last.role === 'custom'
      ? { messageType: 'custom' as const, message: last }
      : {
          messageType: 'user' as const,
          prompt: typeof userContent === 'string'
            ? userContent
            : userContent.filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
          images: Array.isArray(userContent) ? userContent.filter((item) => item.type === 'image') : [],
        };
    const originalOptions = this.promptOptions();
    const result = await this.runner.emitBeforeAgentStart(trigger, originalOptions);
    const options = result.systemPromptOptions;
    if (JSON.stringify(options.selectedTools) !== JSON.stringify(originalOptions.selectedTools)) {
      this.activeTools = new Set(options.selectedTools);
      this.refreshTools();
    }
    this.prompt = options.forceSystemPrompt ?? [
      options.customPrompt ?? this.basePrompt, options.appendSystemPrompt,
      ...options.promptGuidelines,
      ...Object.entries(options.sections).map(([name, content]) => `<${name}>\n${content}\n</${name}>`),
      ...options.contextFiles.map((file) => `${file.path}\n${file.content}`),
      formatSkillsForPrompt(options.skills),
    ].filter(Boolean).join('\n\n');
    for (const message of result.messages) {
      this.agent.state.messages = [...this.agent.state.messages, { ...message, role: 'custom', timestamp: Date.now() }];
      this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    }
    return this.controller?.signal.aborted ? undefined : [...messages, ...this.pendingMessages.splice(0)];
  }

  async event(event: AgentEvent): Promise<void> {
    if (event.type === 'agent_end') this.ending = true;
    if (event.type === 'turn_end') return; // SDK 的可续跑边界需额外的会话投影支持，不伪装成通知事件。
    if (event.type === 'message_end') {
      const replacement = await this.runner.emitMessageEnd(event);
      if (replacement) {
        this.agent.state.messages = this.agent.state.messages.map((message) => message === event.message ? replacement : message);
        event.message = replacement;
      }
    } else if (event.type === 'turn_start') {
      await this.runner.emit({ type: 'turn_start', turnIndex: this.turnIndex++, timestamp: Date.now() });
    } else await this.runner.emit(event);
  }
  private turnIndex = 0;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.runner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    finally { this.runner.invalidate(); }
  }
}
