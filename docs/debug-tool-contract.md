## 调用约定

所有操作都通过以下形式调用：

```json
{
  "action": "<action>",
  "...": "action 对应的参数"
}
```

结果通常是格式化后的 JSON 文本。值为 `undefined` 的可选字段不会出现在 JSON 中。`output` 是例外，它返回带 category 前缀的纯文本。

### 公共选择和分页规则

- `start` 为新 session 分配并返回不可复用的 `sessionId`；Adapter 通过 DAP `startDebugging` 创建的 child session 同样获得独立 `sessionId`，并在 `list_sessions` 中通过 `parentSessionId` 标识来源。`list_configurations`、`list_sessions` 和 `start` 之外的 action 都必须传入目标 `sessionId`。不自动选择当前或唯一 session。已经接收 `sessionId` 的 action 不在结果中重复它。
- `threadId` 来自同一 session 的 `threads` 或 stopped 结果。检查、继续和单步操作省略它时，优先选择最近停止的线程；否则仅在恰好有一个 stopped 线程时自动选择。未指定线程的执行或等待结果优先返回触发最近一次 stop 事件的线程；若显式等待另一线程且该事件使所有线程暂停，返回的线程可能不是触发者，此时以 `stop.threadId` 判断触发线程。
- `frameIndex` 是线程调用栈中的 **zero-based 位置**，不是 DAP frame ID，默认 `0`。
- `revision` 是 session 内部单调递增的整数，出现在两处：
  - 结果中：`status` / `close_session` 快照顶层 `revision` 反映 session 最新状态版本。`ThreadSnapshot` 在 `state == "stopped"` 时携带引起此次 stop 的 `revision`。`stack_trace`、`variables`、`evaluate` 结果里的 `revision` 与所依赖的 stop revision 相同。线程一旦恢复或状态变化，先前的 `revision` 和一切 `variablesReference` 都失效。
  - 入参中：`stack_trace`、`variables`（scope 分支）、`evaluate` 传入 `revision` 用于拒绝过期检查——不等于当前 stop revision 就返回 `STALE_REVISION` 错误；省略则跳过校验。`variables` 展开 `variablesReference` 时 `revision` 必填。`wait` 的 `revision` 是等待基线，只返回严格晚于它的新 stop、线程退出或 session 关闭；省略视为无基线。所有 revision 和 reference 都只能与产生它的 `sessionId` 一起使用。
- 分页参数 `start` 是 zero-based 偏移，默认 `0`。
- `count` 默认 `50`；`stack_trace` 默认 `20`；取值范围为 `1..100`。
- `nextStart` 存在时，用它作为下一次调用的 `start`。`total` 只在实现能确定总数时出现。
- `waitMs` 是等待新事件的预算，默认 `1000` ms，取值范围为 `0..30000`。超时不会暂停程序，也不会撤销已经发出的执行命令。

### 公共结果结构

执行控制类 action 返回 `ExecutionOutcome` 以下五种结果之一：

```jsonc
// 命中断点、完成单步或被暂停；`thread` 上的 `revision` 可用于后续 stack_trace / variables / evaluate
{
  "kind": "stopped",
  "thread": {
    "id": 1,
    "name": "main",
    "state": "stopped",
    "revision": 12,
    "stop": {
      // ...DebugProtocol.StoppedEvent["body"]
    }
  }
}

// stop 事件未标注 threadId 时用该结构，不推测触发线程
{
  "kind": "stopped",
  "revision": 12,
  "stop": {
    // ...DebugProtocol.StoppedEvent["body"]
  }
}

// 被等待的线程退出
{ "kind": "threadExited", "threadId": 1 }

// 等待预算耗尽
{ "kind": "timeout", "snapshot": { "...": "SessionSnapshot，见 status" } }

// session 完成关闭
{ "kind": "closed", "snapshot": { "...": "SessionSnapshot，见 status" } }
```

## 支持的 actions

### `list_configurations`

列出项目中保存的 launch/attach 配置。只返回通用字段，不暴露 Adapter 专属配置。

**入参**

```json
{ "action": "list_configurations" }
```

**结果示例**

