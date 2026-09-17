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

## 参考 VS Code 调试实现的边界

`src/debug/` 的 Session 层**不以** VS Code `debugSession.ts` 为设计范本。两者的消费者不同：VS Code 面向交互式 IDE，需要长生命周期、可订阅的 model（`Thread`、`StackFrame`、`ExpressionContainer`）驱动 UI 视图刷新、REPL、焦点跟随、遥测等；pi-debug 面向 LLM Agent 的工具调用，每次调用返回一次性快照，只需要把当前 DAP 状态映射为受预算约束的 JSON。整体照搬 VS Code 的分层会引入大量与 Agent 无关的可变状态、事件通道和服务依赖，违反 KISS。

允许**定点参考** VS Code 实现中与 DAP 协议正确性直接相关的细节，仅在遇到对应问题时按需查阅，不移植其结构：

- 多次 `stopped` / `continued` 事件的合并与去抖（VS Code 用 `stoppedDetails` 数组和 `ThreadStatusScheduler`），用于校验 pi-debug 对最终 stop reason 归属的处理。
- `continue` / `next` / `stepIn` / `stepOut` 响应中 `allThreadsContinued` 缺省值的语义差异。
- `invalidated` 事件按 `body.areas` 分域失效（`stacks` / `variables` / `threads`）的策略，仅在需要减少不必要 stale 重试时引入。
- `Source` 按 `sourceReference` 归一化，仅在支持内存/反编译/远程源时引入。

明确**不移植**的部分：REPL、`fetchThreadsScheduler` 类去抖、`passFocusScheduler`、compound/parent session、telemetry filter、memory region、disassembly，以及所有 `IWorkbench*` / `INotification*` / `IUriIdentity*` 等 IDE 服务依赖。

## 参考文档

优先阅读以下 pi-coding-agent 文档；它们与本仓库的 extension 开发直接相关：

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension API、事件生命周期、命令、工具、状态管理与自定义 UI 的主参考。
- `node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — `@earendil-works/pi-tui` 组件、自定义编辑器和 footer 的实现模式。
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md` — pi package 的扩展入口和运行时依赖约定。
