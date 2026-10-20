# Pi 扩展使用指南

客户端使用 Pi SDK 的资源加载器和 `ExtensionRunner` 加载、运行扩展，执行核心仍为直接创建的 `pi-agent-core.Agent`。不创建 `AgentSession`，不修改 SDK 源码。

## 安装与加载

支持 Pi 的默认发现规则：

- 用户扩展：`~/.pi/agent/extensions/*.ts` 或 `*.js`。
- 项目扩展：`<项目>/.pi/extensions/*.ts` 或 `*.js`，仅在项目信任允许时加载。
- 多文件扩展：以上目录中的子目录，入口为 `index.ts` 或 `index.js`。
- 额外路径和 Pi 包：沿用 Pi 的 `settings.json` 中 `extensions`、`packages` 配置；可在左栏「扩展能力」安装。

设置 `PI_CODING_AGENT_DIR` 时，用户扩展目录相应改为该目录下的 `extensions/`。TypeScript 由 SDK 加载，无需单独编译。

通过菜单安装后，点击「新建对话并加载」即可在新会话使用。已有会话保留加载时的资源快照；直接修改文件后建议完全退出并重启应用。当前不支持 `/reload` 或 `ctx.reload()` 热重载。每个已加载会话拥有独立的扩展运行器；切换侧栏会话不会关闭后台会话。

## 桌面安装与 Skill 调用

1. 左侧打开「扩展能力」，类型选「Pi 资源包」，可直接粘贴 `pi install npm:pi-goal-x`，或填写 `npm:pi-web-access`、Pi 支持的 Git 来源或本地资源包目录；本地包可用「选择目录」。资源包应符合 Pi 的 `package.json.pi` 声明或 `extensions/`、`skills/` 等目录规则。
2. 独立本地 Skill 选择「本地 Skill」，选包含 `SKILL.md` 的目录。正文、frontmatter 与诊断交给 SDK 验证，配置引用原目录，不复制文件。
3. 点击安装，等待成功或错误提示；安装中不能再次提交，Agent 执行期间拒绝安装。
4. 点击「新建对话并加载」，再打开菜单查看「当前会话已加载」。资源加载错误仍显示在对话提示中；已安装不等于所有第三方能力都已可用。
5. Skill 的描述进入模型上下文，模型可通过 read 工具读取正文及附带文件；发送 `/skill:名称 任务` 可显式展开 Skill，遵守 Pi 的 `enableSkillCommands` 配置。聊天中显示 Skill 名称和任务，完整展开内容仅进入实际模型上下文与历史。

安装命令按 `pi install <来源>` 提取一个来源，通过 SDK 包管理器安装到用户级配置，不执行粘贴的终端命令。命令中的本地路径含空格时使用单引号或双引号，例如 `pi install "/完整路径/我的资源包"`。一次安装一个包，不接受额外命令或 `--local` 等命令选项；直接选择本地目录时无需加引号。

扩展管理按当前锁定 Pi SDK 1.2.0 的 `docs/packages.md`、`docs/skills.md`、`docs/mcp.md` 区分：

| 分类 | 含义与管理 |
|---|---|
| Packages · 资源包 | npm/Git/本地分发容器，可包含扩展、技能、模板和主题；支持安装、更新、移除。扩展代码列表与开关在此分类下，数量不计作资源包数量。 |
| Skills · 技能 | `SKILL.md` 定义任务方法；显示来源、路径、描述与 `/skill:名称`，支持独立导入、启停。 |
| MCP Servers · MCP 服务器 | 外部工具连接；展示当前对话实际状态、来源及工具，支持添加、启停、登录/退出、重连、工具使用方式及移除文件配置。 |

资源包和技能设置写入 Pi `settings.json`，对新建对话生效；已经运行的对话保留创建时加载的资源快照。

