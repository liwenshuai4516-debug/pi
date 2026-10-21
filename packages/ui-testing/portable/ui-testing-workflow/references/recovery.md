# 恢复与维护

先 catalog/status 找原 task、run 和当前阶段；恢复依据是文件及私有登记，不是聊天摘要。

| 状况 | 处理 |
|---|---|
| 程序重启、原阶段未完成 | resume-task 使用最新 task_ref，保留已完成阶段和评估预算；终态不复活 |
| 执行完成、分析未完成 | 继续原 analyze，或新建 analyze 指向原 run；不重新运行浏览器 |
| 录制中断 / partial | 读取原日志和数据归属，核对副作用；不凭旧 ref 继续点击，不直接交接设计 |
| 已确认未启动的实例 | plan-recovery intent=resume，选择未启动集合；新任务、新 run、新 context |
| 重跑 failed/flaky | plan-recovery intent=rerun-failed；保留 parent_run_ref 和原失败 |
| 同修订全量重跑 | plan-recovery intent=rerun-all；父批次是子集也选择资产全量 |
| 活跃/中断/写入未知 | 保留 blocked，核对原进程及业务状态；没有通用自动清理批准接口，不删除 active-run 或换 ID 绕过 |
| 缺 trace/原生结果 | 保留已知失败，生成新 results/report，按证据缺口交付 partial；不覆盖旧批次 |
| 私有批准丢失 / 新目录 | 在新宿主重新独立评估及诊断；不能仅复制 approved JSON |

plan-recovery 只读，返回 blockers 或空集合时不执行。执行 start 同时携带 parent_run_ref，selection.json 固定实例集合，恢复从完整 case/业务链初态开始，不从中途点击恢复。修脚本先生成新修订重审；不同部署版本分别报告，子集变绿不能改写父批次统计。

## 资产维护

- impact：changed_paths 或 git_ref 二选一。按登记依赖及 Git 变化输出影响；信息不全保守重审，不承诺精确业务代码覆盖。
- inspect-import：对项目内 script_path 提取静态标题和摘要；动态标题留待核对。补来源、case/断言映射、数据规则及依赖后走正常设计评估，导入不等于批准。
- export：asset_ref、bundle_id，引用闭包写入 `qa/ui-transfers/<id>`，不带运行历史、会话、认证或私有批准。将**整个迁移目录**放入新项目允许目录，再用该目录 bundle.json 的真实 FileRef 调用 import。
- import：校验完整文件摘要，不覆盖同路径不同内容。缺依赖先修复清单，不从零重生成掩盖错误；目标环境重新配置身份、审查和诊断。
- audit-evidence：retention_days、audit_id，登记过期或不可核验记录；已登记 run 的引用受到保护，目前不会自动删除证据。

迁移**能力包**用本 Skill 安装流程；迁移**业务测试资产**用 export/import。两者不同，不能以复制 Skill 替代复制目标项目的需求、用例、fixture 和环境规则。
