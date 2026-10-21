---
name: ui-case-design
description: 从已登记的 UI 功能清单、需求/声明/基线及录制证据生成带来源的 case、断言和 Playwright 候选修订，做静态检查；不批准设计或正式执行。
---

先读取 scope、inventory、相关录制和真实来源，复用项目已有 fixture/定位器/断言。不要把录制看到的值自动当作正确预期：requirement 是已确认需求，declaration 是代码/HTML 明确声明，baseline 是明确标记的当前行为。未知规则留 gap，不补造业务限制。

使用 `ui_case_design`：save-cases 登记完整 cases 产物；save-file 保存当前 asset_id/revision 内不可变脚本/fixture/config 并返回 FileRef；candidate 登记 asset 并运行 TypeScript 静态检查。操作字段放入 request；schema cases/asset 可由包 CLI 查询。asset.content_sha256 可传 64 个零作为占位，candidate 会根据实际引用重算，不信任生成者摘要。

每个 case 恰好对应一个 binding：case_id、script_ref、test_title、assertion_ids。脚本用静态 test 标题对应 test_title，每条断言使用唯一 `test.step('assertion_id 描述', async () => { await expect(...)... })`。断言必须验证独立预期下的具体业务对象和时机，不能是常量、实际值与预期同源或只验证点击/提示成功。

把 inventory_ref、cases_ref、录制引用、脚本、本地 helper/fixture、配置和数据规则纳入资产依赖；依赖包锁定实际版本。保留选定主链及未探索范围，不能靠删 case 或断言通过检查。源码-only 使用 readiness=design-only，未核验定位器保留缺口。runtime-verified 不能自填为执行授权，仍需要受控运行证据。

项目有 TypeScript 配置时，将实际使用的配置及本地 extends 一并纳入 files；可用 compiler_config_ref 指定独立的测试编译配置，诊断 runner 同步使用它。继承包配置时锁定对应包版本。需要运行验证时，在设计评估前保存符合 `schema diagnostic-spec` 的正反对照计划、环境/config 与变异来源；复用已有受控响应或测试副本，不改业务服务或断言预期来制造“检错成功”。

收到静态阻断先修订，使用新 case ID 或资产 revision，不覆盖旧文件。结构/编译通过后交给 `/skill:ui-design-review`；独立评估退回后依据明确问题修订并重评。最多三轮、无改善或缺事实时停止，不能更换任务 ID 来规避同一次工作流预算。未批准候选不得作为正式执行输入。
