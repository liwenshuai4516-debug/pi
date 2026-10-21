# 工具与产物索引

这是操作导航，不替代工具注册时提供的真实参数 schema。除特别注明外使用 `{request:{operation,...}}`。

| 工具 | 操作 / 参数 | 用途 |
|---|---|---|
| ui_validate_artifact | `{artifact}`，无 request 包装 | 纯结构校验，不验证文件或授予批准 |
| ui_discover_record | inventory / start / action / status / finish | 源码发现、受预算控制的真实 MCP 录制 |
| ui_case_design | save-cases / save-file / candidate / check | 不可变候选、映射和 TypeScript 检查 |
| ui_design_review | `{task_ref,asset_ref,request_id}`，无 request 包装 | 独立 D1–D10 评估、私有设计批准 |
| ui_design_diagnose | schema / diagnose / status | 正反对照与可信 runtime_ready 登记 |
| ui_test_run | start / status / plan-recovery | 正式批次和父批次选择 |
| ui_result_analysis | parse / read-trace / save-analysis / draft-report | 确定性对账、原始证据和报告候选 |
| ui_result_review | review / deliver | 独立 R1–R6 评估、完整或 partial 交付 |
| ui_test_workflow | catalog / start / status / checkpoint / block / resume-task | 按需阶段、磁盘恢复和交接 |
| ui_asset_maintain | impact / inspect-import / export / import / audit-evidence | 已有脚本映射、依赖影响、迁移和证据审计 |

已安装包 CLI 支持：capabilities、schema、validate、store-put、store-load、store-index。**没有** CLI run/review/record/install 子命令；正式操作通过扩展或对应库服务，不能编造 CLI 调用。

```sh
node node_modules/pi-ui-testing/dist/cli.js capabilities
node node_modules/pi-ui-testing/dist/cli.js schema workflow-start
node node_modules/pi-ui-testing/dist/cli.js schema run-request
node node_modules/pi-ui-testing/dist/cli.js validate ./artifact.json "$PWD"
node node_modules/pi-ui-testing/dist/cli.js store-index "$PWD"
node node_modules/pi-ui-testing/dist/cli.js store-load ./ref.json "$PWD"
```

CLI capabilities 是静态能力描述；宿主真实工具是否已注册、MCP 是否已连接仍须单独检查。validate 还核验文件存在、边界及摘要，但不证明语义正确。

所有业务产物位于被测项目 `qa/ui/`，schema_version 为 1.0。包含 scope、inventory、recording、cases、asset、design-review、task、run、results、analysis、result-review、report。引用统一 `{path:项目相对路径,sha256:真实摘要}`。相对路径绑定被测项目，不绑定 Skill 安装位置。

资产保存于 `assets/<id>/revisions/<revision>/manifest.json`，执行产物归属对应 run。manifest 是完成标记；只有 .incomplete.json 时仍是半成品。catalog.json 可重建，不是批准来源。旧文件损坏保留原因，不自动删掉或重录掩盖问题。

脚本/来源/fixture/helper/config/依赖版本均纳入内容摘要；漏登记的依赖不在影响分析覆盖内。修改产生新 revision；task_ref 变化后先重读，不用旧摘要覆盖。源码见 [store.ts](../assets/runtime/src/store.ts)、[contracts.ts](../assets/runtime/src/contracts.ts)。

统计按冻结实例和原生报告逐个对账：稳定通过率为 passed/(passed+failed+flaky)，分母为零不适用；attempt 不是新 case。原生 passed 但未达关键断言或 expected-failure 不算稳定业务通过。所有未执行、取消、跳过和未知状态单列。设计 approved、runtime_ready、执行 completed、产品通过、完整报告获批不可互换。

trace 内容须用 read-trace 读取归属当前 results/attempt 的原始归档；reviewer 从同一原归档重算。当前仅提取 *.trace 的 before/after/log/event/console，不读快照、网络或资源正文，不证明服务端根因。查看二进制文件存在不等于看过其内容。
