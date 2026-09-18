# pi-debug 能力建设计划

## 目标

让 Pi Agent 能够通过一个小而稳定的工具接口完成应用程序调试闭环：

1. 启动或连接目标程序。
2. 设置能够验证假设的停止条件。
3. 确认程序为何停止。
4. 将运行时状态关联回可读取的源码。
5. 定向检查调用栈、变量、表达式和异常。
6. 控制执行并重复实验。
7. 处理输出、并发、子进程和资源清理。

pi-debug 面向 Agent，不复制 VS Code 的 UI、长期可订阅 model 或完整 extension-host 架构。对外接口应保持接近：

```text
start → set probes → wait/control → inspect evidence → restart/stop
```

DAP capability、引用生命周期、事件归并、路径映射和输出预算等复杂性应隐藏在模块内部。

## 当前基线

已实现：

- DAP framing、请求/响应配对、事件分发、reverse request 基础设施、超时、取消和背压。
- stdio、TCP、spawned TCP server transport。
- Go/Delve launch、local attach 和 remote attach。
- source line breakpoint。
- continue、pause、next、step in、step out 和单线程执行控制。
- 多线程状态、stack trace、scope、变量树、evaluate 和一次性 inspect 快照。
- 事件修订号与 stale context 检测。
- Adapter/debuggee 输出的有限缓存。
- Go/Delve 真实端到端验证。

当前主要限制：

- 实际只支持 Go；Python provider 尚未实现。
- `runInTerminal` 仅支持非交互式进程；不支持 `startDebugging` reverse request。
- 缺少完整异常信息和可配置异常断点。
- 断点只支持文件与行号。
- 截断后的变量和 evaluate 结果无法继续展开。
- 不支持 `sourceReference`、远程路径映射和 Adapter source。
- 只支持一个 session。
- 输出缺少结构化分类、顺序和增量读取能力。

---

## P0：完成通用调试闭环

### 1. 建立可扩展的 Debug Adapter 接入方式

- [ ] 修正 `src/adapters/index.ts` 的支持类型声明：Python 未实现前不得声称支持 `python`/`debugpy`。
- [ ] 实现 Python/debugpy provider，至少支持：
  - [ ] launch Python 文件或 module。
  - [ ] attach 已监听的 debugpy server。
  - [ ] cwd、args、env 和常见 debugpy 配置透传。
- [ ] 提供通用 executable adapter 配置，复用 `StdioTransport`。
- [ ] 提供通用 TCP adapter 配置，复用 `TcpTransport`。
- [ ] 将 provider 的职责限制为配置校验、路径归一化和 transport 构造。
- [ ] 启动错误应区分：命令不存在、连接失败、配置错误、Adapter 拒绝请求。

验收标准：

- 无需修改 session 层即可增加新的 Adapter provider。
- Go 和 Python 都能完成 launch/attach、断点、inspect、continue、stop 的基本流程。
- `configurations` 和启动错误不会声明不存在的能力。

### 2. 支持 `runInTerminal` reverse request

- [x] 在 session 初始化前注册 `runInTerminal` handler。
- [x] 正确处理 Adapter 提供的 cwd、args 和 env。
- [x] 返回 DAP 要求的 process ID 信息。
- [x] 跟踪由 pi-debug 启动的 debuggee 进程，并在 session 关闭时按 launch/attach 语义清理。
- [x] 捕获 stdout/stderr，并纳入统一输出通道。
- [x] 明确定义 stdin 策略：
  - [x] 第一阶段可明确拒绝交互式 stdin。
  - [x] 不得让等待输入的程序表现为无原因挂起。
- [x] 成功实现后将 `supportsRunInTerminalRequest` 设为 `true`。

验收标准：

- 依赖 `runInTerminal` 的 Adapter 能启动非交互式应用。
- session 取消、失败和 stop 后不遗留子进程。
- 不支持的终端请求返回可操作的错误信息。

当前行为：`kind` 省略或为 `integrated` 时直接启动进程，不创建 PTY；`external` 和 shell 参数解释请求返回错误。参数原文透传，空 cwd 使用 workspace，env 在继承环境上覆盖，`null` 删除变量。stdin 接入 EOF，并在输出中明确提示不支持交互输入；需要终端交互的程序应改为非交互式配置或先自行启动再 attach。响应返回实际 `processId`，不虚构 shell PID。stdout/stderr 共用现有 16,000 字符输出预算。

生命周期：无论 launch 还是 attach，由 `runInTerminal` 新建的进程都归会话所有，关闭、启动失败、取消或连接断开时清理；attach 的既有目标仍只断开、不主动终止。POSIX 使用独立进程组清理普通子进程（自行脱离进程组的 daemon 不在管理范围）；Windows 使用 `taskkill /T /F` 清理仍存活的进程树。

### 3. 补全异常诊断

