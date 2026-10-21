# 安装与 Pi SDK 接入

适用：另一个使用 Pi Agent SDK 的项目。运行包与业务测试项目可以在同一仓库，也可以由宿主管理多个被测项目；`ctx.cwd` 必须是当前被测项目。无需复制原 Electron 主进程、preload、renderer 或用户配置目录。

## 包的内容

- `../SKILL.md`：统一工作流入口。
- `../assets/runtime/`：原能力包的编译文件、TypeScript 源码、8 个阶段 Skills、评估规则、环境与契约示例；保留源码供宿主集成定位。
- `../assets/pi-ui-testing-0.1.0.tgz`：可直接 npm 安装的同版包。不要只复制编译文件而遗漏 skills，reviewer 会读取其规则正文。
- `../scripts/doctor.mjs`：无第三方依赖的安装检查入口，不安装依赖、不修改 Agent 配置、不调用模型或业务站点。
- `../bundle-manifest.json`：打包来源版本与文件摘要。打包不包含 node_modules、账号认证、历史会话、业务证据或私有批准。

## 依赖与版本

| 项目 | 要求 | 安装位置 / 用途 |
|---|---|---|
| Node.js | >=22.19.0，使用当前受支持的 LTS | Pi SDK 的最低要求；本次打包实际版本记录在 manifest |
| npm | 可安装本地 tgz 的版本 | 安装并生成项目 lockfile |
| `@earendil-works/pi-coding-agent`、`pi-agent-core` | 1.2.0 | 宿主扩展/模型注册/独立 Agent；作为 peer 依赖 |
| 同组织的 pi-ai、pi-mcp、pi-codemode、pi-telemetry、pi-tui | 1.2.0 | 与原验证一致；显式安装防止 SDK 的范围依赖解析到另一版 |
| `typebox` | 1.3.27 | 已验证 schema 版本，打包时收紧原包的 `*` peer |
| `@playwright/test`、`playwright` | 1.62.1 | 被测项目的 runner、fixture、测试 MCP、trace |
| Chromium | 由上述 Playwright 下载的对应修订 | 浏览器执行；不能只安装 npm 包 |
| Ajv / proper-lockfile / TypeScript | 8.17.1 / 4.1.2 / 5.9.3 | 运行包自动安装；契约、锁、静态检查 |
| Pi 原生 MCP | Pi 1.2.0 的内置能力 | 录制时必需；无需第三方 MCP 适配插件 |
| Git | 可选，支持 diff | 只有 impact 的 git_ref 模式使用 |
| 模型服务和认证 | 宿主当前可用的选中模型 | 两次独立评估；新项目重新配置，不随包传递 |

上述为已验证的直接版本，不代表所有传递依赖已冻结。安装后保留目标项目的 package-lock.json，后续用 npm ci；已有版本冲突时先解决冲突，不使用 `--force` 或 `--legacy-peer-deps` 跳过。工具会拒绝未验证 Pi/Playwright 版本。

## 安装命令

以下命令在**被测项目根目录**执行；替换 `UI_SKILL_DIR`。已有 package.json 时保留，只在新空项目先 `npm init -y`。

```sh
UI_SKILL_DIR='/absolute/path/to/ui-testing-workflow'
npm install --save-dev --save-exact "$UI_SKILL_DIR/assets/pi-ui-testing-0.1.0.tgz" \
  @earendil-works/pi-coding-agent@1.2.0 @earendil-works/pi-agent-core@1.2.0 \
  @earendil-works/pi-ai@1.2.0 @earendil-works/pi-mcp@1.2.0 \
  @earendil-works/pi-codemode@1.2.0 @earendil-works/pi-telemetry@1.2.0 @earendil-works/pi-tui@1.2.0 \
  typebox@1.3.27 @playwright/test@1.62.1 playwright@1.62.1
npx --no-install playwright install chromium
node "$UI_SKILL_DIR/scripts/doctor.mjs" "$PWD" --browser
```

Linux 若缺系统库，按 Playwright 的安装方式使用 `npx --no-install playwright install --with-deps chromium`；可能需要管理员权限。网络须能访问 npm 及 Playwright 浏览器下载源，离线环境要预先提供依赖缓存和匹配浏览器。不要把本机 node_modules 当跨平台安装包。

