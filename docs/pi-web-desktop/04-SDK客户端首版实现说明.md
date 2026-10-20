# Pi Agent 客户端首版实现说明

2026-10-20 · 唯一技术基准：**Pi Agent SDK + Electron + TypeScript**；执行核心直接使用 `pi-agent-core` 的 `Agent`。

技术边界与验收要求统一见 [当前技术设计与约束](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/技术设计与约束.md)。本文记录首版实现状态，不替代技术设计。

本说明替代 `01`–`03` 中 Pi Web / Next.js / HTTP/SSE 的架构要求；这些文件保留为历史资料，不能据此继续 Web 加壳。旧 `client/`、`desktop/` 工程及其构建产物、项目内 `.pi-web/` 数据已按用户要求删除。当前仅保留 `agent-client/` 作为应用工程；原型和历史文档仅供设计参考。

## 架构与目录

当前工程：`/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/`。

```text
TypeScript renderer（本地静态界面，file://，无 Node）
    ↕ 受限、类型明确的 Electron preload / IPC
TypeScript Electron main
    → Pi Agent SDK 公共接口
    → 既有模型服务、内置工具、Pi JSONL 会话及配置
```

不运行 Next.js、Pi Web、HTTP 业务服务或 CLI 子进程。SDK 不作源码修改。

- 主进程直接 `new Agent(...)`；不调用 `createAgentSession` 或创建 `AgentSession`。`SessionManager` 仅管理原有 JSONL。
- `agent.subscribe` 驱动流式界面并保存完成的消息，`agent.prompt` 执行任务，`agent.abort` + `agent.waitForIdle` 停止并等待收尾。
- `ModelRuntime` 读取既有 Pi 模型与认证；界面支持添加 OpenAI 兼容提供商。
- 主进程持有 SDK 与凭据；preload 只暴露列出的操作，IPC 校验主 frame、窗口、页面和参数。
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、保留 webSecurity。renderer CSP 禁止网络请求、内联脚本、frame 和 object。
- SDK 原有项目信任规则通过明确的原生对话框处理；不将其解释为文件沙箱。

## 首版范围

先验证选择项目、新建/打开会话、模型配置与切换、任务发送、流式回复、工具调用与结果、停止、会话切换、重命名、确认删除、分支续聊、重启读取历史并继续。附件图片发送到 SDK，普通文件以本机路径引用供 Agent 工具读取。提示模板来自 SDK 资源加载器，不内置伪造模板。

界面遵循用户确认的暖白布局。“只读工具”选择器不保留。工作区权限在本轮接入只读、工作区读写与完全访问；macOS 受限文件/命令由系统沙箱约束，其他系统受限操作明确拒绝。系统运行文件可读，网络不在此入口限制，具体链接边界见技术设计与操作指南。

原 Pi Web 中的完整 MCP 管理、扩展自定义 UI、插件安装、Git/文件面板、PTY、通知、多窗口等能力未在本次首版声明已实现或等价；属于后续接入与验证范围。当前不启动扩展执行生命周期，第三方扩展及 MCP 工具不会自动加载；保留声明式模板和受信任的项目上下文加载。

## 验证记录

证据仅取自 `agent-client/evidence/`，实际结果和命令见工程 README。

- `tests/agent/host.test.mjs`：真实 SDK + 受控协议服务，实际写文件、工具回传、停止、并发拒绝、独立会话和重启续接；配置验证与凭据单独保存。
- `tests/electron/flow.mjs`：真实 Electron 窗口与受限 preload，UI 发送、停止、模型配置、草稿隔离、历史恢复和窄窗口布局。
- 测试使用临时目录，不读取或破坏用户真实会话和配置。
- 受控模型协议测试不代表外部供应商账号、OAuth、模型质量或第三方扩展已验证。
- macOS arm64 内部验证包未签名、公证；其他平台和正式分发不作已完成声明。

## 会话管理增量（2026-10-20）

会话右侧「…」提供重命名、分支续聊和确认删除。直接复用 Pi JSONL 管理器，分支为当前已保存进度的独立副本；源任务不中断，历史不重放。删除先停止并等待工具收尾，保留项目文件和其他分支。空会话按 SDK 规则首次发送后保存，不允许创建无消息分支。

操作与函数/IPC 定位见操作指南；验证结果见 `evidence/session-tests.log` 和 Electron/打包流程结果。消息级分支导航和子 Agent 会话级联管理尚未接入。

## 模块与权限/思考增量（2026-10-20）

工程按 main/agent、sessions、models、workspace、ipc 和 renderer/features 功能模块组织，样式与测试同步拆分，构建前清理旧产物。目录归属以项目目录与模块开发规范为准。

模型表单支持 reasoning 能力声明，思考强度使用 SDK 支持值并真实传入请求、随历史恢复；运行中锁定配置。Enter 与发送按钮共用提交路径，Shift+Enter 换行，IME 确认和重复键不误发。

本轮证据使用 `evidence/tests.log` 与 Electron/打包结果；早期权限“未接入”记录仅代表当时状态。
