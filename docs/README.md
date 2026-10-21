# 设计文档索引

当前唯一技术基准：**Pi Agent SDK + Electron + TypeScript**；执行核心直接使用 `pi-agent-core.Agent`。

| 文档 | 当前用途 |
|---|---|
| [技术设计与约束](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/技术设计与约束.md) | 当前生效的架构、技术边界、数据与验收约束 |
| [项目目录与模块开发规范](./项目目录与模块开发规范.md) | 完整目录、功能归属、模块依赖和新增开发规则 |
| [操作与功能修改指南](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/操作与功能修改指南.md) | 按目录/功能定位代码，操作、修改与验证 |
| [客户端协作规范](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/AGENTS.md) | 根目录与客户端合并去重后的统一规则 |
| [首版实现说明](/Users/liyingjun/Desktop/SW-QA/13-pi/agent-client/docs/pi-web-desktop/04-SDK客户端首版实现说明.md) | 当前 SDK 客户端的实现范围和验证边界 |
| [Pi 扩展使用指南](./Pi扩展使用指南.md) | Packages、Skills、MCP Servers 分类、管理范围与实际加载验证 |
| [测试业务闭环设计](./测试业务闭环设计.md) | 面向业务系统的接口、UI、联动测试流程；技能与工具选型、结果回归及可选多 Agent 调度设计，尚未执行 |
| [UI 测试业务流程详细设计](./UI测试业务流程详细设计.md) | 首期 UI 优先：源码/页面发现、模块用例与断言、设计评估循环、执行统计及结果证据评估循环；尚未实现 |
| [UI 自动录制与资产复用设计](./UI自动录制与资产复用设计.md) | 自动操作录制、设计评估后登记、持久化与失效规则、按需 Skill/脚本组合及任务恢复；尚未实现 |
| [UI 测试能力实施计划书](./UI测试能力实施计划书.md) | 唯一实施排序与进度入口：P0 最小闭环、P1 恢复与维护、P2 扩展；逐任务依赖、交付物和验收标准，尚未开始实现 |
| `Pi-Web-Electron-产品改造方案-v1.0.md`、`pi-web-desktop/01`–`03` | 已失效的历史方案，不作为当前执行要求；仅保留产品语义和决策追溯 |
| `demo/` | 设计参考原型；以用户最新确认布局为准，不是业务执行或验证证据 |

历史文件名为保留引用而未重命名，不代表继续实施 Web 加壳方案。当前应用工程只有 `agent-client/`。