全局资源配置使用 Pi settings.json 的 `packages` 和 `skills`，不写入项目配置。本地引用请保留源目录；npm/Git 依赖系统相应命令与网络，缺失时明确报错。更新和移除复用 Pi 包管理器；移除本地资源包只取消配置引用，保留本地源文件与独立导入的 Skill。当前已加载会话保留资源快照。

## 输入框 `/` 候选

输入 `/` 可查看当前会话的 Skill、扩展命令、MCP 命令与提示模板；继续输入按名称或描述筛选。同名项遵循实际执行顺序，扩展命令优先。`enableSkillCommands=false` 时不列出 Skill 命令，未加载或已在新会话禁用的资源不会出现在候选中。

描述展示使用 `src/shared/descriptions-zh.ts` 的本地词典，覆盖当前网页访问、子代理、Postman 技能及原生 MCP 说明；多行说明按空白归一化匹配，命令名、模型名、文件路径及参数标识不翻译。中文说明与英文原文均可搜索，第三方同名命令以实际描述原文匹配，避免误套译文。未收录的新描述保留原文，不猜测翻译；更新资源后可按新原文补充词典。只处理展示和检索，资源原始正文、提示词与调用参数保持不变，不发起翻译模型请求。模板选择面板、技能列表与 MCP 工具说明共享相同词典。

↑↓ 选择，Tab 或 Enter 补全，点击候选也可填入；Esc 关闭，焦点始终保留在输入框。补全不发起模型请求，不自动执行；完整命令按 Enter 仍可直接发送。选中后继续输入任务或参数，随后发送。普通文本、光标前不是 `/` 开头、输入法组词及运行期间不弹出菜单。

参数候选调用扩展原生 `getArgumentCompletions(prefix)`，兼容异步返回；例如 `/mcp ` 提示子命令，`/mcp reconnect ` 提示实际服务。扩展没有提供参数补全时正常输入，不列出虚构选项。异步结果在输入、光标或会话改变后失效，扩展返回内容按文本转义展示。服务出现在候选中不代表已连接或授权。

## MCP 与 Postman

「扩展能力 → MCP 服务器」支持刷新当前会话状态，新增时输入服务名称与服务商提供的单个服务 JSON，例如 `{"url":"https://example.com/mcp"}` 或 `{"command":"npx","args":["-y","包名"]}`；写入用户级 `mcp.json`。配置校验由 Pi 完成，不回显已保存的 URL、请求头、环境变量或凭据。

来源标明用户配置、受信任项目配置或扩展注册；文件服务的启停和工具使用方式写入对应配置，并仅重新加载当前对话的原生 MCP 连接，其他已打开对话不会自动重载。扩展注册服务的更改仅限当前对话；要持久控制其来源，在 Packages 管理对应扩展后新建对话。该服务不能在 MCP 页单独删除。

工具使用方式沿用 Pi 的 `codemode`（默认按需调用）、`deferred`（搜索后调用）、`direct`（直接提供）和 `hidden`（不可调用）。服务提供的工具数量和当前可调用工具分别展示；关闭、隐藏或移除后不再向模型提供相应工具。用户主动关闭/替换原生 MCP 时，界面明确显示不可用，不冒充连接成功。登录按钮打开浏览器，授权由用户完成；等待期间可取消操作。连接失败/需要登录与已连接分别显示。

客户端显式加载 Pi 原生 MCP、codemode、tool-search 扩展，接手 `registerMcpServer()` 注册的服务，支持 HTTP/stdio、工具发现、动态注册与原生 exposure 规则。无需再安装另一个 MCP 桥接插件。全局配置为 `<agentDir>/mcp.json`；项目信任后才加载 `<项目>/.pi/mcp.json`。

安装并启用 `npm:@postman/postman-plugin` 后，新建对话并在输入框发送：

- `/mcp`：查询连接状态和工具数量。
- `/mcp login postman`：首次使用打开系统浏览器授权；本机回调成功后自动重连。停止按钮可取消浏览器回调等待。当前不支持手动粘贴异机重定向地址。
- `/mcp reconnect postman`：重新连接。
- `/mcp logout postman`：退出授权。

