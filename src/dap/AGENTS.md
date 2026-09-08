# src/dap/AGENTS.md

Guidance for AI coding agents working in this package. Keep changes consistent with the conventions below.

## What this is

A TypeScript **client** for the Debug Adapter Protocol (DAP). It connects to any DAP-compatible debug adapter and drives debug sessions. It is **not** an adapter/server implementation.

## Architecture (4 layers, top → bottom)

Data flows **down** for requests and **up** for adapter messages. Keep the layers isolated — do not leak concerns across them.

| Layer            | Files                                                           | Responsibility                                                                                                                                                |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionManager` | `src/dap/session/sessionManager.ts`                             | adapter registry, all live sessions, active-session focus, `startDebugging` children, `runInTerminal` delegation                                              |
| `Session`        | `src/dap/session/session.ts`, `src/dap/session/types.ts`        | `initialize → launch/attach → configurationDone` handshake, capabilities, thread/frame/scope/variable state, breakpoint sync, execution control, typed events |
| `DapClient`      | `src/dap/client/dapClient.ts`, `src/dap/client/protocolMaps.ts` | seq numbers, request/response correlation, event dispatch, reverse-request handling                                                                           |
| `Transport`      | `src/dap/transport/*.ts`                                        | raw bytes only: stdio / TCP / server-executable                                                                                                               |
| codec            | `src/dap/protocol/messageCodec.ts`                              | `Content-Length` framing (`MessageParser`, `encodeMessage`)                                                                                                   |
| utils            | `src/dap/util/*.ts`                                             | `TypedEventEmitter`, `Deferred`, `Logger`, error classes                                                                                                      |

Public API surface is curated in `src/dap/index.ts` (KISS — only key APIs). Internals are reachable via subpaths but are intentionally kept out of the barrel.

## How to extend

- **New DAP request/response:** add to `RequestTypeMap`, then (if it's part of the high-level API) add a typed convenience method on `Session`. Custom/vendor commands can go through `session.request(command, args)` / `client.sendRequest(command, args)` without a map entry (falls back to `unknown`).
- **New transport:** subclass `Transport` (implement `connect`/`write`/`dispose`, fire `data`/`stderr`/`close`/`error`), extend the `AdapterDefinition` union in `src/dap/transport/adapter.ts`, and wire it in `createTransport`.
- **New session event:** add to `SessionEvents` in `src/dap/session/types.ts`, subscribe in `Session.registerClientListeners`, and re-emit.

## Gotchas

- The `initialized` **event** (adapter → client) triggers configuration; do not confuse it with the `initialize` **request**. Configuration (`setBreakpoints`, `setExceptionBreakpoints`, `configurationDone`) happens on that event, gated by capabilities.
- Sequence numbers are shared across outgoing requests and reverse-request responses; only `DapClient` assigns them.
- Buffer typing: keep `MessageParser.rawData` annotated as `Buffer` (Node's generic `Buffer` typing otherwise causes `ArrayBufferLike` mismatches).
- `tsconfig` targets ES2022 (needed for `Error` `cause`); keep it there.
