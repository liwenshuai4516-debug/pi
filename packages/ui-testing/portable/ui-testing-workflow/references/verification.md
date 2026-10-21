# 本次可迁移包验证

日期：2026-10-21。环境：macOS，Node v23.10.0，npm 10.9.2；使用原有匹配的 Playwright Chromium 缓存。新项目仍需按安装文档下载浏览器及满足操作系统依赖。

验证使用原仓库以外新建的临时 npm 项目，安装导出的 tgz 和文档指定的 Pi/Playwright 依赖，没有链接原仓库 node_modules，没有使用原用户认证，也没有调用付费模型。

| 检查 | 结果 |
|---|---|
| 独立 npm 安装 | 通过；运行包、7 个 Pi 配套包固定 1.2.0、TypeBox 1.3.27、Playwright 1.62.1 |
| doctor | 通过；版本、8 个阶段 Skills、2 套规则、10 个工具定义、契约正反例、临时存储往返和 CLI schema |
| 本机真实 Chromium | 通过；启动、读取本地 DOM、关闭，不访问业务站点 |
| Pi 原生资源加载器 | 通过；隔离设置登记包，DefaultResourceLoader 发现8个 Skills 和10个工具，实际调用产物校验工具拒绝未知版本 |
| Pi 原生 MCP 客户端 | 通过；真实 stdio 连接 Playwright 测试 MCP，发现3个 generator 工具及 snapshot/type/click/close |
| 独立源码编译 | 补齐声明的开发类型依赖后通过；无需原仓库父级 tsconfig |
| 负向检查 | 缺失依赖返回 blocked 和非零退出码；导出拒绝覆盖已有目录 |
| 分发检查 | Skill 校验、内部文档链接、manifest 摘要、个人绝对路径检查通过 |
| 原仓库类型检查 | npm run check 通过；未修改测试运行时业务逻辑 |

验证中修复：doctor 对仅 ESM export 的包解析；Playwright CommonJS 导入；SDK 范围依赖产生配套版本漂移；独立编译缺少 @types/proper-lockfile；源码映射带入构建机路径。最终分发说明与脚本包含这些修正。

没有验证新项目的业务地址、身份、数据规则、模型认证、独立评估质量和完整业务主链；这些需要目标项目按 acceptance.md 执行。没有重跑原项目全部业务/外部模型回归。历史 UI-01～UI-12 的记录与本次分发验证分别陈述，不互相替代。
