# Pi Agent 客户端

**Pi Agent SDK + Electron + TypeScript** 的首版客户端。当前有效客户端工程为 `agent-client/`；旧 `client/`、`desktop/` 代码及项目内 `.pi-web/` 数据已移除。当前工程不运行 Pi Web、Next.js 或本地 HTTP 业务服务。

技术约束与架构见[当前技术设计与约束](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/技术设计与约束.md)，协作规则统一见 [AGENTS.md](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/AGENTS.md)。

需要按目录或功能查找代码、修改界面与业务时，请阅读 [操作与功能修改指南](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/操作与功能修改指南.md)。

## 打开应用

从源码启动 Electron 客户端：

```sh
cd /Users/liyingjun/Desktop/SW-QA/13-pi/agent-client
npm run dev
```

该命令先构建，再打开桌面窗口；代码修改后需重新启动。请只在本目录启动客户端；旧网页工程已删除。

macOS Apple Silicon 内部验证应用：

`release/mac-arm64/Pi Agent.app`

双击打开即可；运行应用不依赖外部安装的 Node。此包尚未签名、公证，不是正式分发版本。

1. 点击「选择项目」，选一个本地目录。
2. 客户端自动读取 Pi 已有配置。没有可用模型时，打开左下角「模型配置」添加提供商、API 地址、模型 ID 与 API Key。
3. 在输入框发送任务，查看流式回复和实际工具调用；展开工具卡片查看参数及结果。
4. 运行期间点击输入框右下角的停止按钮。左侧可以新建、搜索、切换并继续会话，条目右侧「…」可重命名、分支续聊和删除；重启应用后可以再次打开已保存的会话。

模型配置表单支持 OpenAI 兼容接口，不会猜测默认供应商。其他 SDK 模型协议与已有 OAuth 认证从 Pi 原配置加载；首版未提供新的 OAuth 登录界面。

Pi Agent 是客户端名称。每次模型请求会携带当前配置的提供商和模型 ID，切换模型与恢复历史后同样更新；模型自述不能用来验证接口服务端的真实模型来源。

附件中的图片会传给 SDK，普通文件以本机路径加入任务，供 Agent 使用工具读取。提示模板来自 Pi 已配置的模板；没有模板时显示空状态。跨会话草稿保存在当前进程，退出提示后不会承诺重启恢复草稿。

默认系统提示词采用测试工程师角色，覆盖需求澄清、风险分析、用例设计、执行验证和缺陷报告，强调真实证据与最小修改。内容位于 `src/main/agent/system-prompt.ts`；Pi 资源加载器提供的自定义系统提示词优先，追加提示词及项目规范继续按原流程加载。更新后完全退出并重启应用，新建或重新打开会话时加载。

支持加载并运行用户目录 `~/.pi/agent/extensions/` 与受信任项目 `.pi/extensions/` 中的 Pi 扩展，包括工具、输入框斜杠命令、输入/上下文/工具钩子和会话生命周期。添加扩展后完全退出并重启应用。安装示例、兼容范围与权限边界见 [Pi 扩展使用指南](docs/Pi扩展使用指南.md)。扩展自身以系统账号权限执行，不受内置工具的工作区文件限制隔离。

扩展轮次事件和任务完成事件带真实会话上下文与停止状态；模型选择及分支取消钩子已接入。扩展组合快捷键可在桌面使用，客户端保留键优先。可选的树导航/压缩监听器允许注册；当前没有对应操作入口时不触发，也不会仅因注册而报错。

## 会话管理

点击会话条目右侧「…」：修改名称并保存；从已保存的当前进度「创建分支并打开」；或二次确认删除。分支保留原会话，不重放历史工具，不复制尚未完成的流式回复；原任务可继续执行。删除会先停止该会话任务，移除其历史和草稿，项目文件及其他分支保留。

名称为 1–120 字符单行文本。空会话不能分支；空会话改名遵循 SDK 的延迟落盘规则，首次发送后才会在重启时保留。

## 模块目录

主进程业务分在 `src/main/agent`、`sessions`、`models`、`workspace`，IPC 在 `main/ipc`；界面按 `src/renderer/features/` 的聊天、输入、会话、模型、工作区分模块。样式在 `renderer/styles/`，测试在 `tests/<模块>/`。新增功能按模块放置，不直接堆进两个入口文件。

详见 [项目目录与模块开发规范](docs/项目目录与模块开发规范.md)。

## 思考强度与工作区权限

- 模型支持推理时，可在模型配置中声明「此模型支持可调思考强度」；输入栏按 Pi SDK 的能力列表选择，实际应用到模型请求并随会话保存。不支持的模型只显示关闭并禁用，不能靠强行开放选项实现模型没有的能力。
- 权限入口提供只读、工作区读写（默认）、完全访问；当前 macOS 受限档由真实路径校验和系统沙箱约束文件工具与命令。命令允许读取系统运行文件，网络不在此入口限制；其他系统受限操作明确拒绝。完全访问沿用当前系统账号权限。
- Enter 发送，Shift+Enter 换行；中文输入法确认不误发，任务运行中 Enter 不重复发送或停止任务。

