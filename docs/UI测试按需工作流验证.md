# UI 按需工作流与重启复用验证

更新：2026-10-21。对应 UI-09；整体任务与后续验收见[实施计划书](./UI测试能力实施计划书.md)。

## 实现与复用

复用现有 Pi 1.2.0 的 Skill 发现/读取、package、扩展工具注册，以及既有 ArtifactStore、DesignReviewService、UiRunService 和 ResultReviewService。工作流入口只选择阶段、列能力、查询磁盘资产和核验 checkpoint；不包办各阶段，也不增加模型执行循环、MCP 桥接、调度平台、依赖或新界面。

`ui-test-workflow` 是简短入口 Skill；`ui_test_workflow` 提供 catalog/start/status/checkpoint/block。Agent 只读取当前相关 Skill 正文。任务保存在既有 manifest 中，workflow 字段采用向后兼容的可选扩展；已有任务无需迁移。mode、原始 run 和发现方式被冻结，不能在更新时将仅录制改成正式执行。

new/record 先完成录制或有来源的源码发现、用例设计和可信设计评估。record 结束后没有正式 run；new 交给独立 execute 任务。execute 复用选定资产及有效批准，重新预检环境，创建新批次；analyze/view 只使用旧批次证据。工作流完成表示所选任务结束，测试失败或报告 partial 均须原样保留。

## 验证场景

| 场景 | 可观察证据 |
|---|---|
| 源码模式仅录制 | inventory/draft → 同来源 asset → 设计批准，最终 completed、run_ids 为空，浏览器请求不增加 |
| 浏览器模式仅录制 | 既有真实 Pi Skill 与原生测试 MCP 自动交互、保存日志并清理；工作流接收完整 recording，关联候选后获批；无正式执行 |
| 新建并执行的交接 | 准备阶段完成后返回 execute 后续任务指引，不改变 record 意图或在准备任务内私自执行 |
| 重启后复用 | 第一个独立 Node 进程使用客户端 AgentHost 完成可信评估、诊断和首个 run，退出并清理 MCP；第二个独立进程创建新会话，catalog → start → 读取执行 Skill → run → status → checkpoint |
| 跳过多余阶段 | 第二进程的工具日志没有录制、生成、设计评估或诊断调用；新 run 与旧 run 不同，实际浏览器请求增加且原生退出码为 0 |
| 不依赖旧聊天 | 新会话 ID 不同，请求不包含第一个进程的用户提示词；引用从持久化 catalog 和任务状态取得 |
| 仅分析或查看 | 旧失败 run 完成分析、独立评估和报告交付；view 读取旧 run 后结束，两者均不增加浏览器请求 |
| 阶段报告 | 删除 trace 后创建新统计/报告；工作流只能生成明确标记完整性未通过的阶段交付，不覆盖历史失败 |
| 能力和版本 | 缺 Skill/工具/MCP、Playwright 版本不匹配均保留具体 blocked 信息；未知 schema/模式被既有校验器拒绝 |
| 可靠交接 | 跳阶段、缺真实产物、候选来源脱节、改写冻结意图及旧摘要覆盖受拒；runner 更新后必须读取最新 task_ref |
| 未核对的旧启动 | 旧 active-run 登记阻断同目标重叠模块的新执行；更换 task/scope ID 不能绕过；不会尝试恢复旧浏览器点击 |

自动化证据为 `tests/ui-testing/workflow.test.mjs`、`tests/support/ui-workflow-process.mjs` 和扩展的 `tests/ui-testing/recording.test.mjs`。宿主重启测试使用两个真正退出的独立进程；另增加 `tests/electron/ui-workflow.mjs`，实际启动 Electron 窗口、通过隔离 preload/IPC 新建项目会话和发送工作流任务，完全关闭后再启动。两次均使用构建分发包，复用原资产与可信批准，产生不同 run；记录并检查客户端及其子进程全部退出，第二次请求不含第一次聊天。受控回复仍不作为真实模型规划证据。

本阶段 `npm run check`、`npm run build` 通过；`node --test tests/*/*.test.mjs` 为 **96 项通过、3 项外部模型默认跳过**。工作流及录制专项共 12 项通过；新增 Skill 通过 `skill-creator/scripts/quick_validate.py`。文档本地引用与差异检查按仓库规则核验。

源码包与构建包的全部 UI Skills/工具注册另经契约专项 6 项检查通过。桌面专项命令为 `node tests/electron/ui-workflow.mjs`（先构建），首轮证据在 `evidence/ui-testing/ui-09/1792562361220/result.json`；第二轮 `1792562498611/` 同时归档 `qa/ui/` 原始产物和需求来源，不复制模型认证或用户配置。

## 验证边界

受控协议模型用于确定调用序列，浏览器、MCP、Playwright runner、文件和进程均为实际实现。模型自主规划质量、两个 reviewer 的独立重复校准及真实模型完整主链仍在 UI-10；不得把本阶段受控响应当真实模型能力证明。完整中断恢复、失败集合重跑、跨目录迁移及证据维护仍属于 UI-11/UI-12。
