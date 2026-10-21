---
name: ui-design-review
description: 对 UI 候选调用独立只读 Agent，按 D1–D10 审查来源、脚本和断言；获批后做正反对照诊断、运行登记或查询旧诊断。不接受生成者自报批准，不执行正式回归。
---

调用 `ui_design_review`，传 task_ref、asset_ref、request_id。工具会建立全新 Agent 上下文，工具集合为空，使用当前选定模型及 Pi 原生模型注册表认证；不传生成者的聊天/摘要。task 的 scope 必须匹配候选，原始证据通过真实文件摘要取得。评估输出及引用由工具校验并登记，不能调用普通 write/store-put 伪造执行授权。

先完成候选静态检查。收到 revise 后按 issues 的规则、来源和验收条件重新生成受影响的 case/断言/脚本，保存新修订，再以新 request_id 重评；对同一次网络请求重试才使用旧 request_id。最多三次评估调用，异常也保留且消耗调用预算；重复问题无改善、缺事实、超时或取消时保持未批准。独立上下文可降低共同偏差，不能代替证据校验。

评估正文约束维护在 [rules.md](references/rules.md)，由工具实际读取作为 reviewer 的 system prompt。不要复制另一份规则或让生成者输出 reviewer 结论。工具提供原文片段 anchors 供评估者引用，程序还原真实引用并校验；也兼容精确原文引用，错引用、不存在片段或引文都不能登记批准。规则版本同时绑定提示词和实际输出 schema。评估输出无效时，错误返回已保存的输入、静态报告及原始响应引用，不能抹掉失败后假称已通过。

approved 仅表示当前修订的设计批准。源码-only 仍无运行就绪证明；任何脚本/来源/helper/fixture/config/依赖版本变化都要重新校验和必要重审。运行就绪及正式执行由独立门禁判定，不能用聊天中的“通过”替代。模块受阻时保留原清单和范围，不静默缩小分母。

需要进入运行阶段时，先准备诊断计划并在评估前纳入候选 files。用包 CLI `schema diagnostic-spec` 查询结构：environment_ref 是当前目标；config_ref 是原生 Playwright 配置；probes 指定隔离错误副本的环境、变异来源和 assertion_ids。每条断言至少有一个合理错误结果探针，脚本和预期值保持不变。需要已知正常副本做正对照时填写 control_environment_ref；它不能替代目标环境的身份/初态检查，也不代表当前产品通过测试。所有配置、环境和变异来源进入修订与独立审查，不能在获批后临时换入。

设计获批后调用 `ui_design_diagnose`，参数 `{request:{operation:"diagnose",asset_ref,review_ref,spec_ref,request_id}}`。工具先检查可信批准，再用原生 Playwright 执行正反对照、保存非正式诊断证据，并登记 runtime_ready。没有合理错误副本时保留“设计通过、运行未就绪”，不能放宽断言或伪造证明。

用 `{request:{operation:"status",request_id}}` 查询已存请求，不触发浏览器。相同请求去重；已开始但结果不明、取消或进程异常时禁止换 ID 重放，先核对原进程与数据。重新诊断会使旧运行证明失效；规则、脚本、依赖或证据改变也会拒绝旧证明。运行登记只说明这份脚本完成受控设计验证；正式执行仍须新的当前环境/认证/数据预检、新 context 和新批次。
