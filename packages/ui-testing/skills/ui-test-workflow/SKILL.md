---
name: ui-test-workflow
description: 为 UI 测试任务查询可复用资产，按需选择录制、设计、执行、分析和评估 Skill，并持久化任务交接。用于新建测试、仅录制、执行已有资产、分析旧批次或查看证据。
---

## 步骤（按序执行，不跳步）

1. **询资产** · 入：当前工作区 → 出：资产修订、可信 `review_refs`、`runtime_ready` 与能力目录
2. **定路径** · 入：用户意图 + 下方 mode 表 → 出：mode 与所需 `scope_ref` / `asset_ref` / `run_ref`
3. **开或接任务** · 入：mode 与引用 → 出：`task_ref`、当前阶段、最小 Skill 目录与缺失能力
4. **载当前阶段** · 入：最小 Skill 目录 → 出：只当前阶段的 SKILL.md 正文
5. **跑当前阶段** · 入：当前阶段说明 + 目录中的现有工具 → 出：该阶段产物与 manifest 引用
6. **交阶段** · 入：`task_ref`、`stage`、`output_refs` → 出：程序核验通过后的新 stage，或 `block` 的具体缺口
7. **收尾** · 入：全部阶段已完成 → 出：`completed`（不等于用例通过，见正文）

修订循环、任务恢复与资产维护是第 5–6 步的分支，不新增主链步骤，各自规则以对应小节为准。下文各段是对应步骤的详解。

---

先调用 `ui_test_workflow` 的 catalog，读取资产修订、可信 review_refs、runtime_ready 与能力目录。目录不执行浏览器；runtime_ready 不代替本次环境和数据预检。Agent 根据用户意图选择路径，不为分析旧结果重新录制或执行。

工具参数统一为 `{request:{operation,...}}`。start 的 input 为 task_id、mode，以及下列引用：

| 用户说的                     | mode      | 输入                                            | 路径                                                                   |
| ---------------------------- | --------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| 从录制开始 / 设计一套 / 新做一个页面 | `new`     | `scope_ref`，可选 `discovery=source/browser/both` | 发现录制 → 用例设计 → 设计评估；获批后为同一目标新建 execute 任务      |
| 只录制、先别执行             | `record`  | 同 `new`                                        | 同上，获批并登记后结束，不自动正式执行                                 |
| 设计批过了，跑一批           | `execute` | `asset_ref`                                     | 执行 → 分析 → 结果评估，不重录有效修订                                 |
| 这批为什么挂了 / 帮我分析    | `analyze` | `run_ref`                                      | 分析旧 run → 结果评估，不启动浏览器                                    |
| 把上次的证据调出来           | `view`    | `run_ref`                                      | 读取旧批次及其证据，不执行或生成新结论                                 |

拿不准时：手上只有 run 且要解释失败 → `analyze`；要重新跑 → 新建 `execute`，或**在原任务上**走执行恢复的 `resume` / `rerun-failed` / `rerun-all`（这三个不是 start 的 mode，别填进上表）；已有获批资产但用户只要看证据 → `view`。

## 阶段 Skill 一览

加载时名称必须逐字匹配，不要臆造。不存在 `ui-run-analyze`、`ui-run-execute` 这类名字；拼不上就回 `catalog` 返回的最小 Skill 目录核对。

| 环节             | Skill 名             | 何时加载                               |
| ---------------- | -------------------- | -------------------------------------- |
| 发现录制         | `ui-discover-record` | `new` / `record` 的第一步              |
| 用例设计         | `ui-case-design`     | 录制或来源清单交接后                   |
| 设计评估         | `ui-design-review`   | 设计草案产出后，独立只读审查           |
| 执行             | `ui-test-run`        | 设计获批、进入 `execute` 时            |
| 结果分析         | `ui-result-analysis` | 批次结束后做统计与失败归因             |
| 结果评估         | `ui-result-review`   | 报告候选产出后，登记批准或交付阶段报告 |
| 交接校验（跨阶段） | `ui-artifact-check`  | 任一阶段交接前做结构与来源引用校验     |


start 返回持久化 task_ref、当前阶段、最小 Skill 目录与缺失能力。仅用 Pi 的 read 加载当前阶段对应 SKILL.md；后续阶段到达时再加载。不要一次读取全部 Skill 正文。浏览器录制要求实际可用的测试 MCP；只有源码时指定 discovery=source，保存带来源清单和草稿，不称为浏览器已录制。

实际操作交给目录中的现有工具。阶段完成后 checkpoint，输入当前 task_ref、stage、output_refs（完成产物的 manifest 引用），程序核对产物、范围和批准后前进；这不是手填 completed。execute 的 runner 会更新任务批次登记，调用 status（task_id）取得最新 task_ref 再 checkpoint。旧摘要冲突时重新读取当前状态，不覆盖任务或换 ID 重放业务动作。

discover-record 交接完整 recording；source 模式交接含 draft_refs 的 inventory。case-design 交接带本任务来源/录制的 asset 候选；design-review 交接可信设计评估。execute 交接本任务已结束 run；analyze 交接同 run 的 report；result-review 交接对应 result-review，程序核验并生成正式交付。证据不足时以 partial report 交接阶段报告，不带批准仍明确完整性未通过。view 读取原 run 后用该 run_ref checkpoint 结束。

