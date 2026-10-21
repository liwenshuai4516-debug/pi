---
name: ui-artifact-check
description: 校验 UI 测试工作流产物的结构、步骤与来源引用，适用于交接前检查；不替代设计评估或真实测试执行。
---

调用 `ui_validate_artifact` 校验待交接的 JSON。输入完整产物，不传聊天全文或凭据。
它检查 schema 1.0、case/步骤/断言来源的内部引用及评估状态；结构通过不表示语义正确或测试通过。

需要查看某类结构时，使用本 Skill 所在包的 `../../dist/cli.js`：

```sh
node <包路径>/dist/cli.js schema cases
node <包路径>/dist/cli.js validate <产物.json> <被测项目根目录>
```

第二个命令还会核对相对路径引用的文件存在、真实路径边界和 sha256。
可查询的类型：scope、inventory、recording、cases、asset、design-review、task、run、results、analysis、result-review、report。
收到 blocked 时保留具体错误，修订后重新检查；不能写一句“已批准”来绕过设计评估。