```json
{
  "configurations": [
    { "name": "Launch API", "type": "go", "request": "launch" }
  ]
}
```

### `list_sessions`

列出 manager 当前拥有的 session，只读取本地状态，不向 Adapter 发请求。结果按 session 创建顺序排列。Adapter 自动创建的 child session 带有 `parentSessionId`；child 可独立操作，但关闭 parent 会先关闭它的所有 descendants。

**入参**

```json
{ "action": "list_sessions" }
```

**结果示例**

```json
{
  "sessions": [
    {
      "sessionId": "debug-1",
      "configuration": { "name": "Launch API", "type": "go", "request": "launch" },
      "state": "active",
      "busy": false
    },
    {
      "sessionId": "debug-2",
      "parentSessionId": "debug-1",
      "state": "starting"
    }
  ]
}
```

### `start`

根据保存的配置名或 inline 配置创建独立 session，安装初始断点，启动或 attach 程序，然后等待新的 stop、线程退出、session 关闭或超时。多个 session 可以并发启动和操作；attach 不会回溯启动前已经发生的事件。

**入参**

```jsonc
{
  "action": "start",
  "configuration": "Launch API", // 必填；也可以是下面的 inline object
  "initialBreakpoints": {        // 可选，默认 {}
    "source": [                  // 可选，每个 file 最多出现一次，最多 100 项
      {
        "file": "main.go",       // 相对路径解析到项目目录
        "lines": [               // 最多 100 项；[] 清空该文件断点
          { "line": 10 },
          { "line": 42, "condition": "n > 5" },
          { "line": 77, "logMessage": "reached with x={x}" }
        ]
      }
    ],
    "function": [                // 可选，全局函数断点；[] 清空。需要 supportsFunctionBreakpoints
      { "name": "handleRequest" },
      { "name": "retry", "hitCondition": ">=3" }
    ]
  },
  "waitMs": 5000
}
```

断点条目的通用字段：

- `condition`：条件表达式，仅在为真时中断。需要 `supportsConditionalBreakpoints`。
- `hitCondition`：命中次数表达式，例如 `>=5` 或 `%3`，由 Adapter 解释。需要 `supportsHitConditionalBreakpoints`。
- `logMessage`：命中时输出插值消息而不中断（仅 source 断点）。需要 `supportsLogPoints`。

缺少对应 capability 时下发相关字段会直接失败并返回 `INVALID_ARGUMENT`。可在 `status` 中查看 `capabilities`。

Inline 配置保留 Adapter 专属字段：

```json
{
  "action": "start",
  "configuration": {
    "name": "Inline Go",
    "type": "go",
    "request": "launch",
    "program": ".",
    "args": ["--listen", ":8080"]
  }
}
```

**结果示例**

```jsonc
{
  "sessionId": "debug-1",
  // ExecutionOutcome
  "execution": {
    "kind": "stopped",
    "thread": {
      "id": 1,
      "name": "main",
      "state": "stopped",
      "revision": 3,
      "stop": { "reason": "breakpoint", "allThreadsStopped": true }
    }
  },
  "breakpoints": {
    "source": [
      {
        "source": { "path": "/workspace/main.go" },
        "specs": [
          { "line": 10 }
        ],
        "breakpoints": [
          { "verified": true, "source": { "path": "/workspace/main.go" }, "line": 10 }
        ]
      }
    ],
    "function": {
      "specs": [
        { "name": "handleRequest" }
      ],
      "breakpoints": [
        { "verified": true, "id": 3 }
      ]
    },
    "exception": {
      "filters": ["uncaught"],
      "breakpoints": [
        { "verified": true }
      ]
    }
  }
}
```

`breakpoints.source` 始终存在，未安装任何 source 断点时为 `[]`。每一项都是 `{ source, specs, breakpoints }` 的组合：`specs` 是请求安装时提交的原始 spec 列表（不含清空情形），`breakpoints` 是 Adapter 汇报的 `DebugProtocol.Breakpoint` 数组，两者按请求顺序对齐。`breakpoints.function` 只在入参提供了 `initialBreakpoints.function` 时出现，结构相同。`breakpoints.exception` 只在 Adapter 汇报了默认 exception filter 时出现，`filters` 记录启动时下发的过滤器；`breakpoints` 由 Adapter 返回的 `SetExceptionBreakpointsResponse.body.breakpoints` 填充，Adapter 未返回状态时省略。