需要修订时留在当前阶段，按设计/结果评估 Skill 的有限循环处理；最多三轮、无改善或证据不足按既有门禁阻塞。用 block（task_ref、reasons）登记具体缺口，保留真实产物。已完成阶段不倒退；修复脚本生成新资产任务，不能覆盖历史候选/结果。

重开客户端或新会话后重新 catalog、status，不依赖旧聊天或浏览器 ref。有效批准和运行证明仍须当前文件与依赖一致。旧 run 活跃/中断/副作用未知时禁止换任务 ID 重放相同模块；阶段恢复和失败集合重跑使用下述入口，未知业务写入仍须核对。任务 completed 仅表示所选工作流结束，不代表用例全部通过或报告完整性已通过。


恢复任务时先 status 查询原 task；`resume-task` 传最新 task_ref，仅核对当前能力与已有产物、恢复原阶段，保留 completed_stages、产物和评估预算，不重录已完成阶段。终态不复活。录制中断仍查询原日志及数据归属，partial 不可直接交接设计；未知副作用先核对，不能从临时浏览器 ref 接着点击。

执行恢复使用 mode=resume/rerun-failed/rerun-all，run_ref 指向父批次；先使用 ui-test-run 的 plan-recovery 检查选择和阻断。分析交接和最终报告绑定本任务新 run，不能误用父 run。执行已完成、分析未完成时，继续当前 analyze 或新建 analyze 指向旧 run，无需重新执行。


资产维护按需调用 `ui_asset_maintain`，不是另一个工作流平台：
- impact：提供 changed_paths 或 git_ref（二选一），输出已登记依赖/受影响资产/不完整问题。只按登记引用判断；不完整则保守重审，不能称精确代码影响。只补相关片段或修订并回设计/诊断，新部署仍按有效旧用例回归。
- inspect-import：提供项目内 script_path，仅发现已有测试标题及行号，动态标题显式待核对。将返回 script_ref 交给 ui-case-design，补来源、case/断言映射、依赖和数据规则，再独立设计评估；不改写旧测试使其通过。
- export：asset_ref、bundle_id，复制引用闭包到 qa/ui-transfers/<id>，不复制私有认证/模型/会话/批准。缺依赖或绝对模块路径先修订，不隐藏迁移失败。
- import：迁移文件夹已放入允许的新项目后，传 bundle_ref。缺失/损坏依赖返回清单，不从头重生成；目标环境重新核对依赖、身份、设计批准和诊断，未迁移旧批准。
- audit-evidence：retention_days、audit_id，保存到 qa/ui/maintenance，标记超过保留期及不可核验文件。已登记 run 引用默认保护，当前没有外部缺陷关闭的可信源，所以不自动删除；不要用审计覆盖原始报告。

按任务 ID 衔接时，status 返回当前阶段的 `stage_inputs`（当前 task/scope、已交接资产、唯一选定 run、报告及既有产物）和当前技能目录；不从聊天摘要或最新文件时间猜引用。使用 `handoff` 传 task_id、stage、output_refs，可省去手工复制易失效的 task_ref；程序重读最新任务并复用原 checkpoint 校验。相同已完成阶段/原产物重复返回 replayed=true；并发占用、改变产物、阻塞/取消或阶段冲突先核对，不自动重放。原 checkpoint 和显式 resume-task 继续兼容。

用户已明确要求本范围“生成并执行”时，new 完成后可调用 `continue-execute`（task_id、authorized_asset_ref），摘要必须与该任务完整获批资产一致；返回稳定的独立 execute 任务和 execution_scope，列出全资产 case_ids。该操作只登记任务，不启动浏览器；诊断与每批预检仍由原生门禁强制。record 不自动承接，局部授权不能扩大为完整资产。入库、绑定、同步权限各自独立，不由此操作授予。未知副作用、取消或中断先查旧任务/批次，禁止重新创建目标逃避阻塞。

## 失败分支索引

只列跨阶段高频项，逐阶段细则以正文为准。

| 触发 | 一线 | 兜底 |
| --- | --- | --- |
| `runtime_ready` 为真 | 仍执行本次环境与数据预检 | 不用目录结果代替预检 |
| 录制 MCP 不可用 | 改 `discovery=source` 产草案 | 不称“浏览器已录制” |
| 录制中断留 partial | 查原日志与数据归属 | 不可直接交接设计 |
| `record` 走完 | 登记后结束 | 不自动承接正式执行 |
| 阶段证据不足 | 以 partial report 交接 | 不带批准，明示完整性未通过 |
| 修订无改善或超三轮 | 留在当前阶段 | `block` 登记缺口，保留真实产物 |
| 旧 run 活跃 / 中断 / 副作用未知 | 先查旧任务与批次 | 禁止换 task ID 重放相同模块 |
| 旧摘要与当前状态冲突 | 重读当前状态 | 不覆盖任务、不换 ID |
| 任务已达终态 | 不复活 | 需继续则新建任务 |
| 并发占用 / 阶段冲突 / 已取消 | 先核对实际产物 | 不自动重放 |
| `export` 缺依赖或含绝对模块路径 | 先修订 | 不隐藏迁移失败 |
| `import` 依赖缺失或损坏 | 返回清单 | 不从头重生成 |
