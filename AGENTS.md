# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## 面向 Agent 的工具文案

从调用者需要做出的决策出发编写文案：何时使用、如何传参、如何理解结果，以及哪些操作有副作用。不要把工具说明写成实现介绍。

- `promptSnippet`：用一句话说明工具的用途和使用时机，不罗列操作或实现技术。
- `description`：说明主要操作语义及跨参数的关键约束，例如状态要求、会话生命周期和执行后的行为。
- `promptGuidelines`：指导有效、安全的使用策略，例如先提出假设再收集运行时证据、定向检查而非反复单步、注意求值副作用、结束后释放资源。每条应明确提及工具名，因为 Pi 会将它们平铺到系统提示中。
- 参数 `description`：说明适用 action、必填条件、取值来源或选择方式、默认行为，以及容易误解的语义。嵌套字段也需要说明。重点解释行号与索引、替换与追加、超时与停止等区别，不机械复述类型和数值范围。
- 避免在以上位置重复相同说明：参数细节放在 schema，通用操作约束放在工具描述，使用策略放在 guidelines。
- 保持语言无关，不暴露 DAP、具体 Adapter、内部 ID 等实现细节；调用者必须填写的配置字段除外。依赖缺失等可由运行时错误准确反馈的信息，不占用常驻提示。
- 精简不能牺牲准确性：不暗示尚未实现的能力，不删除影响操作选择、安全性或结果解释的约束。修改前核对当前实现，不根据设计意图推测默认值和行为。
- 仅优化文案时，不改变参数结构、校验规则或执行逻辑。
- 对于 action name 如 `inspect`、`output`，要用 "`" 包裹。

## 参考 VS Code 调试实现的边界

**参考 VS Code 对调试正确性问题的处理，不照搬其 IDE 架构。** 两者都要控制程序执行、获取运行时证据，但 VS Code 面向人的持续交互，pi-debug 面向 Agent 的离散工具调用。
pi-debug 应优先保证结果可解释、输出有界、调用高效，而不是复刻 IDE 的交互模型。

- 从 pi-debug 的实际需求设计 Session，不以 VS Code `debugSession.ts` 的分层和对象模型为模板。
- 针对已确认的协议正确性或 Adapter 兼容问题定点参考；区分 DAP 规范、Adapter 行为与 VS Code 产品选择，不把参考实现当作规范。
- 保留调试正确性所必需的状态与生命周期管理；一次性返回结果不等于无状态，也不能消除异步和并发问题。
- 不引入仅为 IDE 视图与交互服务的机制或依赖，也不因 VS Code 已有某项能力就扩大功能范围。
- 每次借鉴先明确：去掉 UI 后，这个问题是否仍然存在？pi-debug 是否确实需要解决？只采用满足需求的最小机制。

## 参考文档

优先阅读以下 pi-coding-agent 文档；它们与本仓库的 extension 开发直接相关：

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension API、事件生命周期、命令、工具、状态管理与自定义 UI 的主参考。
- `node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — `@earendil-works/pi-tui` 组件、自定义编辑器和 footer 的实现模式。
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md` — pi package 的扩展入口和运行时依赖约定。
