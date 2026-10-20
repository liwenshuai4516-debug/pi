# Pi 扩展使用指南

客户端使用 Pi SDK 的资源加载器和 `ExtensionRunner` 加载、运行扩展，执行核心仍为直接创建的 `pi-agent-core.Agent`。不创建 `AgentSession`，不修改 SDK 源码。

## 安装与加载

支持 Pi 的默认发现规则：

- 用户扩展：`~/.pi/agent/extensions/*.ts` 或 `*.js`。
- 项目扩展：`<项目>/.pi/extensions/*.ts` 或 `*.js`，仅在项目信任允许时加载。
- 多文件扩展：以上目录中的子目录，入口为 `index.ts` 或 `index.js`。
- 额外路径和 Pi 包：沿用 Pi 的 `settings.json` 中 `extensions`、`packages` 配置。未提供桌面安装管理界面。

设置 `PI_CODING_AGENT_DIR` 时，用户扩展目录相应改为该目录下的 `extensions/`。TypeScript 由 SDK 加载，无需单独编译。

添加或修改扩展后，完全退出并重启应用，再新建或打开会话。当前不支持 `/reload` 或 `ctx.reload()` 热重载。每个已加载会话拥有独立的扩展运行器；切换侧栏会话不会关闭后台会话。

## 最小示例

保存为 `~/.pi/agent/extensions/qa.ts`：

```typescript
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'qa_echo',
    label: '测试信息',
    description: '回显用户提供的测试信息，不执行测试或推断测试结果。',
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: 'text', text: args.text }], details: {} };
    },
  });

  pi.registerCommand('qa-name', {
    description: '设置当前测试会话名称',
    async handler(name) {
      pi.setSessionName(name || '测试任务');
    },
  });
}
```

在输入框发送 `/qa-name 登录回归` 验证命令；发送“请调用 qa_echo 回显：登录回归”可让实际配置的模型选择调用工具。模型是否调用工具取决于模型响应，以工具卡片和真实结果为准。

扩展命令优先于同名提示模板；命令本身不发起模型请求，除非命令通过 `pi.sendUserMessage()` 或 `pi.sendMessage(..., { triggerTurn: true })` 启动任务。

## 当前兼容范围

| 能力 | 当前行为 |
|---|---|
| 工具 | `registerTool`、动态刷新和激活工具；自定义工具可覆盖同名内置工具 |
| 工具钩子 | `tool_call` 可修改参数或阻止执行；`tool_result` 可修改结果 |
| 嵌套工具 | `ctx.executeTool()` 复用 Agent SDK 参数验证、工具钩子和取消信号 |
| 命令 | 输入框 `/命令 参数`；命令可使用会话上下文与取消信号 |
| 扩展快捷键 | 当前会话的 Ctrl/Alt/Meta 组合键或功能键转发到主进程执行；客户端保留键优先，弹窗、输入法及长按重复不触发扩展 |
| 输入与提示词 | `input`、`before_agent_start`；支持替换提示词及追加文本、指南、命名区块、上下文文件 |
| 请求上下文 | `context`、`context_with_system`、`before_provider_request` |
| 生命周期 | `session_start`、`session_shutdown`、`agent_start/end`、`agent_settled`、`turn_start/end`、消息与工具执行事件；`message_end` 可替换同角色消息 |
| 轮次边界 | `turn_end` / `agent_before_settle` 通过 SDK 预览并验证自定义条目、消息、上下文编辑和压缩条目，使用 Agent 原生钩子提出续跑决定；无可执行上下文时不强行续跑 |
| 模型与分支 | 真实模型恢复/切换发送 `model_select`；已加载会话创建分支前发送 `session_before_fork` 并遵守取消结果 |
| 会话数据 | `appendEntry`、自定义消息、会话名称、标签，使用 SDK JSONL 保存 |
| 资源 | `resources_discover` 路径交给 SDK 继续加载；提示模板可直接使用 |
| 消息队列 | 命令或当前任务内发送用户/自定义消息；运行中支持 steer/followUp |
| 错误反馈 | 加载错误、事件异常及不支持的事件显示在会话提示中；命令异常显示为任务错误 |

`session_start` 在新建或打开历史时发生，打开历史不会重放模型任务。删除会话或应用正常退出前，先取消并等待当前命令/Agent 结束，再发送一次 `session_shutdown`，最后使运行器失效、释放事件总线订阅。扩展应在此事件中关闭自身的进程、连接、定时器等资源；长任务需响应 `ctx.signal`。

`agent_settled` 在 Agent 及其事件回调全部结束后发出，此时 `ctx.isIdle()` 为真，停止任务时携带 `aborted: true`。仅执行命令、未启动 Agent 的操作不会伪造该事件。`turn_end` 包含真实持久化的消息条目 ID 和 SDK 会话投影。

扩展可以注册 `session_tree`、`session_before_switch`、`session_before_compact`、`session_compact` 等可选监听器，注册本身不会产生“不支持”警告。客户端当前没有单 Agent 的树导航、会话替换或独立压缩操作入口，因此不会伪造这些事件；侧栏切换保留各自独立运行器，分支副本通过新运行器的 `session_start` 恢复状态。

以下能力尚未接入，不代表与 Pi 终端运行模式完全兼容：

- 终端自定义 UI、弹窗、通知、渲染器与编辑器。`ctx.hasUI` 为 `false`，扩展应据此跳过交互；SDK 的无 UI 确认默认拒绝。桌面快捷键已转发，但不代表快捷键调用的终端组件也已实现。
- 独立压缩、树导航、通过扩展创建/切换/分支会话和热重载。这些扩展操作仍明确报不支持；注册对应的可选监听器不视为运行失败。
- 空闲时由扩展定时器或外部事件主动启动任务，以及在 `agent_end` 中安排下一轮任务。
- 全套工具负载编排（如 `prepareLoadout`）、虚拟模型路由及完整供应商事件链。
- Skill 的模型提示注入和独立调用、MCP 连接与管理。扩展资源发现和 MCP 注册仍沿用 SDK 接口；注册 MCP 服务不代表已连接，无连接处理器时会提示。相关能力后续单独接入。

## 信任与权限

Pi 扩展是主进程内执行的代码，具有当前系统账号权限，可访问文件、网络和进程；只安装可信来源的扩展。用户目录扩展沿用 Pi 的用户资源信任规则；拒绝项目信任后，不执行项目扩展和项目包资源。

工作区三档权限继续约束客户端提供的内置文件/命令工具；通过 `ctx.executeTool()` 调用这些工具时同样受约束。它们不隔离扩展自身的文件访问、`pi.exec()`、外部进程或扩展对内置工具的覆盖。Electron renderer 隔离保持开启，与扩展信任及工具权限是不同边界。

## 验证范围

`tests/agent/extensions.test.mjs` 使用临时配置和真实 SDK 验证发现、命令、模型调用工具、提示词与输入钩子、拦截、权限切换后工具保留、错误可见、信任、取消、关闭与恢复，以及轮次投影、续跑、停止后的 settled 状态、模型事件和分支取消。`tests/electron/flow.mjs` 验证真实桌面输入框能执行扩展命令和快捷键，并保护客户端保留键、输入法和长按。受控模型协议服务不证明任意第三方扩展、外部模型账号、Skill 或 MCP 已验证。
