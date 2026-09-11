# src/dap/AGENTS.md

Guidance for AI coding agents working in this package. Read this before editing any file under `src/dap/**`.

## What this package

`src/dap` is a lightweight, **editor-agnostic Debug Adapter Protocol (DAP) client** for Node.js and the browser. It was designed from first principles (informed by, not copied from, VS Code's `rawDebugSession.ts`). Everything here follows four goals, in priority order:

1. **Protocol correctness** — behaviour is benchmarked against VS Code's `RawDebugSession` command/event/capability set.
2. **Zero UI / editor coupling** — the core must never depend on any editor, DOM, terminal, or UI concept.
3. **KISS** — no runtime dependency except `@vscode/debugprotocol` (types only); no abstraction without a concrete need.
4. **Layered & testable** — strictly one-directional dependencies between layers, so any piece can be exercised in isolation.

The consumer of this package is Layer 5 (`src/session`), which adds the running/stopped state machine and stop snapshots. This package deliberately stops one level below that: it gives you *typed protocol I/O*, not session semantics.

## Architecture & layers

Dependencies point **strictly downward**. When adding code, put it in the lowest layer that suffices; a lower layer must never import a higher one.

```
Layer 4  client.ts, capabilities.ts   DebugClient: typed methods, capability gating, state machine,
                                       typed events, reverse-request registration, adapter quirks
Layer 3  connection.ts                 DapConnection: seq, request→Promise, timeout/abort, ordered
                                       dispatch, event/reverse-request routing (command-agnostic)
Layer 2  transport/                    DapTransport interface + InMemoryTransport (portable);
                                       node/{stdio,socket,pipe,spawn-socket,stream}.ts (Node-only)
Layer 1  codec.ts                      Content-Length framing (pure, I/O-free)
Layer 0  @vscode/debugprotocol         protocol types (external)
support  events.ts, errors.ts          multi-subscriber Emitter, typed error model
```

Per-layer invariants:

- **codec.ts (L1)** — pure functions/classes, no I/O, no imports besides types + `errors`. Must tolerate arbitrary byte-chunk boundaries (the decoder buffers partial frames).
- **transport/ (L2)** — a transport is a duplex channel of *already-framed* messages. Byte framing is an internal detail of stream transports (`InMemoryTransport` needs none). The transport surface has three signals: `onMessage`, `onClose`, and the fatal `onError`, plus an **optional non-fatal `onDiagnostic`** (see the diagnostics rule below). Only `transport/node/**` may touch `node:*`.
- **connection.ts (L3)** — knows nothing about specific DAP commands. Owns seq numbers, correlates responses to request Promises, enforces ordered inbound dispatch, and routes events + reverse requests. Never add command-specific logic here.
- **client.ts (L4)** — the only place that knows command names and capabilities. Capability preconditions are declared once in `capabilities.ts` (`CAPABILITY_BY_COMMAND`) and enforced by the single `guarded()` path. Do not scatter `if (caps.supportsX)` checks.

## Hard rules (do not violate)

- **Never redefine DAP data structures.** All request/response/event/capability types come from `@vscode/debugprotocol` (`import type { DebugProtocol } from '@vscode/debugprotocol'`). Do not hand-write protocol interfaces.
- **Respect the layer direction.** No upward imports, ever.
- **Keep the core free of Node built-ins.** Only files under `transport/node/**` may import `node:*` (`child_process`, `net`, `stream`). Everything else must run in a browser too.
- **No UI / editor / terminal / telemetry in core.** Reverse requests (`runInTerminal`, `startDebugging`, …) are delegated to the embedder via registered handlers; the core never talks to a terminal. Error *presentation* is a plain typed error, not a notification. Observability goes through the neutral `DapTracer` hook — do not add logging/notifications/telemetry directly.
- **Diagnostics are not errors.** A child adapter's stderr is *non-fatal diagnostic output*: stream transports emit it via `onDiagnostic`, and `DapConnection` forwards it to `DapTracer.onDiagnostic` **without closing the connection**. Only genuinely fatal conditions — stream `error`, framing/JSON failure, process/socket close — go through `onError` / `onClose` and trigger `shutdown`. Never route stderr back into `onError`; doing so kills every session the moment an adapter logs a line.
- **ESM only.** `package.json` has `"type": "module"`; every relative import must include the `.js` extension (e.g. `import { Emitter } from './events.js'`). Enforced by `verbatimModuleSyntax`.
- **Comments:** default to none. At most one short line where intent is non-obvious. No multi-line comment blocks or docstrings. Preserve the existing "why" comments (the ordered-dispatch task-boundary note in `connection.ts`, the `stepping`/synthesized-continued quirk, the stderr-is-diagnostic note) — they document real hazards.
- Do not `git commit`, create branches, or bump the version unless explicitly asked.

## Where to make common changes

- **Add/verify a DAP request method** → `client.ts`. If it requires a capability, add the mapping to `CAPABILITY_BY_COMMAND` in `capabilities.ts` and call `this.guarded(...)`; otherwise call `this.connection.sendRequest(...)`. Methods whose args lack `threadId` but resume execution (like `restartFrame`) take `threadId` as a separate param and go through `stepping()` so the continued-event quirk applies.
- **Add/handle a DAP event** → `client.ts` `handleEvent()` switch + a corresponding `Emitter` in `emitters` and a public `onXxx` `EventSource`. Unknown events must fall through to `onCustomEvent`.
- **Add a transport** → implement `DapTransport` (`transport/types.ts`). Stream-based ones should extend `StreamTransport` (`transport/node/stream.ts`), providing only the readable/writable pair + `teardown()`; they inherit `onMessage`/`onError`/`onDiagnostic`/framing for free. Route any child stderr to `_onDiagnostic`, not `_onError`. Export Node transports from `transport/node/index.ts`; portable ones from `index.ts`.
- **Add a new public export** → add it to `index.ts`; nothing outside the package should reach into subpaths.

## Fidelity to VS Code

When touching protocol behaviour, the source of truth is VS Code:
`../vscode/src/vs/workbench/contrib/debug/browser/rawDebugSession.ts` (plus `common/abstractDebugAdapter.ts`, `node/debugAdapter.ts`). If you add or change a command/event/capability rule, verify it against that file.

Intentional deviations from VS Code — do **not** "fix" these back to the UI-coupled approach:

- **Reverse requests** (`runInTerminal`, `startDebugging`) are delegated to the embedder via registered handlers; the core never talks to a terminal service.
- **Error presentation** is a plain typed error (`DapResponseError` etc.); no notification/message service.
- **Observability** (protocol trace + adapter diagnostics) goes through `DapTracer` instead of VS Code's telemetry service.
- **Cancellation** uses standard `AbortSignal` instead of `CancellationToken`; a DAP `cancel` is emitted only when `supportsCancelRequest` is set (wired via `connection.setCancelPredicate`).

## Build, typecheck, test

```bash
pnpm install         # the repo ships without node_modules
pnpm run typecheck   # tsc --noEmit (strict) — must pass with zero errors
pnpm test            # vitest run
```

There is no separate `build` step — `pi-debug` is consumed as TypeScript sources via the `pi.extensions` entry.

**Current test reality (do not trust stale claims of an existing suite):** there are **no test files in the repository yet**, so `pnpm test` exits non-zero with "No test files found". That is a known gap, not a regression you introduced. Adding tests alongside your change is strongly encouraged; follow the conventions below.

## Testing conventions (for when you add tests)

- Framework **vitest**; tests live at the repo root in `test/*.test.ts` (not inside this package). `tsconfig.json` already includes `test/**/*.ts`.
- Prefer the in-process harness: `InMemoryTransport.createPair()` to script adapter behaviour without spawning a process. Use its `receive()` helper to inject inbound messages.
- If you must exercise the real Node child-process transport, add a self-contained, dependency-free, framing-correct stdio mock adapter under `test/`.
- Every new request method / event / behaviour should get a test. Pin regressions with a test — good candidates: codec chunk-boundary reassembly, `DapConnection.drain` ordering, the `onInitializedOnce` latch, the `terminate`→`disconnect` fallback, capability gating in `guarded()`, and stderr surfacing via `onDiagnostic` without closing the connection.

## Gotchas

- **Ordered dispatch**: `DapConnection.drain()` yields a task boundary between inbound messages on purpose. Do not remove it — it prevents a synchronously-fired event from being observed before the `await` of the response that logically precedes it.
- **`onInitializedOnce()` is latched**: it resolves immediately if `initialized` already arrived. Preserve this; the `await initialize(); await onInitializedOnce()` pattern relies on it.
- **Auto-cancel gating**: aborting a request only emits a DAP `cancel` when `supportsCancelRequest` is set, via `connection.setCancelPredicate(...)` from the client. Keep the connection layer capability-agnostic (predicate injection, not direct capability access).
- **Continued-event quirk**: some adapters never emit `continued` after a step/continue. When `quirks.synthesizeContinuedAfterStep` is on, `client.ts` synthesizes one *only if* no `stopped` arrived while the request was in flight (`stoppedSinceLastStep`). Keep that guard.
- **`Uint8Array` typing**: on TS 5.7+ `Uint8Array` is generic; `codec.ts` uses the `Bytes = Uint8Array<ArrayBufferLike>` alias to stay compatible. Reuse it rather than fighting the generic.