- [ ] 暴露 Adapter 的 exception breakpoint filters。
- [ ] 支持配置 caught、uncaught 及 Adapter-specific exception filters。
- [ ] 支持 filter options 和 exception options（Adapter capability 允许时）。
- [ ] 增加 `exceptionInfo` 请求。
- [ ] 当停止原因为 exception 时，让 `inspect` 自动附带：
  - [ ] exception ID/type。
  - [ ] description/message。
  - [ ] break mode。
  - [ ] details、stack trace 和 inner exceptions。
- [ ] 对不支持 `exceptionInfo` 的 Adapter 做明确降级，只返回已有 stopped 信息。

验收标准：

- Agent 能回答“程序因什么异常、在哪里、以何种捕获状态停止”。
- 异常信息受字符和嵌套深度预算约束。

### 4. 增加精确停止条件

- [ ] 将 source breakpoint 从单纯行号扩展为：
  - [ ] `line`
  - [ ] `column`
  - [ ] `condition`
  - [ ] `hitCondition`
  - [ ] `logMessage`
- [ ] 保留简写 `lines: number[]`，避免简单调用变复杂。
- [ ] 返回 Adapter 验证后的行列、verified 状态和 message。
- [ ] 根据 capability 提前拒绝不支持的断点属性。
- [ ] 允许按文件原子替换和清除断点。

验收标准：

- Agent 能跳过无关循环迭代并定位特定状态。
- 不支持条件断点或 logpoint 时，错误中给出可用替代方案。

### 5. 让变量和表达式结果可继续导航

- [ ] 在 session 内引入短期有效的 opaque variable cursor，不向工具调用方暴露原始 `variablesReference`。
- [ ] cursor 应绑定 session revision；程序继续运行后必须失效。
- [ ] 支持按 cursor 展开变量。
- [ ] 支持 start/count 分页。
- [ ] 支持 DAP `filter: named | indexed`。
- [ ] 利用 `namedVariables` 和 `indexedVariables` 提示可用数量。
- [ ] evaluate 结果可返回 cursor，并允许继续展开。
- [ ] `inspect` 仍提供有预算的快速概览，不要求 Agent 手动遍历所有变量。
- [ ] stale cursor 返回明确错误，引导调用方重新 inspect/evaluate。

验收标准：

- 目标字段不在前 50 项时仍可访问。
- 大数组和大对象不会产生无界结果。
- 表达式返回复杂对象时可以继续检查其子项。

### 6. 建立 Source 归一化层

- [ ] 保留完整 DAP `Source` 信息，不只保存 `path`。
- [ ] 支持 `sourceReference` 和 DAP `source` 请求。
- [ ] 为 Adapter 返回的源码提供受预算限制的读取结果。
- [ ] 支持显式 remote path → local path 映射。
- [ ] 规范化本地路径，避免符号链接和相对路径造成源码定位失败。
- [ ] stack frame 返回 Agent 可直接交给 `read` 的本地路径；无法映射时返回 source cursor。
- [ ] source cursor 与 session 生命周期绑定。

验收标准：

- 本地、远程和无本地文件的 source 都能被 Agent 定位或读取。
- 远程路径不会被错误地按 workspace 相对路径解析。

---

## P1：提高诊断范围和效率

### 7. 保存结构化事件与输出时间线

- [ ] 用有界环形缓冲区替代单一 output 字符串。
- [ ] 保留以下字段：sequence、category、text、source、line、column、timestamp。
- [ ] 区分 debuggee output、Adapter stdout 和 Adapter stderr。
- [ ] 支持 cursor 增量读取，避免 `status` 消费并丢弃输出。
- [ ] 处理 DAP output group start/end 语义。
- [ ] 输出被截断时返回丢弃范围或 dropped count。

验收标准：

- Agent 可以重建停止前后的输出顺序。
- 高频输出不会导致内存无界增长或工具结果失控。

### 8. 支持可重复实验

- [ ] 保存 root session 的已解析启动配置与断点计划。
- [ ] 增加 restart 操作：优先使用 DAP `restart`，否则安全地 stop + start。
- [ ] terminated session 不应要求调用方先显式 stop 才能重新启动；但必须先完成旧资源清理。
- [ ] restart 后旧 thread、frame、variable 和 source cursor 全部失效。
- [ ] 根据 Adapter capability 评估 `restartFrame`。
- [ ] 根据实际诊断收益评估 run-to-location/goto；不默认暴露全部底层请求。

验收标准：

- Agent 能修改探针并重复同一次实验，不遗留旧会话状态。
- restart 的资源和状态语义对 launch 与 attach 都明确。

### 9. 支持多进程和 child session

- [ ] 实现 `startDebugging` reverse request。
- [ ] 将单 session manager 深化为 `SessionSupervisor`：管理一个 root session 和有限数量 child sessions。
- [ ] 工具结果中返回稳定的 session 标识、名称和父子关系。
- [ ] 只有存在多个候选 session 时才要求调用方显式选择 session。
- [ ] root stop 时按策略关闭 child sessions。
- [ ] 限制 session 数量，防止 Adapter 无界创建子会话。
- [ ] 不引入 VS Code 的 compound/parent session UI model。

