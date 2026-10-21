# UI 测试 Skill 迁移与安装

目标：在另一个 Pi Agent SDK 项目复用已完成的 UI-01～UI-12，不复制原桌面客户端。入口名为 `ui-testing-workflow`；安装说明涵盖 npm 运行包、Pi 扩展与 Skills、Playwright Chromium、测试 MCP、模型/身份配置和验收。

## 维护位置与导出

- Skill 正文、安装/环境/工具/恢复/验收文档、doctor 源文件：[portable/ui-testing-workflow](../packages/ui-testing/portable/ui-testing-workflow/SKILL.md)。这是打包模板，完整 assets 在导出时生成，不能只复制此模板目录。
- 运行源码、阶段 Skills、两个 reviewer 的规则仍在 `packages/ui-testing/src`、`skills` 维护；导出时直接复制，不创建第二套实现或评估规则。
- 导出入口：[export-ui-testing-skill.mjs](../scripts/export-ui-testing-skill.mjs)。隔离编译 UI 包，输出必须是不存在的新目录；不清理应用构建、不安装依赖、不改变用户配置。分发时关闭源码映射，避免嵌入构建机器路径。

在客户端根目录、已安装开发依赖后运行：

```sh
node scripts/export-ui-testing-skill.mjs ./release/ui-testing-workflow
```

生成完整 Skill 目录，其中 `assets/runtime` 含源码、编译结果、阶段 Skills、示例及独立 tsconfig；`assets/pi-ui-testing-0.1.0.tgz` 可直接在目标 npm 项目安装。`bundle-manifest.json` 记录源提交、实际文件 sha256 和构建时间。源码/运行包和安装文档可一起随目录迁移，不需原仓库；node_modules 和浏览器二进制需在目标机安装。

分发目录在 release 下，遵循仓库规则不提交构建产物；模板和导出脚本本地提交。需要压缩包时压缩整个 ui-testing-workflow 目录，不能只压缩 SKILL.md。也可将完整目录放入 Agent 的 Skills 搜索路径。Pi 包自带8个阶段 Skills，统一入口放到宿主支持的位置后即可按需路由。

## 新项目操作

1. 阅读导出目录 `references/install.md`，在被测项目 npm 安装 tgz、锁定 Pi SDK 1.2.0、TypeBox 1.3.27 和 Playwright 1.62.1，下载 Chromium。
2. 由新宿主的 Pi 资源加载器注册安装包的扩展和阶段 Skills；Pi CLI 也可使用 `pi install --local ./node_modules/pi-ui-testing`。npm 安装和 Agent 资源注册是两个步骤。
3. 按安装文档合并测试 MCP 配置；确认 generator_* 工具存在。原生 Pi MCP 即可，无需新的第三方适配插件。
4. 在目标项目运行 doctor，再按 `project-setup.md` 准备真实环境、来源、seed、身份和数据清理规则。
5. 用一个隔离主链完成设计/诊断/执行/结果评估，再验证重启复用；不能把安装检查当成新业务验收。

宿主与被测项目分离时，两侧各自满足依赖解析与资源加载要求。运行包不含 Electron，也不要求把新宿主改成 Electron。只复制 Skill 不会自动获得 ui_* 工具；直接 new Agent 也不会自动加载磁盘包，接入上下文清单见安装文档。

迁移已有**业务资产**时另用 ui_asset_maintain export/import，不能复制私有批准、模型认证或会话来取得目标执行权。跨目录重新审查和诊断。未交付的多 Agent 并行、多浏览器及视觉回归不包含在本 Skill 中。
