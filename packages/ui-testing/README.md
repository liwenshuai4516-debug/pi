# Pi UI 测试能力包

当前版本 0.1.0，已实现 UI-02 的产物契约与 UI-03 的本地持久化入口。录制/执行兼容性已由 UI-01 验证，完整业务工作流仍按[实施计划](../../docs/UI测试能力实施计划书.md)推进；本包还不能正式审批资产或执行测试。

## 使用

在客户端根目录运行 `npm run build`。通过现有「扩展能力 → Packages」添加本目录，或添加构建产物 `dist/packages/ui-testing/`，再新建对话。该操作复用 Pi 包管理器；构建不会改写用户包配置。

已实现的工具 `ui_validate_artifact` 校验传入 JSON 的版本、必需字段、case/step/assertion/source 映射和评估状态。Skill `/skill:ui-artifact-check` 描述使用边界，按需加载。工具不读写文件、不运行浏览器，也不提供语义批准。

```sh
node packages/ui-testing/dist/cli.js capabilities
node packages/ui-testing/dist/cli.js schema cases
node packages/ui-testing/dist/cli.js schema capability-result
node packages/ui-testing/dist/cli.js validate packages/ui-testing/examples/scope.valid.json
node packages/ui-testing/dist/cli.js validate packages/ui-testing/examples/scope.invalid.json
```

最后一条应返回 blocked 和非零退出码。`validate <file> [project-root]` 除结构检查外，还核对引用文件的真实路径与 sha256；默认项目根目录为当前目录。

## 契约

产物统一包含 `schema_version: 1.0`、稳定 id、kind、created_at 和类型专属 data。完整结构以 `src/contracts.ts` 和 CLI 输出为准，避免另维护一份手写 schema。类型包括范围、功能清单、录制、用例、资产修订、两个评估、任务、执行批次、统计、分析和报告。

文件引用只包含项目相对 `path` 与 `sha256`；不保存聊天全文、临时页面句柄、个人绝对路径或秘密值。未知 schema 版本明确拒绝，当前仅声明支持 1.0。断言预期分 requirement/declaration/baseline，必须对应来源和步骤。设计/结果评估批准必须覆盖 D1–D10 / R1–R6 且无阻断项；结构校验不会证明所填证据真实，仍须独立评估与正式登记门禁。

能力输出单独表达 completed/blocked/failed/cancelled、产物引用、错误类别和恢复提示；能力 completed 不等于业务用例通过。错误类别固定为输入无效、版本不兼容、能力缺失、前置失败、评估拒绝、执行器异常、证据不足、取消。

## 复用与验证

Pi SDK 1.2.0 提供资源发现、包安装和工具注册；TypeBox 提供统一 schema 与 TypeScript 类型；Ajv 8.17.1（MIT）执行 schema 校验。不开发格式解析框架、新 MCP 服务或组件界面，仅补项目特有的关联与状态检查。

检查方式：客户端根目录 `npm run check`；`npm test` 包含契约正反例、文件缺失/摘要变化/符号链接越界，以及源码包和随应用构建包的真实 Pi 安装与调用测试。该验证不等同于真实业务系统测试。

## 本地持久化（UI-03）

文件保存在被测项目的 `qa/ui/`。资产使用 `assets/<id>/revisions/<revision>/manifest.json`，其他对象使用各自分类目录；设计评估挂在资产修订下，执行产物挂在对应批次下。`manifest.json` 是完成标记，`.incomplete.json` 单独存在时为半成品；`catalog.json` 只是可重建索引。损坏对象保留在原处，索引列出路径和原因，不自动删除或重录。

```sh
# project-root 是已存在的被测项目目录；此示例仅登记测试范围，不执行浏览器。
node packages/ui-testing/dist/cli.js store-put packages/ui-testing/examples/scope.valid.json /path/to/project
node packages/ui-testing/dist/cli.js store-index /path/to/project
# 将 store-put 返回的 path/sha256 保存为 ref.json 后，可由新进程读取。
node packages/ui-testing/dist/cli.js store-load /path/to/ref.json /path/to/project
```

代码入口为 `ArtifactStore`：`putFile` 写不可变附件，`put` 登记完成产物，`load` 验证版本与直接依赖摘要，`reindex` 重建索引。`assetDigest` 将脚本、共享 fixture、来源引用和依赖版本纳入内容摘要。业务使用者必须将实际依赖文件全部列入 files；未声明的依赖不在校验覆盖内。

`updateTask(expectedRef, next)` 使用摘要比较后更新，冻结意图、输入、资产与已登记批次，不允许阶段回退。`reserveRun` 先登记启动意图，同一 request_id 和相同输入返回原批次；输入不同或存在未核对批次则阻塞。`markRunStarted` 登记 PID 与进程令牌，`finishRun` 保留退出码和输出引用。中断批次保留活跃登记，UI-11 前不自动续跑。上述 API 只管理状态，不启动进程，也不证明设计已获批；正式执行门禁由 UI-06/UI-07 实现。

复用 `proper-lockfile` 4.1.2（MIT）协调单项目元数据写入，使用文件同步和原子替换提交 manifest；不建设数据库或另一套会话存储。面向项目本地文件系统，不宣称支持网络文件系统或操作系统断电恢复。`tests/ui-testing/store.test.mjs` 覆盖独立进程读取、索引损坏重建、半成品、摘要失效、并发启动和任务版本冲突。
