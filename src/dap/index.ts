export type { DebugProtocol } from "@vscode/debugprotocol";

// Layer 1 — codec & primitives
export { encodeMessage, MessageDecoder } from "./codec.js";
export { Emitter, once, type Disposable, type EventSource, type Listener } from "./events.js";

// Errors
export {
  DapCancellationError,
  DapConnectionClosedError,
  DapError,
  DapProtocolError,
  DapResponseError,
  DapTimeoutError,
  DapUnsupportedError,
} from "./errors.js";

// Layer 2 — transport (portable implementations only; node ones live in ./node)
export { InMemoryTransport } from "./transport/memory.js";
export type { DapTransport, TransportCloseEvent } from "./transport/types.js";

// Layer 3 — connection
export { DapConnection, type DapConnectionOptions, type DapTracer, type ReverseRequest, type RequestOptions } from "./connection.js";

// Layer 4 — client
export { CAPABILITY_BY_COMMAND, mergeCapabilities } from "./capabilities.js";
export { DebugClient, type ClientState, type DebugClientOptions, type Quirks, type ReverseRequestHandler } from "./client.js";