`needs sign-in` 表示服务已识别但需要账号授权，与此前“已注册但没有连接器”的警告不同；`connected` 和工具数量表明工具已加载，真实调用结果仍以任务工具输出为准。默认 codemode 曝光通过 codemode 工具调用，不一定逐一显示为模型顶层工具。浏览器未自动打开时，可手动打开会话通知中的登录地址。

OAuth 凭据保存在 `<agentDir>/mcp-auth.json`，连接日志为 `<agentDir>/mcp.log`，不把凭据发送给界面。客户端不会替用户完成 Postman 登录或授权。用户禁用 `builtin:mcp` 或安装替换内置 MCP 的扩展时，沿用 SDK 替换规则，应确认替代连接器可用。

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

- 终端自定义 UI、弹窗、渲染器与编辑器。运行器提供有限 RPC UI（`ctx.mode=rpc`、`ctx.hasUI=true`）：通知展示在会话提示中，支持带取消信号的浏览器 OAuth 回调等待；不提供通用文本输入，确认仍默认拒绝。桌面快捷键已转发，但不代表快捷键调用的终端组件也已实现。
- 独立压缩、树导航、通过扩展创建/切换/分支会话和热重载。这些扩展操作仍明确报不支持；注册对应的可选监听器不视为运行失败。
- 空闲时由扩展定时器或外部事件主动启动任务，以及在 `agent_end` 中安排下一轮任务。
- 全套工具负载编排（如 `prepareLoadout`）、虚拟模型路由及完整供应商事件链。

## 信任与权限

Pi 扩展是主进程内执行的代码，具有当前系统账号权限，可访问文件、网络和进程；只安装可信来源的扩展。用户目录扩展沿用 Pi 的用户资源信任规则；拒绝项目信任后，不执行项目扩展和项目包资源。

工作区三档权限继续约束客户端提供的内置文件/命令工具；通过 `ctx.executeTool()` 调用这些工具时同样受约束。它们不隔离扩展自身的文件访问、`pi.exec()`、外部进程或扩展对内置工具的覆盖。已加载 Skill 的真实目录作为额外只读资源根开放给内置工具及受限命令，不开放配置目录；符号链接仍解析检查，写入仍只允许工作区（或明确的完全访问模式）。Electron renderer 隔离保持开启，与扩展信任及工具权限是不同边界。

## 验证范围

`tests/agent/extensions.test.mjs` 使用临时配置和真实 SDK 验证发现、命令、模型调用工具、提示词与输入钩子、拦截、权限切换后工具保留、错误可见、信任、取消、关闭与恢复，以及轮次投影、续跑、停止后的 settled 状态、模型事件和分支取消。`tests/electron/flow.mjs` 验证真实桌面输入框能执行扩展命令和快捷键，并保护客户端保留键、输入法和长按。`tests/plugins/install.test.mjs` 与 Electron 流程实际安装本地 Pi 包和 Skill，验证新会话加载、模型工具调用写文件、Skill 提示注入与显式调用、读取附带文件、只读边界及重启恢复。受控模型协议服务不证明所有第三方扩展、npm/Git 网络来源、外部模型账号或 Postman 账号授权后的业务 API 已验证。`tests/agent/mcp.test.mjs` 使用真实本地 MCP 协议服务验证扩展注册、直接/codemode/混合曝光的实际工具执行和状态查询。

MCP 图形管理验证：`tests/agent/mcp-management.test.mjs` 覆盖真实原生连接与工具执行、启停/曝光/移除、配置保存及凭据不回显、扩展注册的会话范围和内置连接器禁用。Electron 流程覆盖三类入口、MCP 全流程和资源包更新/移除；使用隔离的本地协议服务，不代表真实 Postman 账号已授权。
