/**
 * dap-client — a TypeScript Debug Adapter Protocol client.
 *
 * Architecture (top → bottom):
 *
 *   SessionManager  → owns adapters + all live sessions, tracks the active one
 *        │
 *   Session         → one debug session: init/launch handshake, state, breakpoints
 *        │
 *   DapClient       → request/response correlation, event & reverse-request dispatch
 *        │
 *   Transport       → raw bytes over stdio / TCP / server-executable
 *
 * This barrel intentionally exposes only the common public API. Advanced
 * internals (protocol codec, transport factory, request/event type maps, the
 * abstract Transport base, ...) remain importable via their subpaths, e.g.
 * `import { MessageParser } from 'dap-client/dist/protocol'`.
 *
 * All protocol data structures come from `@vscode/debugprotocol`; this package
 * defines none of its own.
 */

// Protocol types — a single import surface for consumers.
export type { DebugProtocol } from "@vscode/debugprotocol";

// Primary API: manage and drive debug sessions.
export { Session, SessionManager, SessionState } from "./session";
export type {
  DebugConfiguration,
  RunInTerminalHandler,
  SessionEvents,
  SessionManagerEvents,
  SessionManagerOptions,
  SessionStartOptions,
  StartSessionOptions,
  ThreadInfo,
} from "./session";

// Adapter definitions used to register/reach adapters.
export type { AdapterDefinition, AdapterFactory, AdapterProvider, ExecutableAdapter, ServerAdapter } from "./transport";

// Lower-level client + transports (optional; SessionManager uses them for you).
export { DapClient } from "./client";
export type { DapClientEvents, DapClientOptions, RequestOptions, ReverseRequestHandler } from "./client";
export { ServerExecutableTransport, StdioTransport, TcpTransport } from "./transport";
export type { ServerExecutableOptions, StdioTransportOptions, TcpTransportOptions } from "./transport";

// Utility classes.
export { DapConnectionError, DapResponseError, DapTimeoutError } from "./util/errors";
export { ConsoleLogger, LogLevel } from "./util/logger";
export type { Logger } from "./util/logger";