验收标准：

- Python multiprocessing、test runner worker 等场景可以进入子进程。
- 单进程调试接口仍然保持简单。

### 10. 改进配置解析和诊断

- [ ] 启动前检测未解析的 `${...}`，并明确报错。
- [ ] 按实际需求补充常用变量，而不是完整复制 VS Code substitution 系统。
- [ ] 校验 cwd、program 和 Adapter executable 等关键路径。
- [ ] 配置列表标记 provider 是否可用及不可用原因。
- [ ] 允许 `.pi/launch.json` 覆盖 `.vscode/launch.json` 的现有语义保持不变。
- [ ] 暂不实现完整 `preLaunchTask`；文档引导 Agent 使用 `bash` 执行 build/test 准备步骤。
- [ ] 多 session 成熟后再评估 compound 配置。

验收标准：

- 配置错误在启动 Adapter 前尽可能被发现。
- 错误信息包含具体字段和值来源。

### 11. 暴露面向决策的 capability

- [ ] 不直接向 Agent 倾倒原始 DAP `Capabilities`。
- [ ] `status` 或独立结果中提供面向操作的能力摘要，例如：
  - [ ] conditional breakpoints
  - [ ] hit conditional breakpoints
  - [ ] logpoints
  - [ ] exception info
  - [ ] variable paging
  - [ ] restart
  - [ ] child sessions
  - [ ] data breakpoints
  - [ ] single-thread execution
- [ ] 每个可选操作在发请求前检查对应 capability。
- [ ] capability 动态更新后刷新摘要。

验收标准：

- Agent 能在调用前判断操作是否可用。
- 不支持的操作不会依赖 Adapter 返回晦涩错误。

---

## P2：按实际场景增加

### 12. 高级断点

- [ ] Function breakpoint。
- [ ] Data breakpoint，包括 `dataBreakpointInfo` 的发现流程。
- [ ] Instruction breakpoint。
- [ ] 处理 breakpoint changed 事件。

### 13. 运行时状态修改

- [ ] `setVariable`。
- [ ] `setExpression`。
- [ ] 工具说明必须强调这类操作会改变程序状态。
- [ ] 修改后推进 revision，使旧快照和 cursor 失效。

### 14. 其他导航和执行能力

- [ ] loaded sources。
- [ ] modules。
- [ ] process 事件。
- [ ] loadedSource 事件。
- [ ] step back / reverse continue。
- [ ] DAP `cancel`，避免取消长请求时只能关闭整个 session。

### 15. Native/embedded 场景

仅在明确需要调试 native、embedded 或底层崩溃时考虑：

- [ ] read/write memory。
- [ ] disassemble。
- [ ] instruction pointer 和 instruction-level stepping。

---

## 明确不做

除非目标发生变化，否则不复制以下 VS Code 能力：

- [ ] Debug views、toolbar、editor decoration 和 hover UI。
- [ ] `ViewModel`、焦点跟随和长期可订阅 domain model。
- [ ] 完整 `ReplModel` 和交互式 Debug Console。
- [ ] watch expression 持久化。
- [ ] telemetry。
- [ ] debugger extension-host contribution bridge。
- [ ] 完整 Task 系统。
- [ ] visualizer、memory editor 和 disassembly editor UI。

## 设计约束

- 每个工具调用返回受预算约束的一次性 JSON 快照。
- 不缓存可以按需重新获取的 frame 和 variable 数据。
- DAP 原始 ID、引用和 capability 尽量不泄漏到 Agent 接口。
- 任何 cursor 都必须绑定 session 与 revision，并有明确失效语义。
- 执行控制、求值和状态修改的副作用必须在工具说明中明确。
- 所有 Adapter-specific 逻辑留在 provider；session 层保持语言无关。
- 只有确实存在两个实现时才引入新的 seam。
- 优先深化现有 `debug` 工具，不为每个 DAP request 增加独立工具或 action。
- 不以 VS Code `DebugSession` 的 UI model 架构作为实现模板。

## 建议里程碑

### Milestone 1：通用启动

完成 P0.1 和 P0.2，使 Go、Python及通用 Adapter 可以可靠启动或连接应用。

### Milestone 2：诊断核心

完成 P0.3、P0.4 和 P0.5，使 Agent 能以异常和精确探针停止，并深入导航运行时值。

### Milestone 3：源码与证据

完成 P0.6 和 P1.7，使远程/动态源码与运行输出形成可追踪证据。

### Milestone 4：复杂应用

完成 P1.8、P1.9、P1.10 和 P1.11，支持重复实验、多进程和可预判的 capability 降级。

### Milestone 5：按需扩展

根据真实调试任务选择 P2 能力，不以 DAP 覆盖率本身作为目标。