### `status`

返回指定 session 的当前快照，不向 Adapter 刷新线程列表。顶层 `revision` 为 session 目前的版本号，每次线程状态变化递增。`threads` 列表最多展示 50 个线程，stopped 线程排在前面；`totalThreads` 始终反映完整线程数，`omittedThreads` 仅在发生截断时出现，需要完整列表时使用 `threads` action 翻页。session 尚未创建 `DebugSession` 时返回 `INVALID_STATE`；可通过 `list_sessions` 查看 manager 生命周期状态。

**入参**

```json
{ "action": "status", "sessionId": "debug-1" }
```

**结果示例**

```json
{
  "state": { "state": "active" },
  "configuration": { "name": "Launch API", "type": "go", "request": "launch" },
  "capabilities": {
    "supportsSingleThreadExecutionRequests": true,
    "supportsConditionalBreakpoints": true,
    "supportsHitConditionalBreakpoints": true,
    "supportsLogPoints": false,
    "supportsFunctionBreakpoints": true
  },
  "revision": 12,
  "threads": [
    {
      "id": 1,
      "name": "main",
      "state": "stopped",
      "revision": 12,
      "stop": { "reason": "breakpoint", "allThreadsStopped": true }
    }
  ]
}
```

`state` 的可能结构为：

```jsonc
{ "state": "starting" }
{ "state": "active" }
{ "state": "closing", "reason": { "kind": "requested" } }
{ "state": "closed", "reason": { "kind": "terminated" }, "cleanupError": "可选清理错误" }
```

`capabilities` 是从 Adapter 汇报中挑选出的、影响下发参数选择的开关：`supportsSingleThreadExecutionRequests` 控制 `continue` / 单步的 `singleThread`；`supportsConditionalBreakpoints` / `supportsHitConditionalBreakpoints` / `supportsLogPoints` 控制断点条目上的 `condition` / `hitCondition` / `logMessage`；`supportsFunctionBreakpoints` 控制 `set_function_breakpoints` 与 `initialBreakpoints.function`。未汇报的能力统一表示为 `false`。

### `close_session`

请求关闭指定 session。它会中止尚未完成的启动，并清理 DAP session、Adapter 和 integrated terminal；对于 `launch` session 还可能终止 debuggee。该 action 不表示暂停执行，暂停使用 `pause`。

调用最多等待五秒。所有启动任务和资源清理在预算内完成时返回 `closed` 并从 manager 移除 session；否则返回 `closing`，session 保留在 `list_sessions` 中，可通过 `status` 查看并再次调用 `close_session`。不存在的 ID 返回 `SESSION_NOT_FOUND`。

**入参**

```json
{ "action": "close_session", "sessionId": "debug-1" }
```

**结果示例**

```json
{
  "kind": "closed",
  "snapshot": {
    "state": { "state": "closed", "reason": { "kind": "requested" } },
    "configuration": { "name": "Launch API", "type": "go", "request": "launch" },
    "capabilities": {
      "supportsSingleThreadExecutionRequests": true,
      "supportsConditionalBreakpoints": true,
      "supportsHitConditionalBreakpoints": true,
      "supportsLogPoints": false,
      "supportsFunctionBreakpoints": true
    },
    "revision": 15,
    "threads": []
  }
}
```

尚未完成时返回 `kind: "closing"`。只有已经创建 `DebugSession` 时才包含 `snapshot`；若在 configuration 或 Adapter resolution 阶段关闭，则省略 `snapshot`。

### `set_breakpoints`

替换一个 source 文件的全部断点，不是在原有断点后追加。传空 `lines` 会清除该文件断点。每条断点可独立携带 `condition` / `hitCondition` / `logMessage`；缺少对应 capability 时直接返回 `INVALID_ARGUMENT`。

**入参**

