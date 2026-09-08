import type { DebugProtocol } from "@vscode/debugprotocol";
import type { EventSource } from "../events.js";

/**
 * Layer 2 — Transport.
 *
 * A transport is a duplex channel of already-framed protocol *messages*.
 * Byte-level framing (the codec) is an internal detail of stream-based
 * transports; in-memory and message-oriented transports need no framing at all.
 *
 * The core (Layers 3–4) depends only on this interface, so stdio, TCP, named
 * pipe, in-process and WebSocket transports are all first-class and swappable.
 */
export interface DapTransport {
  /** Fired for every complete inbound message from the adapter. */
  readonly onMessage: EventSource<DebugProtocol.ProtocolMessage>;
  /** Fired once when the channel closes (process exit / socket end). */
  readonly onClose: EventSource<TransportCloseEvent>;
  /** Fired for transport-level (non-protocol) errors. */
  readonly onError: EventSource<Error>;

  /** Establish the connection / spawn the process. Resolves once writable. */
  start(): Promise<void>;
  /** Write an outbound message. Must be called only after `start()` resolves. */
  send(message: DebugProtocol.ProtocolMessage): void;
  /** Close the channel and release resources. Idempotent. */
  dispose(): Promise<void>;
}

export interface TransportCloseEvent {
  /** Process exit code, when the transport owns a child process. */
  readonly code?: number | null;
  /** Whether the close was requested via `dispose()`. */
  readonly requested: boolean;
}
