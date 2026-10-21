# 被测项目准备

先明确：项目根目录、任务模式、目标站点与部署版本、模块/角色、允许动作、需求来源、已有测试/资产、数据准备及清理方式。只分析旧批次时只需原 run 及其证据，不索要新录制环境。

## 环境和 Playwright

复制并修改 [environment.json](../assets/runtime/examples/environment.json)。其中 `auth.reference` 是环境变量名，变量值才是私有 storageState 文件路径；匿名测试改为 `{"kind":"none"}`。身份探针应能区分实际角色/登录状态，不能仅使用所有人都能看见的标题冒充认证验证。部署版本来自调用方，需要另有证据才能证明远端部署与源码一致。

已有配置优先复用。新建配置的最小形态：

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  workers: 1,
  retries: 0,
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

正式 runner 会生成批次配置及证据；项目配置、环境、helper、共享 fixture 和本地 tsconfig extends 都要纳入候选引用，不能获批后偷偷替换。需要指定独立编译配置时使用资产的 compiler_config_ref。

## Seed 与数据归属

浏览器录制的 generator_setup_page 会真实运行 seed。seed 应使用 `pi-ui-testing/fixtures` 导出的 `test/expect`，配置 uiEnvironment、uiProjectRoot 和 uiOwner。录制使用 `{task_id,kind:'recording',id:recordingId}`；正式 runner 提供本 run 的归属。复用团队已有准备/清理方法；本包不提供通用业务数据库初始化器或登录器。

用 `uiData.prepare` 声明 creation_method、fixture_version、ttl_ms、cleanup_method，以及 create 与 cleanup 回调；回调只处理该次生成的 businessKey，服务端返回 ID 时用 identify 登记。不具备可靠清理方式时填写 retain_reason，报告残留。Playwright context 只能隔离浏览器状态，不能隔离服务端共享账号。

共享环境使用 isolation=shared、workers=1、无分片；锁只覆盖同一被测项目，跨项目共享账号需要团队既有调度。强杀进程不保证 teardown 已完成，不能将“进程已退出”当作“业务未写入”。

seed 和候选必须使用本次数据、稳定语义定位器，不能沿用录制中的固定数据 ID 或临时 target/ref。以下最小 seed 仅适用于初态本来就存在、无额外业务数据的页面；其他项目必须补真实准备/清理：

```ts
import { readFileSync } from 'node:fs';
import { test } from 'pi-ui-testing/fixtures';

const environment = JSON.parse(readFileSync('tests/ui/environment.json', 'utf8'));
test.use({
  uiEnvironment: environment,
  uiProjectRoot: process.cwd(),
  uiOwner: { task_id: 'prepare-001', kind: 'recording', id: 'recording-001' },
});
test('seed', async ({ page }) => {
  await page.goto(environment.base_url);
});
```

每次新录制替换 task/recording ID 并冻结 seed 摘要；这个 seed 不是业务测试通过证据。先登记 scope、初始 inventory、初态与数据规则，再按 [录制启动说明](../assets/runtime/skills/ui-discover-record/references/start.md) 绑定引用。只有源码时使用 discovery=source，不伪造 recording。

## 断言和诊断

每个 case 绑定唯一脚本标题，每条断言有稳定 assertion_id 和 `test.step('assertion_id 描述', ...)`。comparison 必须与实际 matcher 语义一致；需求要求原样文本时，核对 matcher 是否会归一化空白，不能仅因方法名像“相等”就认为严格匹配。

设计评估前保存 diagnostic-spec，并把环境/config/变异来源纳入候选。每条断言至少有一个合理错误结果探针；正负目标隔离，负例不通过修改断言制造失败。有缺陷的目标可使用独立正常副本做正对照，不能要求产品先变绿才承认脚本可执行。没有合理错误副本时保留“设计批准、运行未就绪”，不伪造诊断。

契约直接查询安装包，不维护平行 schema：

```sh
node node_modules/pi-ui-testing/dist/cli.js schema scope
node node_modules/pi-ui-testing/dist/cli.js schema cases
node node_modules/pi-ui-testing/dist/cli.js schema diagnostic-spec
node node_modules/pi-ui-testing/dist/cli.js store-put ./scope.json "$PWD"
```

本次命令的输出 FileRef 才是后续输入；附件使用 ArtifactStore.putFile 保存并绑定真实 sha256。无来源值保持 gap，不能为完成 schema 填造事实。