若宿主与被测项目分离：宿主也需能解析同版 Pi SDK、typebox 和运行包，并从包实际安装位置加载扩展。被测项目必须能解析 `pi-ui-testing/fixtures` 和 Playwright；只在宿主安装不足以执行测试。

正常使用预编译包无需 TypeScript 重建。需要改运行包源码时，将 assets/runtime 复制到独立开发目录，在该目录安装上表依赖及其 package.json 中的 devDependencies（包括 @types/node、@types/proper-lockfile），再 npm run build；不要修改已安装的 node_modules 来维护源码。

## 让 Pi 加载工具与 Skills

Pi CLI 可在被测项目登记本地已安装包：

```sh
npx --no-install pi install --local ./node_modules/pi-ui-testing
```

该命令登记包资源，不能代替 npm 安装或浏览器下载。受信任项目才加载项目级配置。也可用宿主已有 Packages 管理入口选择该目录；不要同时重复注册同一个扩展。

自建 Pi SDK 宿主使用其现有资源加载器加载包的 `package.json` 中 `pi.extensions` 和 `pi.skills`，并接到真实 Agent 的工具、扩展事件和系统提示词。直接 `new Agent(...)` 本身不会自动发现磁盘包。需要提供以下原生上下文：

| 上下文 | 用途 / 接入检查 |
|---|---|
| `ctx.cwd` | 被测项目真实根目录，产物写入该目录的 qa/ui |
| `ctx.executeTool(name,input,{signal})` | 录制 action 调用实际 MCP，保留错误、耗时、取消和父调用关系 |
| `ctx.tools`、`ctx.getSystemPrompt()` | 能力检查；SDK 生成的 available_skills 目录须包含8个阶段 Skill，不能只手写统一入口 |
| `ctx.model`、`ctx.modelRegistry.streamSimple` | 当前选中模型及原生认证，reviewer 用新 Agent、空消息、空工具 |
| `ctx.sessionManager.getSessionDir()` | 稳定、私有的批准/预算目录；同工作区重启和新聊天应可访问原登记 |
| `read` 工具及扩展事件 | 按需加载阶段正文，录制期间经 action 调用 MCP 的约束生效 |

重新加载资源或新建会话后，确认 [工具清单](tools-and-artifacts.md) 的 10 个工具及8个阶段 Skills 存在。统一入口 Skill 可另放入宿主支持的 Skills 目录；Pi 运行包已经自带阶段 Skills，不必再逐个复制安装。SDK 接入细节以随附 `assets/runtime/src/*extension.ts` 为准，没有通用工具名映射插件可自动替代这些接线。

## 配置测试 MCP（浏览器录制必需）

将以下条目**合并**到被测项目 `.pi/mcp.json` 的 `mcpServers`，或用宿主现有 MCP 管理入口登记；不要覆盖已有服务。把 `/absolute/project` 换成实际路径；command 可用宿主的 Node 绝对路径。

```json
{
  "mcpServers": {
    "playwright-test": {
      "command": "node",
      "args": ["/absolute/project/node_modules/playwright/cli.js", "run-test-mcp-server", "--headless", "-c", "/absolute/project/playwright.config.ts"],
      "cwd": "/absolute/project",
      "exposure": "direct",
      "timeout": 45
    }
  }
}
```

Pi 的 timeout 单位是**秒**。需启用原生 MCP、授予项目所需信任，并正确提供 roots。配置中的绝对路径是目标机本地连接配置，不能写入可迁移测试资产。

连接后实际发现 `generator_setup_page`、`generator_read_log`、`generator_write_test`、`browser_snapshot`、`browser_type`、`browser_click`、`browser_close`；常见前缀为 `mcp__playwright_test__`，以实际发现为准。普通 `@playwright/mcp` 或仅有 browser_* 的浏览器插件不能替代这里的**测试 MCP**。仅执行既有资产、只分析/查看旧结果时不需要启动录制 MCP。

## 私有配置与重启

新项目通过宿主既有流程配置模型认证、角色及 storageState。不要复制原项目的 auth.json/models.json 或会话目录。私有 `ui-review-authority` 保存批准、诊断证明和评估预算；项目中的 approved JSON 只是评估产物，不能独立授予执行权限。

同一工作区重启应保留宿主私有目录。换目录/换机器迁移资产后重新评估和诊断，不能拷贝私有批准绕过新环境校验。脚本、规则、依赖、证据变化也会使旧批准失效。
