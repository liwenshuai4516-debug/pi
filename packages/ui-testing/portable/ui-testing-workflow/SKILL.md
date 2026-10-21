---
name: ui-testing-workflow
description: 在 Pi Agent SDK 项目中复用完整 UI 自动化测试工作流：按需发现录制、设计与独立评估、Playwright 执行、证据分析与结果评估，以及续跑和资产迁移。用于建立 UI 测试、运行已有资产或分析旧批次；首次使用先检查配套扩展和测试 MCP。
---

# 可复用 UI 测试工作流

本 Skill 配套 `pi-ui-testing` 0.1.0 运行包，复用已完成的 UI-01～UI-12。主路径是 Pi Agent SDK 1.2.0 + Playwright Test 1.62.1；不需要原客户端或 Electron。仅安装 SKILL.md 不会注册工具。

## 首次接入

先读 [安装与 Pi SDK 接入](references/install.md)，安装随附运行包并注册其扩展与阶段 Skills。运行 `node <本Skill目录>/scripts/doctor.mjs <被测项目绝对路径> --browser` 检查安装及本地 Chromium。检查成功不表示 MCP 已连接、模型可用或业务已通过。

按 [环境与数据准备](references/project-setup.md) 补齐真实目标、角色、身份探针、初态、数据准备与归属清理。缺少影响执行的事实时列明缺口；源码发现、旧证据查看等独立工作仍可继续。

## 选择任务

先调用 `ui_test_workflow`：`{"request":{"operation":"catalog"}}`，从磁盘选择资产和批次，不依赖旧聊天。参见 [工具与产物索引](references/tools-and-artifacts.md)。

| 用户意图 | mode / 输入 | 要做的事 |
|---|---|---|
| 从零建立并运行 | new / scope_ref | 发现、设计、设计评估；获批与诊断就绪后，新建 execute 任务 |
| 仅录制并形成资产 | record / scope_ref | 同上准备链；不自动进入正式执行 |
| 执行已有资产 | execute / asset_ref | 有效批准和诊断 → 本次预检 → 新 run → 分析 → 结果评估 |
| 仅分析旧结果 | analyze / run_ref | 统计、分析、评估；不重新执行 |
| 查看历史证据 | view / run_ref | 读取旧批次，不产生新业务结论 |
| 继续未执行 / 重跑失败 / 全量重跑 | resume / rerun-failed / rerun-all，run_ref | 先 plan-recovery，冻结父批次选择，从 case 初态运行新批次 |

start 传 `{"request":{"operation":"start","input":{"task_id":"本次唯一ID","mode":"execute","asset_ref":{"path":"实际相对路径","sha256":"实际摘要"}}}}`；其他模式用表中相应引用。实际 schema 由运行包提供，不照抄占位值。

## 按需加载阶段说明

只读当前阶段。优先使用工具返回的、已安装运行包内的 Skill 路径；下表为随附的同版原文，规则不得另写一份替代。

| 阶段 | 说明 |
|---|---|
| 总流程、checkpoint、恢复、维护 | [ui-test-workflow](assets/runtime/skills/ui-test-workflow/SKILL.md) |
| 发现与录制 | [ui-discover-record](assets/runtime/skills/ui-discover-record/SKILL.md) |
| 用例、断言和候选脚本 | [ui-case-design](assets/runtime/skills/ui-case-design/SKILL.md) |
| 独立设计评估与正反诊断 | [ui-design-review](assets/runtime/skills/ui-design-review/SKILL.md) |
| 正式执行与失败重跑 | [ui-test-run](assets/runtime/skills/ui-test-run/SKILL.md) |
| 统计、失败分析、trace 取证 | [ui-result-analysis](assets/runtime/skills/ui-result-analysis/SKILL.md) |
| 独立结果评估与交付 | [ui-result-review](assets/runtime/skills/ui-result-review/SKILL.md) |
| 产物契约核对 | [ui-artifact-check](assets/runtime/skills/ui-artifact-check/SKILL.md) |

完成阶段后使用最新 task_ref 和真实 output_refs 做 checkpoint。runner 更新任务后先 status 取新摘要。已完成阶段不重做；新会话重新 catalog/status。迁移和故障分流见 [恢复与维护](references/recovery.md)。

## 执行约束

- 需求、源码声明、行为基线分别标记 requirement/declaration/baseline；录制观察不能自行升级为需求。断言必须绑定来源、具体业务对象及步骤，点击成功不等于业务通过。
- 设计评估由全新、无工具 Agent 读取原始材料；设计批准后仍需受控正反诊断登记，正式执行再做当前环境预检。结果评估也独立进行。两个评估循环各自最多三轮，失败调用计预算，不能换 ID 清零。
- 同一启动请求的查询使用原 request_id；未知写入、中断或诊断状态不明先核对，不自动重放。首期 Chromium、单 worker、零自动重试；未交付并行多 Agent 和多浏览器扩展。
- 产物存在、工具 completed、任务完成、测试通过、报告完整是不同状态。保留 failed/flaky/blocked/skipped/cancelled/not-run/unknown；子集重跑成功不能覆盖父批次失败。
- 事实与根因解释分开。证据不够就写 unknown 或 partial；不猜服务端原因，不自填 approved，不改旧断言、统计或失败记录来通过门禁。
- 私有 storageState、模型认证和批准登记留在宿主私有位置。测试数据只清理本批次明确归属的对象；清理失败和未知副作用必须报告。

交付时给出范围、角色/环境/部署版本、资产修订、run 与父批次、确定性统计、失败证据、清理残留、独立评估/完整性状态和下一步。验收方法及已验证边界见 [验收与能力边界](references/acceptance.md)。
