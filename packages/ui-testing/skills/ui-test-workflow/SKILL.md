---
name: ui-test-workflow
description: 为 UI 测试任务查询可复用资产，按需选择录制、设计、执行、分析和评估 Skill，并持久化任务交接。用于新建测试、仅录制、执行已有资产、分析旧批次或查看证据。
---

先调用 `ui_test_workflow` 的 catalog，读取资产修订、可信 review_refs、runtime_ready 与能力目录。目录不执行浏览器；runtime_ready 不代替本次环境和数据预检。Agent 根据用户意图选择路径，不为分析旧结果重新录制或执行。

工具参数统一为 `{request:{operation,...}}`。start 的 input 为 task_id、mode，以及下列引用：

| mode | 输入 | 路径 |
|---|---|---|
| new | scope_ref，可选 discovery=source/browser/both | 发现录制 → 用例设计 → 设计评估；获批后为同一目标新建 execute 任务 |
| record | 同 new | 同上，获批并登记后结束，不自动正式执行 |
| execute | asset_ref | 执行 → 分析 → 结果评估，不重录有效修订 |
| analyze | run_ref | 分析旧 run → 结果评估，不启动浏览器 |
| view | run_ref | 读取旧批次及其证据，不执行或生成新结论 |

start 返回持久化 task_ref、当前阶段、最小 Skill 目录与缺失能力。仅用 Pi 的 read 加载当前阶段对应 SKILL.md；后续阶段到达时再加载。不要一次读取全部 Skill 正文。浏览器录制要求实际可用的测试 MCP；只有源码时指定 discovery=source，保存带来源清单和草稿，不称为浏览器已录制。

实际操作交给目录中的现有工具。阶段完成后 checkpoint，输入当前 task_ref、stage、output_refs（完成产物的 manifest 引用），程序核对产物、范围和批准后前进；这不是手填 completed。execute 的 runner 会更新任务批次登记，调用 status（task_id）取得最新 task_ref 再 checkpoint。旧摘要冲突时重新读取当前状态，不覆盖任务或换 ID 重放业务动作。

discover-record 交接完整 recording；source 模式交接含 draft_refs 的 inventory。case-design 交接带本任务来源/录制的 asset 候选；design-review 交接可信设计评估。execute 交接本任务已结束 run；analyze 交接同 run 的 report；result-review 交接对应 result-review，程序核验并生成正式交付。证据不足时以 partial report 交接阶段报告，不带批准仍明确完整性未通过。view 读取原 run 后用该 run_ref checkpoint 结束。

需要修订时留在当前阶段，按设计/结果评估 Skill 的有限循环处理；最多三轮、无改善或证据不足按既有门禁阻塞。用 block（task_ref、reasons）登记具体缺口，保留真实产物。已完成阶段不倒退；修复脚本生成新资产任务，不能覆盖历史候选/结果。

重开客户端或新会话后重新 catalog、status，不依赖旧聊天或浏览器 ref。有效批准和运行证明仍须当前文件与依赖一致。旧 run 活跃/中断/副作用未知时禁止换任务 ID 重放相同模块；完整中断核对及失败集合重跑留待后续能力。任务 completed 仅表示所选工作流结束，不代表用例全部通过或报告完整性已通过。


恢复任务时先 status 查询原 task；`resume-task` 传最新 task_ref，仅核对当前能力与已有产物、恢复原阶段，保留 completed_stages、产物和评估预算，不重录已完成阶段。终态不复活。录制中断仍查询原日志及数据归属，partial 不可直接交接设计；未知副作用先核对，不能从临时浏览器 ref 接着点击。

执行恢复使用 mode=resume/rerun-failed/rerun-all，run_ref 指向父批次；先使用 ui-test-run 的 plan-recovery 检查选择和阻断。分析交接和最终报告绑定本任务新 run，不能误用父 run。执行已完成、分析未完成时，继续当前 analyze 或新建 analyze 指向旧 run，无需重新执行。


资产维护按需调用 `ui_asset_maintain`，不是另一个工作流平台：
- impact：提供 changed_paths 或 git_ref（二选一），输出已登记依赖/受影响资产/不完整问题。只按登记引用判断；不完整则保守重审，不能称精确代码影响。只补相关片段或修订并回设计/诊断，新部署仍按有效旧用例回归。
- inspect-import：提供项目内 script_path，仅发现已有测试标题及行号，动态标题显式待核对。将返回 script_ref 交给 ui-case-design，补来源、case/断言映射、依赖和数据规则，再独立设计评估；不改写旧测试使其通过。
- export：asset_ref、bundle_id，复制引用闭包到 qa/ui-transfers/<id>，不复制私有认证/模型/会话/批准。缺依赖或绝对模块路径先修订，不隐藏迁移失败。
- import：迁移文件夹已放入允许的新项目后，传 bundle_ref。缺失/损坏依赖返回清单，不从头重生成；目标环境重新核对依赖、身份、设计批准和诊断，未迁移旧批准。
- audit-evidence：retention_days、audit_id，保存到 qa/ui/maintenance，标记超过保留期及不可核验文件。已登记 run 引用默认保护，当前没有外部缺陷关闭的可信源，所以不自动删除；不要用审计覆盖原始报告。
