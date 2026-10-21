# Pi UI 测试能力包

当前版本 0.1.0，提供产物契约、本地持久化、环境/数据 fixture、发现与自动录制、独立设计评估与诊断，以及正式执行入口。完整业务工作流仍按[实施计划](../../docs/UI测试能力实施计划书.md)推进；统计、失败归因、结果评估与按需总流程尚待后续任务。

UI-06 已接入候选静态检查、独立设计评估与受控诊断登记，具体验收状态以实施计划为准。运行就绪不等于产品通过，也不替代后续正式执行的当前环境预检。

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

## 环境与数据 fixture（UI-04）

[环境模板](examples/environment.json) 声明站点、角色、身份探针和初始状态。`auth.reference` 是环境变量名称；变量值指向私有 Playwright storageState 文件，文件内容不纳入资产。匿名环境使用 `{"kind":"none"}`。认证文件由既有登录流程生成，本包不自建登录器；每次执行仍从页面验证身份，文件可解析不等于登录有效。部署版本由调用方提供，当前 fixture 不据此声称已验证服务端部署版本。

被测项目将本包作为本地开发依赖安装后，从 `pi-ui-testing/fixtures` 导入 `test/expect`（也可使用包中 `dist/fixtures.js` 的实际路径）；Playwright 使用锁定的 `@playwright/test` 1.62.1。Pi 包安装负责 Agent 资源，不自动改变被测项目的 npm 依赖或 Playwright 配置。

```ts
import { test, expect } from 'pi-ui-testing/fixtures';
import environment from './environment.json' with { type: 'json' };

test.use({ uiEnvironment: environment, uiProjectRoot: process.cwd(),
  uiOwner: { task_id: 'task-1', kind: 'run', id: 'run-1' } });

test('保存名称', async ({ page, uiData }) => {
  const row = await uiData.prepare({
    creation_method: 'ui', fixture_version: '1', ttl_ms: 3600000,
    cleanup_method: 'owned-localStorage-key',
    create: async key => {
      await page.getByRole('textbox', { name: 'Name' }).fill(key);
      await page.getByRole('button', { name: 'Save' }).click();
      return key;
    },
    cleanup: async key => {
      await page.evaluate(key => {
        const rows = JSON.parse(localStorage.getItem('names') || '[]');
        localStorage.setItem('names', JSON.stringify(rows.filter(value => value !== key)));
      }, key);
    },
  });
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveText(row.business_key);
});
```

以上示例用于模板页面，实际测试应复用项目自己的准备/清理 fixture。服务端返回独立对象 ID 时用 `identify(value)` 登记非敏感 ID，清理回调仍须以已登记业务键确认归属。没有安全删除方法时声明 `retain_reason`，保留残留；不扫描或删除其他数据。数据创建失败同样保留 preparing/prepare-failed 记录并尝试清理。过期时间只用于提示，不触发自动删除。

Playwright 原生 context 隔离浏览器状态；命名空间区分每次尝试的数据，但不能自动隔离服务端共享账号。不能隔离时设 `isolation: shared`，运行配置使用 `workers: 1` 且不分片，fixture 还获取同一项目下的环境资源锁；不同被测项目之间须复用团队已有资源调度，不宣称跨项目锁定。

前置失败输出 `ui-preflight` 附件，类别为 precondition，业务主体不执行；UI-07/UI-08 负责将此失败与业务断言失败区分统计。数据事件持久化到对应 run/recording 的 `data/`，teardown 输出 `ui-data-lifecycle` 附件，清理失败保留原因码和残留，业务通过/失败不被覆盖。受控取消、断言失败和超时使用 Playwright teardown；强制杀死进程不保证清理完成，未完成记录留待核对。原始截图、trace 和业务回调错误可能含敏感信息，应按项目证据规则控制访问和脱敏，不能因普通生命周期记录无凭据就声称所有证据均无秘密。

`tests/ui-testing/environment.test.mjs` 使用真实 Chromium、真实 Playwright runner 验证独立上下文、业务失败/清理失败、取消、有效及失效认证状态；数据归属、保留与锁使用额外确定性检查。

## 模块发现与自动录制（UI-05）

Skill `/skill:ui-discover-record` 使用新工具 `ui_discover_record`。工具参数为 `{request: {operation, ...操作字段}}`，操作包括：

| 操作 | 作用 |
|---|---|
| inventory | 登记模块/功能/场景、角色、入口、覆盖状态和来源；可附 drafts（name/content），生成不可变 draft_refs |
| start | 绑定 scope/inventory、初始状态和数据规则、seed 摘要、后端/浏览器项目、唯一输出文件和预算，返回 session_ref |
| action | 每次通过 Pi 的公开 `executeTool` 调用一个实际 MCP 工具，先写请求再写结果，返回 observation_ref |
| status | 从文件读取动作与停止原因，不启动或恢复浏览器 |
| finish | 保存原始日志、参数化草稿和完整/局部 recording；不批准设计或正式执行 |