```json
{
  "action": "set_breakpoints",
  "sessionId": "debug-1",
  "breakpoints": {
    "file": "main.go",
    "lines": [
      { "line": 10 },
      { "line": 42, "condition": "n > 5" },
      { "line": 55, "hitCondition": ">=3" },
      { "line": 77, "logMessage": "reached with x={x}" }
    ]
  }
}
```

`file` 必填，可为绝对路径或项目目录的相对路径；`lines` 必填，最多 100 项。每项 `line` 必填、从 1 开始，其它三个字段可选。

**结果示例**

```json
{
  "sourceBreakpoints": {
    "source": { "path": "/workspace/main.go" },
    "specs": [
      { "line": 10 },
      { "line": 42, "condition": "n > 5" }
    ],
    "breakpoints": [
      {
        "verified": true,
        "message": "Breakpoint verified",
        "source": { "path": "/workspace/main.go", "name": "main.go" },
        "line": 10,
        "column": 1
      },
      {
        "verified": true,
        "source": { "path": "/workspace/main.go", "name": "main.go" },
        "line": 42
      }
    ]
  }
}
```

`specs` 是本次请求提交的原始 spec 列表；`breakpoints` 是 Adapter 返回的 `DebugProtocol.Breakpoint` 数组，两者按请求顺序对齐。清空该文件断点时 `specs` 为 `[]`，`breakpoints` 由 Adapter 决定。

### `set_function_breakpoints`

替换全局函数断点列表。列表是整体替换，不按调用叠加；传 `[]` 会清空所有函数断点。需要 Adapter 汇报 `supportsFunctionBreakpoints`；`condition` / `hitCondition` 的能力要求与 `set_breakpoints` 一致。

**入参**

```json
{
  "action": "set_function_breakpoints",
  "sessionId": "debug-1",
  "functionBreakpoints": [
    { "name": "main" },
    { "name": "handleRequest", "condition": "req.method == 'POST'" },
    { "name": "retry", "hitCondition": ">=3" }
  ]
}
```

`functionBreakpoints` 必填，最多 100 项。`name` 的匹配语义由 Adapter 决定（可能接受重载、限定或 mangled 名）。

**结果示例**

```json
{
  "functionBreakpoints": {
    "specs": [
      { "name": "main" },
      { "name": "retry", "hitCondition": ">=3" }
    ],
    "breakpoints": [
      { "verified": true, "id": 11 },
      { "verified": false, "message": "No function matched 'retry'." }
    ]
  }
}
```

`specs` 是本次请求提交的函数断点列表；`breakpoints` 与其一一对应，字段来自 DAP `SetFunctionBreakpointsResponse.body`。清空所有函数断点时 `specs` 为 `[]`。

### `list_breakpoints`

返回指定 session 内已安装的全部断点，覆盖 source、function、exception 三类。不会向 Adapter 发起新的请求，仅返回 session 自身通过历次 `start` / `set_breakpoints` / `set_function_breakpoints` 累积的记录，并按 DAP `breakpoint` 事件同步 `verified`、`message` 等状态。session 尚未创建 `DebugSession` 时返回 `INVALID_STATE`；session 处于 `closing` / `closed` 时依然可读，反映最后一次安装的快照。

**入参**

```json
{ "action": "list_breakpoints", "sessionId": "debug-1" }
```

**结果示例**

```json
{
  "source": [
    {
      "source": { "path": "/workspace/main.go" },
      "specs": [
        { "line": 10 },
        { "line": 42, "condition": "n > 5" }
      ],
      "breakpoints": [
        { "verified": true, "id": 1, "line": 10 },
        { "verified": true, "id": 2, "line": 42 }
      ]
    }
  ],
  "function": {
    "specs": [
      { "name": "handleRequest" }
    ],
    "breakpoints": [
      { "verified": true, "id": 11 }
    ]
  },
  "exception": {
    "filters": ["uncaught"],
    "breakpoints": [
      { "verified": true }
    ]
  }
}
```

`source` 始终存在，无 source 断点时为 `[]`；`function` 只在存在函数断点时出现；`exception` 只在启动时下发了 exception filter 时出现，Adapter 未返回状态时省略其中的 `breakpoints`。结构与 `start` / `set_breakpoints` / `set_function_breakpoints` 返回的相应字段保持一致。

