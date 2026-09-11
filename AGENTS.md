# AGENTS.md

本文件为在本仓库工作的 AI 编码 agent 提供指引。动手前请通读一遍；编辑 `src/dap/**` 前另需先读 `src/dap/AGENTS.md`。

## 这是什么

`pi-debug` 是一个 **Pi 扩展（pi extension）**，它把 VS Code 的 **Debug Adapter Protocol（DAP）** 封装成 Pi Agent 可以调用的**单一 `debug` 工具**，让 Agent 能像人用 IDE 调试器那样：启动程序、下断点、单步、在停点处读取真实的变量与表达式，从而"观察运行时事实"而非"从源码猜测"。

一切设计从三条原理推导：

1. **消费者是 LLM，不是人**。所以：一次工具调用只做一件事（一个 `action`）；每个结果都回显后续调用所需的句柄（`sessionId` / `threadId` / `[frameId=N]` / `[ref=N]`）；所有输出都有预算上限并显式标注截断，绝不撑爆上下文窗口。
2. **协议正确性对标 VS Code**。DAP 类型只用 `@vscode/debugprotocol`，不自造；命令/事件/能力门控的行为以 VS Code 的 `RawDebugSession` 为准（细节见 `src/dap/AGENTS.md`）。
3. **严格分层、依赖单向向下、KISS**。协议核心与编辑器/UI/终端零耦合；宿主相关的副作用（拉起进程、开终端）只发生在最外层的装配代码里。

## 顶层心智模型（一次调用怎么流动）

```
Pi Agent ──(debug 工具调用: action + 参数)──▶ src/tool.ts
                                                 │  翻译成一次 L5 方法调用，再用 format.ts 渲染结果文本
                                                 ▼
                                          src/session/  (Layer 5)
                                          SessionManager ─装配─▶ DebugSession（单会话生命周期/状态机）
                                                 │  复用 L4，不重写协议
                                                 ▼
                                          src/dap/  (Layer 0–4)
                                          DebugClient → DapConnection → DapTransport → codec
                                                 │
                                                 ▼
                                          调试适配器进程：dlv dap / js-debug-dap / debugpy.adapter
```

配置来源：`.vscode/launch.json` 或 `.pi/launch.json`（**launch 配置**，决定调试什么）+ `.pi/debug.json`（**适配器调用参数**，决定用什么命令拉起调试器）。

## 目录导航（按"改哪个文件"组织）

新增代码请放进**能满足需求的最低层**。

- `src/index.ts` — 扩展入口（`package.json` 的 `pi.extensions` 指向它）。构造 `SessionManager`、注册 `debug` 工具；在 `session_start` 事件里加载两类配置、按 launch 配置里的 `type` 注册内置适配器工厂（`ADAPTER_FACTORIES` = go/node/python）、并按"是否存在 launch 配置"启用或隐藏 `debug` 工具；在 `session_shutdown` 里释放全部会话。
- `src/tool.ts` — 唯一的 `debug` 工具。参数 schema、`action` 分派、结果格式化全部内联在 `execute`。非法用法抛可操作的 `Error`。**工具的 `description` / `promptGuidelines` 是喂给 LLM 的提示词，改行为时必须同步维护。**
- `src/format.ts` — 把 L5 的结构化结果渲染成紧凑、自解释的文本。两条铁律：(1) 每个结果都回答"我在哪、下一步能做什么"并回显句柄；(2) 输出有预算（`MAX_FRAMES` / `MAX_VARS` / `MAX_OUTPUT_LINES` / `MAX_VALUE_CHARS`），超出显式标注截断。
- `src/session/` — **Layer 5**，Agent 面向的会话层，补上 L4 刻意省略的两件事：显式的 running/stopped 状态机，与一致的"停在哪"快照。
  - `manager.ts` — `SessionManager`：适配器注册表、装配 `transport → connection → client → session` 栈、按 id 跟踪会话并维护 active 指针、为 `startDebugging` 反向请求派生子会话、回收死会话。唯一 `new DapConnection` / `new DebugClient` 的地方。
  - `session.ts` — `DebugSession`：单会话从生到死。DAP 握手编排、状态机、事件→await 桥接（`continueAndWait` / `stepX` 在**下一次 stop** 时才 resolve）、带失效机制的 stop 快照、路径寻址的断点模型。
  - `types.ts` — 会话层类型：`SessionState`、`ResumeOutcome`、`StopSnapshot`、`DebugSessionContext`、`SessionManagerOptions`。
  - `adapters.ts` — Node-only 通用工厂（`commandAdapter` / `serverAdapter` / `pipeAdapter` / `spawnServerAdapter`），只包一层对应 transport。
- `src/adapters.ts` — 内置 go/node/python 工厂 + `nodeRunInTerminal`。attach/remote（带 `port`）走 `SocketTransport`，否则 spawn 本地适配器走 `StdioTransport`。唯一决定"某个 `type` 如何被拉起"的地方。
- `src/config.ts` — 加载 `<cwd>/.pi/debug.json`（适配器 `command`/`args` 覆盖）。缺文件→空配置；解析/schema 错误连同路径抛出（zod + jsonc-parser）。
- `src/launchConfig.ts` — 加载并合并 `.vscode/launch.json` 与 `.pi/launch.json`（同名后者覆盖），解析 `${workspaceFolder}` / `${workspaceFolderBasename}` / `${env:NAME}` 变量。
- `src/dap/` — **Layer 0–4，DAP 协议核心。改动前必读 `src/dap/AGENTS.md`**（含分层不变量、VS Code 对标规则、ESM `.js` 约束、诊断/错误通道分离等硬性规则）。