Agent 复用已有读取/检索工具进行源码分析，按业务模块和功能归类，不建设新的框架解析器。只有源码时保存 discovery=source、coverage=discovered 和未核验缺口，可生成带来源的脚本草稿；不会启动浏览器或声称定位器/部署已验证。浏览器清单的 source_refs 使用真实 observation_ref，范围限于当前角色可见状态。单个模块优先，不自动遍历所有提交、删除或通知动作。

首期单一后端为已验证的 Playwright 测试 MCP。start 冻结真实工具前缀、seed/project 和全新草稿路径；setup 实际执行 seed，因此应复用 UI-04 或团队既有前置/数据生命周期 fixture。action 直接使用原工具参数，包含工具本身要求的 intent；`browser_close` 也要求 intent。模型可使用当前 target/ref 交互，但持久脚本须使用语义定位器。

同一 operation_id 和同样参数返回原结果；参数改变会阻塞。已写请求但没有结果、工具失败或取消时停止新业务动作，保留未知副作用，禁止盲目重放。步数、时长及连续相同快照均受限；超时向现有工具传递取消信号，未确认的外部动作仍记 unknown，不声称已撤销。`browser_close` 可以在停止后作为清理动作调用并留证。当前会话录制期间直接 MCP 调用被阻止，应通过 action 进入记录路径；该约束不等同于隔离任意第三方扩展或强制限制外部进程。

browser_type 只接受预先声明的公开合成 test_data，或当前 recording 的 UI-04 ready 记录中已登记业务键；认证使用私有 storageState。finish 关联实际数据生命周期事件及清理结果。原始请求、快照和日志作为受控测试证据保存，仍需遵循脱敏规则。新 Agent 可读取历史 status，但 action 只接受本 Agent 启动的会话，避免重启后盲目续点。源码/规则变化会导致引用摘要检查拒绝继续；保留旧证据，待核对后创建新录制，不自动从点击中间恢复。

完成检查包含可重建初始状态、可替换数据、稳定定位、有来源断言、清理归属；缺项、未知结果、已登记数据仍待清理/清理失败，或草稿含临时 ref/固定输入/个人路径均保存 partial。此阶段的脚本检查仅用于交接，不代替 UI-06 的编译、独立设计评估与断言自检。草稿回放是隔离的设计验证，不计入正式通过数。

`tests/ui-testing/recording.test.mjs` 覆盖预算、重复操作/中断、固定输入及临时路径检查，并以受控协议模型驱动真实 Pi、原生 MCP 和 Chromium，验证自动交互、真实来源、seed teardown、重读持久化和参数化草稿回放；另验证源码读取/草稿保存全程无浏览器动作。模型在任意真实项目中的规划质量仍待 UI-10 验收。

## 候选、独立设计评估与诊断（UI-06）

按需加载 `ui-case-design` 和 `ui-design-review` Skills。`ui_case_design` 的参数为 `{request: {operation, ...}}`，支持 save-cases、save-file、candidate、check；candidate 会重新计算资产摘要并检查真实依赖。每个 case 绑定静态测试标题，每条 assertion_id 绑定唯一 `test.step`。脚本、共享 helper/fixture、配置和来源必须纳入不可变修订；复用 TypeScript 5.9.3 compiler API 检查语法、类型和本地模块依赖，不另造解析器。

`ui_design_review` 接收 task_ref、asset_ref、request_id。实际创建独立 Pi Agent，使用当前模型和原生认证，工具为空且不接收生成者对话；从真实文件读取原始来源、候选、规则和上一轮评估。规则正文唯一维护在 `skills/ui-design-review/references/rules.md`。模型输出逐项 D1–D10 的理由和引文，校验器核对引文、范围、结构与确定性阻断，保留完整输入及原始响应。

评估最多三次，异常也消耗调用预算；相同请求去重，未知调用结果不自动重试。退回后保存新修订再评估，无改善或缺事实时保持未批准。批准登记和预算位于 Pi 会话目录下私有 `ui-review-authority/`；业务评估仍保存在被测项目 `qa/ui/`。换工作区或迁移时，仅复制项目里的 approved JSON 不能取得执行授权；私有登记丢失时需要重新评估。

库入口 `DesignReviewService.gate(assetRef, reviewRef, false)` 验证设计批准、规则版本、真实文件与依赖。默认 gate 还要求可信运行证明：设计批准和自填 readiness 字段均不能代替诊断登记。编译配置及本地 extends 纳入 files；可用 compiler_config_ref 指定独立测试编译配置，runner 同步使用。继承包配置须锁定包版本。

诊断内部库入口 `runDesignDiagnostics(root, assetRef, reviewRef, specRef, signal?)` 复用被测项目安装的 Playwright CLI、config、JSON reporter 和 trace。`diagnosticSpecSchema` 声明正对照环境/config 及错误应用副本的环境/config、变异来源、目标 assertion_ids；这些文件都须进入获批候选的 files，错误副本使用不同 origin，角色保持一致。environment_ref 必须匹配 scope；未指定 control_environment_ref 时也作为默认正对照，需要正常副本时可用该可选字段覆盖。当前目标仍单独预检，不能要求有缺陷的产品先通过测试。每个环境先核验站点、身份和初态，再启动全新 runner context。认证继续使用私有环境变量引用，不把 storageState 路径写入生成配置。

