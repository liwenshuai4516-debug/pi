# Pi Agent 客户端协作指南

本文件是本项目统一协作规范，由根目录与客户端原有规则合并、去重而成；适用于客户端源码、docs/ 内的项目文档和原型工作。用户最新明确要求优先于文档；子目录有更具体规则时，在其范围内遵循且不得违反技术基准。

## 1. 技术基准与工程边界

- **唯一技术基准：Pi Agent SDK + Electron + TypeScript。** 用户已进一步明确直接使用 `@earendil-works/pi-agent-core` 的 `Agent`。
- 唯一应用工程是本目录 `agent-client/`。旧 `client/`、`desktop/` 和项目内 `.pi-web/` 已移除，不恢复另一套应用或启动入口。
- `src/main/agent/agent-host.ts` 直接 `new Agent(...)`，调用其 `subscribe`、`prompt`、`abort`、`waitForIdle`；不得用 `createAgentSession` / `AgentSession` 代管执行、解析 CLI 输出，或自建 Agent 执行循环。
- 可复用 Pi 的 `ModelRuntime`、内置工具、声明式资源加载、消息转换和 `SessionManager` JSONL 辅助模块；不修改 Pi 框架源码，不另造模型协议或会话存储格式。
- Electron main、preload、renderer 的业务逻辑全部使用 TypeScript。renderer 不引入 Node 或 SDK，不读取凭据文件或接收已保存的 API Key；模型表单仅将用户输入提交主进程，通过明确声明并校验的 preload/IPC 调用主进程。本地 HTML/CSS 由 `file://` 加载，不启动 Pi Web、Next.js 或本地 HTTP/SSE 业务服务。
- 保留 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、webSecurity、CSP 和 IPC 来源校验。Electron renderer 沙箱与工作区文件读写沙箱是不同能力，不混淆或虚报。
- Pi Agent 是客户端名称。请求的 provider/model ID 跟随当前选择，覆盖切换和历史恢复；不硬编码供应商身份，不以模型自述作为服务端来源证明。

## 2. 阅读依据与功能范围

- 技术约束以 [技术设计与约束](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/技术设计与约束.md) 为准；操作、目录与函数索引见 [操作与功能修改指南](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/操作与功能修改指南.md)。索引用于定位，实施前仍须阅读实际源码和相关测试。
- `docs/pi-web-desktop/01`–`03` 及旧产品方案是历史资料，不再施加 Web 加壳架构、API 迁移或旧阶段门要求。当前实现范围见 `README.md` 和 `docs/pi-web-desktop/04-SDK客户端首版实现说明.md`。
- 界面依据为 `docs/demo/` 的 HTML/CSS/JS、README 及用户最新调整：暖白主题、左侧会话、居中聊天、默认收起右栏，输入底栏按附件、提示模板、模型、思考、工作区权限排列。不得恢复已移除的“只读工具”选择器。
- 原型是设计参考，不是正式业务实现或验收证据。修改原型不会改变客户端；不得用固定回复、假数据、假成功替代真实功能，不自行扩展功能或交互。
- 既有产品行为未明确时，查阅 `/Users/liyingjun/Desktop/SW-QA/pi-web-main` 对应源码、测试及专题说明；它仅供语义参考，不是当前运行依赖。`source-baseline.json` 不能替代阅读源码。查阅后仍有影响实现的冲突时，说明来源和影响并澄清；独立工作可继续。
- 优先完成真实主流程：选择目录 → 新建/续接 → 配置并选择模型 → 发送 → 流式回复与工具结果 → 停止 → 切换和重启续接。首版优先级不构成删除既有功能的授权。
- 工作区权限提供只读、工作区读写（默认）、完全访问；macOS 通过公开 SDK 工具 operations/spawnHook 和系统沙箱执行受限文件 I/O 与命令。区外系统运行文件的读取和网络边界须如实展示；其他系统受限操作拒绝执行，不静默降级。项目信任、Electron renderer 隔离和工具文件权限分开说明。插件/MCP 等未接入能力继续登记缺口。

## 3. 编码前思考

- 先明确需求、源码依据、影响范围、约束、取舍与可验证的成功标准；不默默选择会影响实现的假设。
- 有多种解释时说明差异；不清楚时提出具体问题，不凭猜测实现。若有更简单方案，说明方案及取舍。
- 多步骤工作给出简短计划，每一步写明验证方式：明确范围 → 完成必要修改 → 检查最终结果。

## 4. 简洁优先

