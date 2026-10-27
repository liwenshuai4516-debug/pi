---
name: ui-result-analysis
description: 从已有 UI 正式批次计算统计、按原始证据分析失败并生成报告候选。用于分析旧 run，不启动浏览器，不修改原始执行结果；候选须独立结果评估后交付。
---

调用 `ui_result_analysis` 的 parse 操作，传 run_ref、result_id。结果由冻结计划与原生 Playwright 报告逐实例对账，包含互斥终态、全部 attempt、证据缺口、功能/模块/优先级及 oracle 维度。稳定通过率分母为 passed+failed+flaky，分母为零时不适用；不把重试算作新用例，不把 expected-failure 或未到达关键断言的原生 passed 当业务通过。

读取返回的 results_ref、reconciliation_ref 与原始报告/步骤。对每个非 passed 实例生成 finding，分别填写事实、候选解释、支持证据、替代解释及下一验证动作；分类为 product/script/data/environment/flaky/insufficient-evidence，结论等级为 confirmed/supported/unknown。原生失败只能证明观察与预期不符；没有服务端依据时，不从超时或 500 推断数据库、网络或具体代码根因。unknown 仍可交付真实完整的失败报告。

需要引用 trace 内部动作、返回值或清理事件时，先调用 `ui_result_analysis` 的 `read-trace`，传 results_ref 和当前实例 attempt 的原始 trace_ref。工具复用 Playwright 1.62.1 的 ZIP 库，校验归属和摘要，只读 *.trace 的 before/after/log/event/console 原始事件；不包含快照、网络和资源正文，不证明服务端根因。supporting_refs 引用原始 trace_ref，评估者会从同一归档重新读取事件。不要用 shell 生成的摘录或仅凭 zip 存在声称看过内容；超预算/损坏时保留缺口，不伪造清理成功。

以 save-analysis 操作登记 analysis 产物。supporting_refs 仅接受当前 run 的证据与该资产的原始来源；不能混入其他批次截图。数据残留、跳过、取消、未执行、预期失败和首败后成功均须说明。报告只链接有权查看的证据，不把凭据写入分析。引用存在不代表语义已证实，后续 reviewer 仍须核验解释。

用 draft-report 操作传 results_ref、analysis_ref、report_id。程序生成范围、版本、统计、分析及限制；不能自行改数字、删失败或宣告全产品质量。再调用 ui-result-review 完成独立评估。证据缺失时重新解析为新结果 ID，生成明确 partial 的阶段报告；不覆盖原始 run 或旧结果。

处理分流：产品问题仅形成有依据的缺陷草稿；脚本问题新建修订回到设计评估；环境/数据恢复后新批次执行；证据不足先定向补证据。建议动作不表示已经修复、已经回归或已向外部系统提交缺陷。

已有工作流优先调用 `analyze-task`（task_id，可选 findings），程序从该任务唯一的已结束 run 取得引用，执行结果对账及确定性交接；不复制聊天里的 run_ref/task_ref。view、取消/阻塞任务和中断/未知 run 不进入此入口。execute 已结束时先交接执行；analyze 模式只分析选定旧 run。成功批次自动保存空 findings 的分析及完整报告候选，返回简洁 summary；完整报告仍须独立结果评审，不把候选交接当最终批准。

存在非 passed 实例时先返回 groups，保持 analyze 阶段；分组仅依据终态、证据状态及全部 attempt 的原始错误签名，不证明相同根因。逐个检查实例的 attempts、证据、cleanup 与缺口，提交每个实例的 findings 后再次调用同一 analyze-task；checkAnalysis 仍拒绝遗漏或跨实例附件。首败后通过仍为 flaky，取消/缺证据/数据残留均保留。重复调用返回原候选，不生成新批次；不同结论须显式新修订，不覆盖原分析。工具输出携带 workflow 当前状态，必要时用 ui_test_workflow status 按任务ID刷新既有看板。旧 parse/read-trace/save-analysis/draft-report 路径继续支持。