诊断不改候选脚本和预期值，不重试业务操作。它逐 case 对账原生报告：正对照的映射断言步骤全部通过；错误副本的指定 expect 步骤实际失败；启动/导航失败、超时、预期失败、重试、非目标失败和未确认清理的残留均不能冒充检错证明；明确约定保留的数据仍如实留证。配置、输入、报告、退出码和附件摘要位于修订下 `diagnostics/<id>/`，显式标记 `formal_run:false`；脚本/输入中途变化会保留证据并阻断。

`ui_design_diagnose` 通过 `{request:{operation:"diagnose",asset_ref,review_ref,spec_ref,request_id}}` 调用 `RuntimeAdmissionService.diagnose`；先验证可信设计批准，再保存请求状态、运行原生诊断并登记私有运行证明。相同请求返回原结果；输入变化、并发调用和未知执行阻断。`operation:"status"` 只读旧请求，重启后不重放浏览器。直接调用底层库得到 `validated` 或自行写项目 JSON 都不能取得可信登记。

未知诊断仅阻断模块集合有交集的资产，原范围及记录保留；旧请求没有模块信息时保守阻断。首期浏览器诊断仍串行，不表示已实现并发调度。独立 reviewer 默认关闭思考，单次调用限时 120 秒；取消、超时和无效响应不授予批准，并保留输入/响应引用。

运行登记与请求状态保存在 `ui-review-authority/runtime/`，绑定候选、设计评估、诊断摘要、所有证据和实际诊断实现摘要。重新诊断先使旧证明失效，取消或结果不明时保留 unknown，禁止换 ID 重放；后续中断核对由 UI-11 实现。依赖、规则或证据变化会使 gate 拒绝旧证明；私有登记丢失时需重新评估/诊断。错误副本来源与部署版本由项目提供并接受独立设计审查，当前实现不能自动证明任意远端部署与源码一致。运行登记只证明受控脚本设计验证，正式执行仍须新预检、新数据、新 context 和新批次。

`npm test` 验证确定性边界、真实 Pi 工具和原生浏览器；受控模型验证接线，不替代语义质量。可单独运行 `PI_UI_DESIGN_LIVE=1 node --test --test-name-pattern="UI-06 live" tests/ui-testing/design.test.mjs` 验证配置中的真实模型；原始意见与来源保存在 `evidence/ui-testing/ui-06/`。UI-10 仍须完成重复样本校准，单次冒烟不代表零幻觉。

## 正式执行与原始证据（UI-07）

Skill `/skill:ui-test-run` 调用 `ui_test_run`，首期单 chromium 项目、单 worker、无自动业务重试。原生 Playwright Test 负责 context、断言、fixture、报告和 trace，不另建执行引擎。

- 启动：`{request:{operation:"start",input:{task_id,request_id,asset_ref,review_ref,environment_ref,config_ref,timeout_ms}}}`，完整结构见 CLI `schema run-request`。
- 查询：`{request:{operation:"status",task_id,request_id}}`，只读取旧批次；同次 start 的相同输入也只返回原结果。
- task 是同范围的独立执行任务，intent 为 execute 或 rerun-all，asset_refs 已冻结选定资产。config_ref 必须属于获批修订；当前环境文件可独立更新，但必须匹配范围、角色和地址，并重新核验身份与初态。

`UiRunService.start/status` 先验证可信设计批准及诊断证明，再冻结 case × 数据行 × 浏览器实例，登记 pending 批次和启动意图后调用原生 CLI。每次新请求产生新批次，使用新 context；同任务并发拒绝。预检后与执行结束时再次校验输入和门禁，变化或缺证据保留问题，不能沿用旧批准输出完整通过。

产物在 `qa/ui/runs/<run-id>/`：`input.json`、原生配置、preflight、launch-intent、PID/令牌观察、process、原生 report、attempts、执行摘要和 output 中的截图/trace。run manifest 保存冻结计划、原始命令、退出码和证据引用；attempt 关联 run/case/instance、原生状态、断言步骤及附件摘要。原生报告包含未映射实例或全局错误时如实保留，不补造结果。

执行摘要的 completed 仅表示执行与收集完成，exit_code=1 仍可能包含真实产品失败。身份失效和启动异常标记 blocked；取消、原生全局超时或结果不明保留中断及活跃登记，不自动换 ID 重放。查询不会自动清除阻断或重建浏览器；恢复核对留待 UI-11。统计、证据完整性及失败原因由 UI-08 对账和评估，未接入前仅交付原始结果及缺口。

库调用与 Agent 工具测试见 `tests/ui-testing/run.test.mjs`，包括正常/失败、两次新批次隔离、重启去重、身份失效、实际进程启动失败、原生全局超时、取消后阻断及真实 Pi Skill/工具调用。测试页面用于机制验收，不能作为外部业务系统已通过的证明。