- 用满足需求的最少代码，不添加未要求功能、推测性配置、一次性抽象或不必要的错误处理。
- 不因个人偏好拆分、重构或改变已有风格；明显可以简化的实现采用直接方案。

## 5. 精准修改与中文注释

- 每项改动应能追溯到当前请求，保留用户修改，不顺手重构相邻代码、格式或无关注释。
- 关键逻辑、边界条件和不直观的实现原因添加适当中文注释，不逐行解释显而易见的代码。
- 删除本次改动造成的无用导入、变量和函数；已有无关死代码仅说明，不自行删除。
- 修改 `src/` 实现业务；不直接编辑 `dist/`、`release/` 或 `node_modules/` 代替源码修改。

## 6. 目标驱动执行与验证

- 所有应用命令在本目录执行。`npm run dev` / `npm start` 先构建再打开 Electron，无热更新；修改后完全退出并重启，避免单实例机制唤起旧窗口。
- 模型、凭据和历史默认在 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 覆盖。工程清理和测试不得顺带删除、覆盖用户数据；API Key 不进入 renderer 返回值、会话、日志、截图或文档。
- 修复缺陷先添加可复现测试，输入验证覆盖无效值，重构确认前后行为。按实际改动选择 `npm run check`、`npm test`、`npm run test:electron`；构建与打包使用 `package.json` 的实际命令，不虚构。
- 测试使用临时 Agent 配置、项目和 Electron 数据目录。受控协议 fixture 验证真实 SDK、工具及请求行为，不能声称已验证外部模型账号、模型质量或全部第三方服务。
- `npm run package` 生成内部验证应用，不执行发布命令；未签名、公证包与正式分发版本区分。外部账号、平台或环境不可用时如实登记待验证，继续独立可做工作。
- 原型验证方式见 `docs/demo/README.md`，不能当作真实客户端通过证据。仅文档修改检查内容、引用和链接，不必运行模型请求。
- 完成后报告实际改动、验证证据和未解决问题，区分已实现、未接入、待验证和模拟内容；未运行的检查不得声称通过。

## 7. 模块归属

- 按 [项目目录与模块开发规范](docs/项目目录与模块开发规范.md) 开发：主进程业务放 `main/agent`、`sessions`、`models`、`workspace`；IPC 统一在 `main/ipc/register.ts` 校验，`main/index.ts` 只协调窗口与生命周期。
- 界面按 `renderer/features/chat`、`composer`、`sessions`、`models`、`workspace` 放置；`app.ts` 负责应用状态和模块组合，不重新堆叠全部功能。共享 DOM 辅助在 `renderer/shared`，跨进程类型在 `src/shared/types.ts`。
- 样式按功能放 `renderer/styles/`，测试按功能放 `tests/<模块>/`，受控服务在 `tests/support/`。只在实际有业务需要时增加模块，不创建空壳或循环依赖。
- 思考强度使用 SDK 支持的级别；表单可声明模型 `reasoning`，不得根据模型名猜测，不支持的能力不能只改界面伪装生效。
- Enter 发送，Shift+Enter 换行；保留 IME composition、keyCode229、repeat 和运行状态检查，不使用会吞掉正常 Enter 的固定延时。

## 8. 文档同步

- 功能、文件、函数、IPC、数据位置、操作或命令变动时，同步维护操作与功能修改指南、相关 README 及受影响的技术设计章节，只更新相关内容。
- 检查索引和链接，保持设计约束与当前实现状态分开；历史计划、受控测试回复不作为已交付能力证明。

## 9. Git 提交与回滚

- Git 仓库根目录为本客户端目录，远程 `origin` 为 `https://github.com/liwenshuai4516-debug/pi.git`。
- **每次完成一项代码更新并执行相关验证后，自动创建本地 Git 提交，便于回滚，无需再次询问是否提交。** 提交以完整、可说明的改动为单位，不对每次保存文件单独提交。
- 提交前检查差异与暂存区，仅提交当前任务相关改动；保留用户已有的无关修改，不一并暂存。使用清晰的中文提交说明，完成后报告提交短哈希和实际验证结果。
- 遵循 `.gitignore`，不提交依赖、构建包、验证产物、凭据或用户会话数据。检查失败时先修复；环境阻塞导致无法验证或提交时，明确说明原因，不声称已通过或已提交。
- 自动提交指本地版本记录；远程推送在用户授权时执行。不得擅自强制推送、重写已有提交或用破坏性重置覆盖用户工作；回滚优先通过 `git revert` 创建反向提交。
