---
name: ui-result-analysis
description: 从已有 UI 正式批次计算统计、按原始证据分析失败并生成报告候选。用于分析旧 run，不启动浏览器，不修改原始执行结果；候选须独立结果评估后交付。
---

调用 `ui_result_analysis` 的 parse 操作，传 run_ref、result_id。结果由冻结计划与原生 Playwright 报告逐实例对账，包含互斥终态、全部 attempt、证据缺口、功能/模块/优先级及 oracle 维度。稳定通过率分母为 passed+failed+flaky，分母为零时不适用；不把重试算作新用例，不把 expected-failure 或未到达关键断言的原生 passed 当业务通过。

读取返回的 results_ref、reconciliation_ref 与原始报告/步骤。对每个非 passed 实例生成 finding，分别填写事实、候选解释、支持证据、替代解释及下一验证动作；分类为 product/script/data/environment/flaky/insufficient-evidence，结论等级为 confirmed/supported/unknown。原生失败只能证明观察与预期不符；没有服务端依据时，不从超时或 500 推断数据库、网络或具体代码根因。unknown 仍可交付真实完整的失败报告。

以 save-analysis 操作登记 analysis 产物。supporting_refs 仅接受当前 run 的证据与该资产的原始来源；不能混入其他批次截图。数据残留、跳过、取消、未执行、预期失败和首败后成功均须说明。报告只链接有权查看的证据，不把凭据写入分析。引用存在不代表语义已证实，后续 reviewer 仍须核验解释。

用 draft-report 操作传 results_ref、analysis_ref、report_id。程序生成范围、版本、统计、分析及限制；不能自行改数字、删失败或宣告全产品质量。再调用 ui-result-review 完成独立评估。证据缺失时重新解析为新结果 ID，生成明确 partial 的阶段报告；不覆盖原始 run 或旧结果。

处理分流：产品问题仅形成有依据的缺陷草稿；脚本问题新建修订回到设计评估；环境/数据恢复后新批次执行；证据不足先定向补证据。建议动作不表示已经修复、已经回归或已向外部系统提交缺陷。
