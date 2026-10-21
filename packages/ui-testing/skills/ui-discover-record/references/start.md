# 录制启动与文件交接

所有路径相对于被测项目，引用为 `{path,sha256}`。scope/初始 inventory 先用 CLI store-put 或 inventory 操作登记；source refs 应绑定真实文件，不能用聊天文字冒充源码/浏览器观察。

start.configuration 的必需字段：
- id、scope_ref、inventory_ref、initial_state_ref、data_rules_ref、seed_ref。
- backend：实际工具前缀，例如 `mcp__playwright_test__`；project：已验证的 Playwright 项目名。
- output_file：项目 testDir 下全新 `*.spec.ts` 路径。
- max_steps、max_duration_ms、max_no_progress：不超过范围步数预算，建议单一主链 20 步、120000 ms、3 次无变化快照。
- test_data：可公开的合成输入数组，不能是账号密码、密钥或个人数据。

start 返回 session_ref；action 参数为 `{request:{operation:'action',session_ref,operation_id,tool,input,intent}}`，其余操作也放在 request 对象中，其中 tool 是不含前缀的原生工具名，input 保留原工具结构。输出 observation_ref 绑定实际结果，可作为 inventory.source_refs。status 会读取已保存动作和停止原因，不启动浏览器。finish 参数包含 session_ref、inventory_ref、initial_state、goal_reached、gaps 与完整 completion 对象；其字段名以 `schema recording` 为准。

源码-only 清单通过 inventory 操作持久化，不需要构造虚假 recording。初始和最终清单可以使用不同 ID，最终清单用真实 observation_ref 增补 source_refs；scenario_id 按业务目标稳定命名，coverage 表达发现/探索/阻塞状态。原始观察不能当作未声明需求的正确性依据。