## 常见改动落在哪

- **新增/修改一个 `action`** → `src/tool.ts`（`action` 枚举 + 参数 schema + `execute` 分支 + `description` 同步维护）＋ `src/format.ts` 加对应 formatter；若需新会话能力，先在 `src/session/session.ts` 暴露方法。
- **支持一种新语言/调试器** → `src/adapters.ts` 加 `createXxxAdapterFactory`，并在 `src/index.ts` 的 `ADAPTER_FACTORIES` 按 `type` 注册；attach/remote 与 launch 的分流照现有写法。
- **改会话生命周期/状态机/停点快照** → `src/session/session.ts`。
- **改协议命令/事件/能力门控/传输** → `src/dap/**`，遵循 `src/dap/AGENTS.md`。
- **改配置文件格式** → `src/config.ts`（`.pi/debug.json`）或 `src/launchConfig.ts`（launch 配置）。

## 必须遵守的不变量（勿违反）

- **UI / 编辑器 / 终端零耦合**。核心永不直接开终端或发通知：`runInTerminal` 交给宿主的 `nodeRunInTerminal`，`startDebugging` 交给 `SessionManager` 派生子会话，均经 `DebugSessionContext` 回调注入。
- **句柄由会话拥有，Agent 只回传**。`frameId` / `variablesReference` 等易失句柄在每次 stop 时可能失效（见 `invalidateStop` / `stopGeneration`）。工具层不发明数字 id，只回显并复用会话给出的句柄。
- **握手不要"先 await launch 再配置"**。`configureAndStart` 故意不等 launch/attach 完成就并行推进"断点 + configurationDone"，以规避部分适配器的 launch↔configurationDone 死锁。保留该顺序及注释。
- **恢复类操作在下一次 stop/exit 才 resolve**，且带 `defaultWaitTimeoutMs`（默认 30s）超时 → 返回 `timeout` 结果而非 hang。
- **诊断输出不是致命错误**。适配器的 stderr 是**非致命诊断**，经传输层的 `onDiagnostic` → `DapTracer.onDiagnostic` 暴露，**绝不关闭连接**；只有流错误 / 帧解析失败 / 进程/套接字关闭这类**致命**情况才通过 `onError` / `onClose` 走 `shutdown`。不要把 stderr 重新接回致命路径。
- **ESM only**：`"type": "module"` + `verbatimModuleSyntax`，所有相对 import 必须带 `.js` 后缀。
- **Node 内建的边界**：只有 `src/dap/transport/node/**`、`src/adapters.ts`、`src/config.ts`、`src/launchConfig.ts` 等宿主/装配层可 import `node:*`；`src/dap` 核心与 `src/session` 类型层要能在浏览器跑。
- **注释**：默认不写；至多在意图不明处写一行短注释；保留解释"为什么"的既有注释；不写多行注释块 / docstring。
- 未经明确要求，不要 `git commit`、不建分支、不改版本号。

## 校验（完成前必须运行）

```bash
pnpm install         # 首次工作前安装依赖（仓库初始不含 node_modules）
pnpm run typecheck   # tsc --noEmit（strict），必须 0 报错
pnpm test            # vitest run
```

**没有独立 build 步骤**——`pi-debug` 以 TypeScript 源码经 `pi.extensions` 入口被消费。

关于测试的**当前真实状态（勿误信旧描述）**：仓库**目前没有任何测试文件**，因此 `pnpm test` 会以 “No test files found” 非零退出。这是已知缺口，不是你引入的回归。新增测试时（强烈建议为改动补测试）遵循下节约定；`tsconfig.json` 的 `include` 已把 `test/**/*.ts` 纳入，直接在仓库根建 `test/` 即可。

## 测试约定（当你新增测试时）

- 框架 **vitest**，测试放在仓库根的 `test/*.test.ts`（不放进各 package 内部）。
- 优先用进程内 harness `InMemoryTransport.createPair()` 脚本化适配器行为，避免真的 spawn 进程。
- 若要覆盖真实的 Node 子进程传输，在 `test/` 下加一个自包含、无依赖、帧正确的 stdio mock 适配器。
- 每新增一个 request 方法 / 事件 / 行为都应配测试；实现中发现的回归用测试钉死（如 codec 分块边界、`DapConnection.drain` 有序性、`onInitializedOnce` latch、`terminate`→`disconnect` 回退、stderr 走诊断而不关连接）。

代码格式用 Prettier（`printWidth: 160`）。TS 开启 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`。

## 参考文档（按相关度）

本仓库依赖 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`。直接相关、优先阅读：

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension API、事件生命周期（`session_start`/`session_shutdown`）、`registerTool`、工具参数与结果、`getActiveTools`/`setActiveTools`。**本仓库最相关的一篇。**
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md` — pi package 的扩展入口与运行时依赖约定。

需要更深上下文时再看（非本仓库核心）：`docs/tui.md`（自定义 UI，本仓库暂未用）、`docs/session-format.md`（pi 自身会话持久化，与本仓库的 `SessionManager` 无关，勿混淆）。

核对未公开行为时，直接查已安装版本的类型/运行时：

- `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` — 公开导出的类型与函数。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{types,loader,runner}.{d.ts,js}` — 扩展类型、加载与事件执行流程。