## 架构

```text
src/renderer/     TypeScript 界面：会话、输入、流式消息和工具结果
src/preload/      TypeScript 受限桥接：仅列出的操作，不暴露通用 IPC 或 Node
src/main/        TypeScript Electron 主进程：直接调用 Pi Agent SDK
src/shared/      TypeScript 通信类型
```

`AgentHost` 直接实例化 `@earendil-works/pi-agent-core` 的 `Agent`，调用其 `subscribe`、`prompt`、`abort` 和 `waitForIdle`；不创建 `AgentSession`。`Agent` 负责模型循环和工具调度。`pi-coding-agent` 仅提供 `ModelRuntime`、内置工具、资源加载、消息转换与 `SessionManager` JSONL 辅助模块。不解析 CLI 输出、不修改 SDK、不另造 Agent 执行循环或会话格式。SDK 和密钥只在主进程使用。

renderer 使用 `file://` 加载本地界面；`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，保留 webSecurity。CSP 禁止 renderer 网络请求、内联脚本、frame 与 object。模型请求由主进程中的 SDK 发起。

## 数据与权限

- 默认沿用 Pi 的 `~/.pi/agent` 配置与 JSONL 会话，支持原有 `PI_CODING_AGENT_DIR`。
- API Key 单独保存在 Pi 的 `auth.json`，权限 `0600`；不会返回给界面，也不会存入会话。配置修改使用文件锁，保留无关提供商条目。
- 设置表单当前接受 JSON 配置；遇到已有 JSONC 或无效配置会报错并保留文件，不静默重写。
- 项目信任沿用 SDK 的项目资源加载规则，遇到需要信任的资源时明确询问。
- 工作区工具权限的具体范围、系统运行文件例外、链接边界和平台支持见 [操作指南](docs/操作与功能修改指南.md#3-工作区权限的实际范围)。项目信任不等同于该文件沙箱。
- 退出时先询问未发送草稿/运行任务，调用 `Agent.abort()` 并等待 `waitForIdle()`，再解除订阅。第三方独立 daemon 或强制退出后的外部进程不作清理保证。

## 开发与验证命令

建议 Node 24 LTS。依赖与锁文件已固定：Pi 的 7 个包均为 `1.2.0`，Electron `44.9.0`，TypeScript `5.9.3`。

```sh
cd /Users/liyingjun/Desktop/SW-QA/13-pi/agent-client
npm ci
npx install-electron
npm run check
npm start
```

Electron 44 使用 `install-electron` 显式准备运行二进制。若 GitHub 下载不可达，可使用可访问的镜像并保留官方校验；本机已准备完毕，不需要重复安装。

```sh
npm test                # 构建 + 真实 SDK 集成测试
npm run test:electron   # 构建 + Electron 界面主流程
npm run package         # 构建 macOS 内部验证 .app；不发布
```

## 本次实际验证

- `evidence/tests.log`：本轮按模块测试，覆盖真实 SDK 执行、会话管理、文件/命令权限、链接越界、思考强度请求和重启恢复。
- 历史 SDK 主流程同样纳入本轮：SDK 流式消息、实际写文件及工具结果回传、上游请求中止、真实 Bash 命令执行与停止后的进程退出、运行期间重复发送拒绝、会话隔离、历史持久化和重启续接；配置验证与密钥单独保存。
- `evidence/electron.log`：真实 Electron 窗口、受限 preload、实际 UI 发送/停止、会话草稿切换、模型配置、权限切换、Enter/IME 和思考强度及 900px 布局检查。
- `evidence/packaged-flow.log`：对打包的 `.app` 重复主流程验证，包括重启恢复历史且不重发旧任务。
- `evidence/electron/` 与 `evidence/packaged/`：开发入口和打包应用的真实窗口截图及结构化结果；检查项以各目录 `result.json` 为准，页面运行错误为 0。

所有自动化验证均使用临时配置目录、临时项目和**受控模型协议服务**。工具执行和会话读写使用真实 SDK；测试响应不是外部模型生成，不能据此声称真实供应商账号或模型质量已通过联调。生产应用不含固定回复或测试模型，需使用你配置的真实模型。

## 尚未交付的能力

其他系统的受限文件/命令沙箱、完整插件/技能/MCP 管理、扩展自定义 UI、Git/文件预览面板、PTY、系统通知、多窗口与签名公证尚未接入或完整验证。Pi 扩展核心运行能力已接入，完整兼容范围见扩展使用指南；MCP 连接与 Skill 独立调用仍待接入。声明式提示模板和受信任的项目上下文继续加载。

这是一版聚焦 Agent 主流程的客户端，不代表历史 Pi Web 的全部功能等价迁移。真实外部模型账号联调、其他操作系统与正式分发验证仍待完成。