### `continue`

从 stopped 线程继续执行。默认请求继续所有线程；`singleThread: true` 只请求恢复选中的线程，并要求 Adapter 支持 `supportsSingleThreadExecutionRequests`。

**入参**

```json
{
  "action": "continue",
  "sessionId": "debug-1",
  "threadId": 1,
  "singleThread": false,
  "waitMs": 5000
}
```

**结果示例**

见 ExecutionOutcome

### `next`

在 stopped 线程上 step over。线程选择、`singleThread` 和等待语义与 `continue` 相同。

**入参**

```json
{ "action": "next", "sessionId": "debug-1", "threadId": 1, "singleThread": false, "waitMs": 5000 }
```

**结果示例**

见 ExecutionOutcome

### `step_in`

在 stopped 线程上 step into。线程选择、`singleThread` 和等待语义与 `continue` 相同。

**入参**

```json
{ "action": "step_in", "sessionId": "debug-1", "threadId": 1, "singleThread": false, "waitMs": 5000 }
```

**结果示例**

见 ExecutionOutcome

### `step_out`

在 stopped 线程上 step out。线程选择、`singleThread` 和等待语义与 `continue` 相同。

**入参**

```json
{ "action": "step_out", "sessionId": "debug-1", "threadId": 1, "singleThread": false, "waitMs": 5000 }
```

**结果示例**

见 ExecutionOutcome

### `pause`

中断一个 running 线程，然后等待该线程停止、退出、session 关闭或超时。省略 `threadId` 时必须恰好只有一个可暂停线程。

**入参**

```json
{ "action": "pause", "sessionId": "debug-1", "threadId": 1, "waitMs": 5000 }
```

**结果示例**

```json
{
  "kind": "stopped",
  "thread": {
    "id": 1,
    "name": "main",
    "state": "stopped",
    "revision": 20,
    "stop": { "reason": "pause" }
  }
}
```

结果也可能是其他公共执行结果。

### `wait`

不发出执行命令，只等待新的 stop、线程退出或 session 完成关闭。提供 `revision` 时以它为基线，只返回严格晚于它的事件；省略则记录调用开始时的 revision 为基线。省略 `threadId` 时等待任意新 stop 或关闭；指定时只观察该线程或关闭。session 已 closed 时立即返回。

**入参**

```json
{ "action": "wait", "sessionId": "debug-1", "threadId": 1, "revision": 12, "waitMs": 10000 }
```

**结果示例**

见 ExecutionOutcome

### `threads`

向 Adapter 刷新线程，并返回 active 线程的分页列表。stopped 线程携带引起此次 stop 的 `revision`，可直接作为 `stack_trace` / `variables` / `evaluate` 的 `revision` 传入。

**入参**

```json
{ "action": "threads", "sessionId": "debug-1", "start": 0, "count": 50 }
```

**结果示例**

```json
{
  "start": 0,
  "items": [
    { "id": 1, "name": "main", "state": "running" },
    {
      "id": 2,
      "name": "worker",
      "state": "stopped",
      "revision": 12,
      "stop": { "reason": "breakpoint", "allThreadsStopped": false }
    }
  ],
  "nextStart": 2,
  "total": 8
}
```

### `stack_trace`

返回一个 stopped 线程的调用栈分页。`frameIndex` 字段是可用于 `variables` 和 `evaluate` 的 zero-based 栈位置。可选传入 `revision` 防止线程已恢复后仍使用旧的 stop。

**入参**

```json
{ "action": "stack_trace", "sessionId": "debug-1", "threadId": 1, "revision": 12, "start": 0, "count": 20 }
```

**结果示例**

```json
{
  "threadId": 1,
  "revision": 12,
  "stack": {
    "start": 0,
    "items": [
      {
        "frameIndex": 0,
        "name": "main.handle",
        "source": { "path": "/workspace/main.go", "name": "main.go" },
        "line": 42,
        "column": 3
      }
    ],
    "nextStart": 1,
    "total": 6
  }
}
```

