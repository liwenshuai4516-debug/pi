---
name: ui-result-review
description: 对 UI 统计、失败归因和报告调用独立只读 Agent，核验 R1–R6 并登记报告批准，或交付明确标识的阶段报告。不执行测试、不修改原生结果。
---

调用 `ui_result_review` 的 review 操作，传 report_ref、request_id。工具启动新的无工具 Agent，不传分析者的聊天历史；输入包括冻结计划、原生报告、进程结果、源材料、确定性对账与报告候选。评估正文唯一维护在 [rules.md](references/rules.md)。

退回后按问题修正分析或重新解析，保存新的报告候选再评估；同一次请求查询沿用旧 ID，不换 ID 重放失败调用。每批次最多三次结果评估，异常也消耗预算，无改善可更早阻塞。原始输入、模型响应、引文及每轮问题保留；无效引文、缺规则、静态阻断或口头 approved 都不能授予完整报告批准。

用 deliver 操作交付 report_ref 和获批 review_ref。完整报告必须匹配私有批准、当前规则和全部证据；根因 unknown 本身不阻止一个真实完整的失败报告获批。证据不足时，仅可不带 review_ref 交付 completeness=partial 的阶段报告，明确“完整性未通过、未获完整批准”，不伪装最终报告。修订不覆盖原统计、原生文件或历史失败，不自动创建外部缺陷。
