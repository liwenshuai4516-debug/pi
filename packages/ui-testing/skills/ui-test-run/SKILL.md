---
name: ui-test-run
description: 使用获批 UI 资产启动正式 Playwright 测试批次，保存原生结果和证据，或查询旧批次。用于执行已有测试；不生成或修改脚本，不以执行完成代替测试通过。
---

先读取选定资产、可信设计评估与诊断状态。没有运行就绪证明时先按 ui-design-review 完成诊断，不手写批准或跳过门禁。正式执行使用独立执行任务，intent=execute，scope_ref 与资产一致，asset_refs 冻结选定修订；通过既有产物存储入口登记 task，不覆盖已结束任务。

调用 `ui_test_run`，参数 `{request:{operation:"start",input:{task_id,request_id,asset_ref,review_ref,environment_ref,config_ref,timeout_ms}}}`。包 CLI `schema run-request` 提供完整结构。config_ref 必须属于获批修订；environment_ref 指向当前环境，角色/站点/身份及初态需匹配范围，认证使用私有环境变量引用。运行前会重新预检，不能使用录制末态作为初始状态。首期为单 chromium 项目、串行、零自动重试；Playwright 原生 fixture/context 负责每例隔离与归属数据清理。

一次新执行使用新的 request_id；查询或确认同一次启动使用原 ID。工具先登记冻结计划和启动意图，再启动原生 CLI；相同输入的同请求只读原批次，不重放浏览器。用 `{request:{operation:"status",task_id,request_id}}` 查询旧状态。取消、中断、未知或只有 pending 的旧批次先核对进程和业务数据，不换 ID 绕过阻断；完整恢复由后续能力提供。

读取返回的 run_ref、执行摘要、原生 report、attempt、截图/trace 和数据生命周期证据。`completed` 表示执行及证据收集完成；exit_code=1 可以是产品断言失败，不能报告为全部通过。报告缺失、实例遗漏、未知副作用或清理残留如实保留，统计与失败归因交给结果分析阶段；没有该能力时仅交付原始结果和未完成项。脚本修复必须新建资产修订并重新评估，不能在失败批次中改脚本或预期值使其变绿。
