---
name: ui-discover-record
description: 按模块和功能发现 UI 测试场景，使用已安装的 Playwright 测试 MCP 自动录制有证据的脚本草稿；只有源码时保存未录制的清单，不用于批准或正式回归执行。
---

使用 `ui_discover_record` 的 inventory/start/action/status/finish 操作，工具参数统一为 `{request: {operation, ...操作字段}}`。结构可由包的 `../../dist/cli.js schema inventory|recording` 查询；录制启动结构见 [启动说明](references/start.md)。先检查现有 `qa/ui/catalog.json`（缺失或损坏时用 CLI `store-index` 重建）和相关 manifest，只补缺失内容，不重复录制有效资产。

根据输入选择：
- 只有源码：用 Pi 已有检索/读取工具读取相关路由、页面、表单声明、已有测试及共享 fixture，记录文件摘要、符号和行号；按业务模块而非文件名组织 feature/scenario。使用 inventory 操作保存 discovery=source、coverage=discovered 的清单；可同时传 drafts 数组（name/content）保存有来源的脚本或方案草稿，候选定位器须标记未核验，保留动态路由/权限/定位器待核验项；不要启动录制或写“已运行”。
- 只有浏览器：范围中明确当前角色、站点、允许操作和预算；只描述可访问状态，不把未发现当不存在。
- 两者都有：分别保存来源与观察，核对源码和部署关系；不一致时标记 gap，不混成已确认事实。

录制前保存 scope、初始状态规则和数据规则，使用已有项目 seed（绑定文件摘要）；seed 应复用本包 UI-04 fixture 或项目等价机制，检查身份/初始状态并登记 recording 归属数据。认证使用私有 storageState，不在 browser_type 中输入密码/token。合成输入须预先登记为 test_data，或使用本 recording 的 UI-04 ready 数据记录中的业务键；业务键及清理方式记入 data rules。没有可靠准备/清理方法时保留缺口，不自行登录、遍历提交或删除。

先发现实际 MCP 工具，首期只使用 Playwright 1.62.1 的测试 MCP：generator_setup_page/read_log/write_test。调用 start 冻结 seed、后端前缀、浏览器项目、唯一草稿文件及预算；随后所有浏览器操作通过 action，由 Pi 原生 executeTool 调用实际 MCP。动作工具必须携带当前 schema 要求的 intent，当前元素参数是 target；它是临时 ref，只用于当下交互。元素找不到先更新 snapshot，不猜 ref、不强制点击；验证码或未授权步骤停止并保留局部记录。

从 setup 返回的真实快照建立初始 inventory；操作到新的功能状态时补充观察来源，必要时创建新 inventory ID，不能改写旧清单。每次 action 使用稳定 operation_id：同一次请求重试使用原 ID，参数不可变；结果不明时只查 status 和数据归属，不重放写入。

达到目标后 read_log 保存原生动作日志，再 write_test 生成可复用草稿。草稿使用项目现有配置/fixture 提供地址、角色和每次新数据，不能保存录制输入常量、临时 ref、个人路径或凭据。实际记录过的动作与推导补充步骤分开说明。断言预期来自需求、声明或明确标记的行为基线，点击成功不是业务断言。写入目标只用本次新文件，不覆盖已有测试。

结束或受阻时通过 action 调用 browser_close，使 seed 的 teardown 尝试按归属清理；即使预算到达，清理动作仍可调用。finish 保存日志、草稿、最终 inventory、五项 completion 和 gaps；五项为初始状态可重建、数据可替换、稳定定位、断言有来源、清理归属明确。finish.gaps 仅记录当前录制目标尚未完成或不可核验的问题，非空即 partial；范围外未测功能保留在 inventory.unexplored，不放入 finish.gaps，也不能删除范围内真实缺口以通过门禁。缺项则保存 partial，不声称获批。异常、取消、无进展和未探索范围均保留；不要用原始日志覆盖失败历史。完成录制后交给设计评估，不直接执行正式回归。
