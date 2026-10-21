# UI 测试续跑与维护验证

更新：2026-10-21。按 UI-10 → UI-11 → UI-12 顺序实施，复用 Pi 原有工具/阶段持久化、Playwright 原生 grep、Node 文件 API、Git 和现有摘要门禁，不增加调度平台或界面。

## UI-11 续跑与失败重跑

`recoveryPlan` 基于父 run 冻结计划和原生结果选择 case：resume 仅未启动；rerun-failed 仅 failed/flaky；rerun-all 重新选择同一获批资产全量，即使父批次只为子集。`UiRunService.start` 请求绑定 parent_run_ref，保存 selection.json、parent_run_id，并使用原生 grep 选择完整 case/业务链。从新 context/数据初态开始，不恢复临时浏览器对象。标题不能唯一筛选则拒绝。新报告保留父 ID 和原范围限制，不能将子集通过替代原全量失败，不合并部署版本。

`UiWorkflowService.resumeTask` 在校验既有产物与当前能力后继续原阶段，不回退 completed_stages、不清除预算、不复活终态。已执行后中断可继续 analyze；录制 partial 继续保留日志/业务归属，不能直接交接或盲目接着点击。未知写入/活跃父批次仍阻塞，缺证据或 PID 消失不能证明安全；没有通用服务端副作用查询能力时明确需要业务核对，不假称全自动恢复。

`tests/ui-testing/recovery.test.mjs` 三项真实 Chromium 专项通过：两个 case 中一个失败后只重跑失败项，子集新批次通过但父失败字节不变；随后全量选择两个 case 并实际通过；同请求只读旧批次。预检身份失败 business_started=false 后以新 context 重建整 case；未知写入不启动浏览器。工作流中断后继续原分析阶段，并核对源 run 引用不变。正式执行与工作流已有 13 项专项同时通过，包含真实保存后中断不重放、旧批次分析不启动浏览器及录制 partial 门禁。

类型检查与构建通过；两个修改 Skill 的 quick_validate 通过。全量回归 103 项通过、6 项外部模型专项默认跳过；新增工作流 rerun-failed 的 start/execute checkpoint 同时通过。
