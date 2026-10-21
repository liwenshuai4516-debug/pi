# UI 测试能力接入验证

更新：2026-10-21。对应实施任务 UI-01。结论：**当前 Pi 客户端可直接接入 Playwright 测试 MCP；真实模型自动录制和独立直接 Agent 评估已验证。** 此结论只覆盖兼容性，不表示已实现资产审批、正式执行门禁、持久化工作流或评估质量校准。

## 复用选型与版本

| 能力 | 复用来源与版本 | 实测与取舍 |
|---|---|---|
| MCP 接入 | Pi SDK / pi-mcp 1.2.0 原生连接、工具发现、取消与 roots | 直接使用现有 `AgentHost`，没有新建 MCP 桥接层 |
| 浏览器录制与执行 | Microsoft Playwright 1.62.1 测试 MCP、Test runner、Chromium | 真实交互、日志、生成文件和独立 context 验证通过；锁定版本，不同时接入其他浏览器后端 |
| 生成脚本标准依赖 | `@playwright/test` 1.62.1，Apache-2.0 | 补齐官方脚本常用入口，复用同一版 Playwright，不复制执行器实现 |
| Skill 加载 | Pi 原生资源发现、`/skill:ui-recording-proof` | 临时目录中的最小技能被发现并实际展开；没有修改用户技能配置 |
| 独立评估 | `pi-agent-core.Agent` + `ModelRuntime` | 独立直接 Agent、全新消息、`tools=[]`；只读候选和原始需求，无生成者对话、写入及执行能力 |

公开依据：[Playwright Test Agents](https://playwright.dev/docs/test-agents)、[Playwright 源码](https://github.com/microsoft/playwright)、[Pi 上游](https://github.com/earendil-works/pi)。本次成功读取 Playwright 官方网页，并对照安装版 `lib/mcp/test/` 与 Pi SDK 附带 `docs/mcp.md`、`docs/packages.md`。Pi 上游原始文档网络读取未成功，兼容性结论以锁定安装版本和实际调用为准，不据此宣称已核实后续版本。

## 已验证的真实路径

1. 创建独立配置和带空格的临时工作目录，启动只监听本机的受控测试页面。页面允许填写 Name、Save，并在刷新后读取同一浏览器 context 的 localStorage；该页面只是流程测试 fixture。
2. 原生 MCP 使用 stdio 启动：`node <playwright/cli.js> run-test-mcp-server --headless -c <测试配置>`。由 Pi 提供 roots，发现 generator 与 browser 工具。
3. 实际调用 setup、type、click、snapshot、日志读取和脚本生成。测试 MCP 的动作需要 `intent`，1.62.1 定位参数为 `target`；操作后不保证内联完整快照，必要时显式读取快照。
4. 生成脚本通过原生 Playwright Test 在新 context 中执行，并断言提交名称与刷新后的名称一致。此执行标记为设计验证，不计入未来正式业务 run。
5. 受控协议验证还覆盖无效定位器返回错误、等待动作取消后及时结束。模型响应由协议 fixture 控制，浏览器和 MCP 均是真实实现。
6. 外部已配置模型独立完成录制及脚本生成；另一个无工具的直接 Agent 从原始需求审查恒真断言，输出 `revise`、D4 和对应代码证据。该样本只证明评估路径可行，不替代 UI-10 的保留样本与重复评估。

注意：Pi MCP 配置 `timeout` 的单位是秒，本验证使用 45。服务名 `playwright-test` 被原生 Pi 标准化为工具名前缀 `mcp__playwright_test__`，应以工具发现结果为准。工具元数据的 readOnly 标记不能代表 setup/写脚本没有副作用。

## 运行方法与证据

在客户端工程运行：

```sh
npm run check
npm test
PI_UI_LIVE=1 node --test tests/ui-testing/live-compatibility.test.mjs
```

普通 `npm test` 只执行受控协议及真实浏览器验证，外部模型验证明确跳过。活体验证可用 `PI_UI_MODEL_DIR` 指定配置来源，默认读取用户 Pi 的自定义模型与默认选择，将选中 provider 配置和认证复制到权限 0600 的隔离目录；不加载用户扩展，不改写原配置，收尾删除凭据副本。输出只包含测试页面信息与必要模型标识。

本次结果：类型检查通过；`npm test` 34 项通过、1 项活体验证跳过；另行执行的活体验证 1 项通过。实际配置标识为 `deepseek/deepseek-v4-pro`，不作为远端服务内部模型身份的独立证明。

本地活体证据目录：`evidence/ui-testing/ui-01/1792548965293/`，包含工具事件、生成脚本、原生设计验证报告、独立评估和 summary。运行产物按仓库规则不提交；通过上述命令可重新生成新的证据目录。受控协议测试另输出临时项目证据路径。

剩余缺口：UI-02 起建立正式契约和可分发能力包；UI-03 实现业务持久化；UI-06 建立可信评估登记与执行门禁；UI-10 才验收两个 reviewer 的质量。本次无需新增组件界面或调度框架。