### `variables`

读取 scope 或某个可展开变量的直接子项。返回的正数 `variablesReference` 可用于继续展开，但只在当前 stop 状态有效；线程恢复或状态变化后不能复用。

**入参：按 scope 读取** frameIndex + scope

```json
{
  "action": "variables",
  "sessionId": "debug-1",
  "threadId": 1,
  "revision": 12,
  "frameIndex": 0,
  "scope": "Locals",
  "start": 0,
  "count": 50
}
```

`frameIndex` 默认 `0`，`scope` 默认 `locals`，scope 名大小写不敏感；`revision` 可选，提供后则验证线程仍处于同一次 stop。

**入参：展开变量** variablesReference

```json
{
  "action": "variables",
  "sessionId": "debug-1",
  "threadId": 1,
  "revision": 12,
  "variablesReference": 2001,
  "start": 0,
  "count": 50
}
```

`variablesReference` 不能与 `frameIndex` 或 `scope` 同时提供；此分支下 `revision` 必填。

**结果示例**

```json
{
  "threadId": 1,
  "revision": 12,
  "variables": {
    "start": 0,
    "items": [
      { "name": "count", "value": "3", "type": "int" },
      {
        "name": "user",
        "value": "main.User {...}",
        "type": "main.User",
        "variablesReference": 2001,
        "namedVariables": 2
      }
    ],
    "nextStart": 2
  }
}
```

### `evaluate`

在 stopped 线程的选中 frame 中以 DAP `watch` context 求值一组表达式。表达式按数组顺序串行发起 Adapter 请求，共享同一 stop 上下文；表达式可能调用函数或修改状态，前一个表达式的副作用会被后续表达式观察到，因此默认应使用只读表达式。

**入参**

```json
{
  "action": "evaluate",
  "sessionId": "debug-1",
  "threadId": 1,
  "revision": 12,
  "frameIndex": 0,
  "expressions": ["a + b", "user.name"]
}
```

`expressions` 必填，为长度 1..20 的字符串数组，每项非空；`frameIndex` 默认 `0`；`revision` 可选，提供后验证线程仍处于同一次 stop。

**结果示例**

```json
{
  "threadId": 1,
  "revision": 12,
  "results": [
    {
      "expression": "a + b",
      "value": "5",
      "type": "int"
    },
    {
      "expression": "user.name",
      "value": "\"alice\"",
      "type": "string",
      "variablesReference": 2001,
      "namedVariables": 2
    },
    {
      "expression": "missing",
      "error": { "code": "EVALUATE_FAILED", "message": "undefined identifier 'missing'" }
    }
  ]
}
```

`results` 与入参 `expressions` 等长且同序，每一项显式回填 `expression` 原文。成功项字段与 `variables` 项一致：`variablesReference` 大于 0 时可用于继续 `variables` 展开，只在当前 stop 状态有效。单个表达式失败时该项以 `{ expression, error: { code, message } }` 结构记录，其余表达式继续求值；批中途若线程恢复或被新 stop 覆盖，整批立即中止并返回 `STALE_REVISION`。

### `output`

读取内存中的 debuggee output event。buffer 最多保留最近 1000 个 event。可按 DAP category 精确过滤，例如 `stdout`、`stderr`、`console`、`important` 或 `telemetry`。`start` 在过滤后应用。

adapter 通过 DAP `runInTerminal` 启动的 integrated terminal 输出也进入该 buffer，category 固定为 `console`。PTY 会合并 stdout 和 stderr；当前不支持向 terminal 输入，也不支持 external terminal 或 shell 参数解释。

**入参**

```json
{
  "action": "output",
  "sessionId": "debug-1",
  "category": "stdout",
  "start": 0,
  "count": 50
}
```

**结果示例（纯文本，不是 JSON）**

```text
stdout | server listening on :8080
stdout | request completed

[debug: Showing output events 1-2 of 7. Use start=2 to continue.]
```

每行格式为 `<category> | <内容>`；event 没有 category 时使用 `output`。没有更多分页时不附加提示，完全没有输出时返回空文本。控制字符会被转义，换行会被保留。
