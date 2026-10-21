# UI 正式执行与原始证据验证

更新：2026-10-21。实现与进度见[实施计划书](./UI测试能力实施计划书.md)。本次完成 UI-07 的正式执行入口，不代表 UI-08 至 UI-12 或完整测试闭环已经完成。

## 实现与复用

复用现有 Pi package、扩展工具注册和 Skill 加载；`ui_test_run` 调用 `UiRunService.start/status`。测试执行、浏览器 context、fixture、断言、JSON reporter、截图和 trace 均由安装的 Playwright Test 1.62.1 实现。项目只增加请求去重、门禁、业务批次和证据关联；环境预检复用 `preflightEnvironment`，存储与启动登记复用 `ArtifactStore`、proper-lockfile 4.1.2。不增加 MCP 桥接、Agent 循环、调度平台或新界面。

原生报告是结果来源，执行摘要是收集状态。完成收集且 exit_code=1 的批次仍可能包含产品失败；不能因为工具返回 completed 就宣称测试通过。冻结计划、实际命令、进程启动意图、PID/令牌、原始退出码、attempt、断言步骤和证据引用保存在各自 run 目录中。

## 已执行检查

`npm run check`、`npm run build` 通过。`node --test tests/*/*.test.mjs` 为 **84 项通过、2 项外部模型测试未启用**。新增的 `tests/ui-testing/run.test.mjs` 有 8 项，使用真实原生 runner 和 Chromium：

| 场景 | 已核验结果 |
|---|---|
| 正常执行、重复请求与新批次 | 冻结实例与原生 attempt 对应；同请求重启后只读原结果；第二个新请求得到不同 run、相同计划且从干净 context 成功执行 |
| 产品真实断言失败 | 正常副本诊断获批后对有缺陷的当前目标执行，保留 exit_code=1、原始失败 A1 步骤、截图和 trace；不改预期使其变绿 |
| 无可信运行证明 | 在登记 run 和浏览器动作前拒绝，不接受设计批准代替运行登记 |
| 身份失效 | 保存 identity 前置失败，未启动业务测试进程，不创建伪造 attempt |
| 原生进程启动异常 | 通过隔离测试中的无效 Node 选项触发真实启动失败，保留实际退出码和 stderr；没有报告时标记收集缺口 |
| 取消与并发 | 活跃任务并发被拒；取消保留中断批次及启动观察，同请求不重放，换 ID 也被活跃登记阻断 |
| 原生全局超时 | 受控 globalSetup 挂起，由 Playwright globalTimeout 终止；原生报告的超时原文保留，批次处于待核对状态，不自动再执行 |
| Agent 工具与重启查询 | 真实 Pi Skill/扩展完成独立 review → 原生诊断 → 正式执行；完全销毁该 AgentHost 后，新 Agent 查询同批次不增加浏览器请求 |

测试准备曾因 URL pathname 未解码而无法加载含空格路径中的 globalSetup；已使用 Node 标准 `fileURLToPath` 修复，并通过超时专项和完整回归。该失败发生在诊断阶段，没有被报告为正式超时验证成功。

新 Skill 通过 skill-creator 的 `quick_validate.py`，相关文档本地链接及 `git diff --check` 通过。受控模型负责可重复的工具调用协议；本次不据此声称任意真实模型都能自主规划完整业务，真实模型完整闭环与重复评估校准仍在 UI-10。

## 当前限制

首期仅支持已声明的单 chromium 项目、单 worker、无自动业务重试。批次状态查询不恢复进程或浏览器；未知副作用和中断保留阻断，后续由 UI-11 增加核对能力。环境及数据归属仍须项目提供，context 不能自动隔离服务端共享对象。

UI-08 尚须从冻结计划和原生报告逐项对账、统计并评估失败归因与报告；当前不生成“全部通过”或虚构根因。UI-09 尚须提供总流程按需选择及完整资产重启复用路径；已有正式执行查询能力不能替代该任务的全部验收。
