# src/dap/AGENTS.md

Guidance for AI coding agents working in this package. Read this before editing.

## What this is

`src/dap` is a lightweight, editor-agnostic **Debug Adapter Protocol (DAP)** client for Node.js and the browser. It was designed from first principles (inspired by, but not a copy of, VS Code's `rawDebugSession.ts`). Core goals, in priority order:

1. **Protocol correctness** — behavior is benchmarked against VS Code's `RawDebugSession` command/event/capability set.
2. **Zero UI/editor coupling** — the core must never depend on any editor, DOM, or UI concept.
3. **KISS** — no runtime dependencies except `@vscode/debugprotocol` for types; no clever abstractions without a concrete need.
4. **Layered & testable** — strict one-directional dependencies between layers.

## Hard rules (do not violate)

- **Never redefine DAP data structures.** All request/response/event/capability types come from `@vscode/debugprotocol` (imported as `import type { DebugProtocol } from '@vscode/debugprotocol'`). Do not hand-write protocol interfaces.
- **Respect the layer dependency direction** (see below). A lower layer must never import a higher one.
- **Keep the core free of Node built-ins.** Only files under `transport/node/**` may import `node:*` (`child_process`, `net`, `stream`). Everything else must run in a browser too.
- **No UI / editor / telemetry in core.** Reverse requests (`runInTerminal`, `startDebugging`, …) and error presentation are delegated to the embedder via callbacks. Observability goes through the neutral `DapTracer` hook — do not add logging/notifications/telemetry directly.
- **Comments:** default to none. At most one short line where intent is non-obvious. Do not add multi-line comment blocks or docstrings. Preserve the existing "why" comments (e.g. the ordered-dispatch task-boundary note in `connection.ts`, the `stepping`/simulated-continued quirk) — they document real hazards.
- **ESM only.** `package.json` has `"type": "module"`; every relative import must include the `.js` extension (e.g. `import { Emitter } from './events.js'`). This is enforced by `verbatimModuleSyntax`.
- Do not `git commit`, create branches, or bump the version unless explicitly asked.

## Architecture & layers

Dependencies point strictly downward. When adding code, put it in the lowest layer that suffices.

```
Layer 4  client.ts, capabilities.ts   DebugClient: typed methods, capability gating,
                                       state machine, typed events, reverse requests, quirks
Layer 3  connection.ts                 DapConnection: seq, request→Promise, timeout/abort,
                                       ordered dispatch, event/reverse-request routing (command-agnostic)
Layer 2  transport/                    DapTransport interface + InMemoryTransport (portable);
                                       node/{stdio,socket,stream}.ts (Node-only)
Layer 1  codec.ts                      Content-Length framing (pure, I/O-free)
Layer 0  @vscode/debugprotocol         protocol types (external)
support  events.ts, errors.ts          multi-subscriber Emitter, typed error model
```

Key invariants per layer:
- **codec.ts**: pure functions/classes, no I/O, no imports besides types + `errors`. Must tolerate arbitrary byte-chunk boundaries.
- **connection.ts**: knows nothing about specific DAP commands. Never add command-specific logic here. Capability gating lives in Layer 4.
- **client.ts**: the only place that knows command names and capabilities. Capability preconditions are declared in `capabilities.ts` (`CAPABILITY_BY_COMMAND`) and enforced by the single `guarded()` path — do not scatter `if (caps.supportsX)` checks.

## Where to make common changes

- **Add/verify a DAP request method** → `client.ts`. If it requires a capability, add the mapping to `CAPABILITY_BY_COMMAND` in `capabilities.ts` and call `this.guarded(...)`; otherwise call `this.connection.sendRequest(...)`. Methods whose args lack `threadId` but resume execution (like `restartFrame`) take `threadId` as a separate param and go through `stepping()` so the continued-event quirk applies.
- **Add/handle a DAP event** → `client.ts` `handleEvent()` switch + a corresponding `Emitter` in `emitters` and a public `onXxx` `EventSource`. Unknown events must fall through to `onCustomEvent`.
- **Add a transport** → implement `DapTransport` (`transport/types.ts`). Stream-based ones should extend `StreamTransport` (`transport/node/stream.ts`) and only provide the readable/writable pair + `teardown()`. Export Node transports from `transport/node/index.ts`; portable ones from `index.ts`.
- **Add a new public export** → add it to `index.ts`; nothing outside the package should reach into subpaths.

## Fidelity to VS Code

When touching protocol behavior, the source of truth is VS Code at
`../vscode/src/vs/workbench/contrib/debug/browser/rawDebugSession.ts` (plus `common/abstractDebugAdapter.ts`, `node/debugAdapter.ts`). If you add or change a command/event/capability rule, verify it against that file.

Intentional deviations from VS Code — do **not** "fix" these back to the UI-coupled approach:

- **Reverse requests** (`runInTerminal`, `startDebugging`) are delegated to the embedder via `reverseRequestHandler`; the core never talks to a terminal service.
- **Error presentation** is a plain typed error (`DapResponseError` etc.); no notification/message service.
- **Observability** goes through `DapTracer` instead of VS Code's telemetry service.
- **Cancellation** uses standard `AbortSignal` instead of `CancellationToken`.

## Build, typecheck, test (always run before finishing)

```bash
pnpm run typecheck   # tsc --noEmit (strict)
pnpm test            # vitest run
```

Both must pass. Do not mark work complete with failing tests or type errors. There is no separate `build` step — `pi-debug` is consumed as TypeScript sources via the `pi.extensions` entry.

## Testing conventions

- Framework: **vitest** (`test/*.test.ts` at the repo root, not inside this package).
- Prefer the in-process harness: `InMemoryTransport.createPair()` to script adapter behavior without spawning a process.
- If you need to exercise the real Node child-process transport, add a self-contained stdio mock adapter under `test/` and keep it dependency-free and framing-correct.
- Every new request method / event / behavior should get a test. Regressions found while implementing should be pinned by a test (e.g. the `onInitializedOnce` latch, `terminate`→`disconnect` fallback).

## Gotchas

- **Ordered dispatch**: `DapConnection.drain()` yields a task boundary between inbound messages on purpose. Do not remove it — it prevents a synchronously-fired event from being observed before the `await` of the response that precedes it.
- **`onInitializedOnce()` is latched**: it resolves immediately if `initialized` already arrived. Preserve this; the `await initialize(); await onInitializedOnce()` pattern relies on it.
- **Auto-cancel gating**: aborting a request only emits a DAP `cancel` when `supportsCancelRequest` is set, wired via `connection.setCancelPredicate(...)` from the client. Keep the connection layer capability-agnostic (predicate injection, not direct capability access).
- **`Uint8Array` typing**: on TS 5.7+ `Uint8Array` is generic; `codec.ts` uses the `Bytes = Uint8Array<ArrayBufferLike>` alias to stay compatible. Reuse it rather than fighting the generic.
