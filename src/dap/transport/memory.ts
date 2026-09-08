import type { DebugProtocol } from "@vscode/debugprotocol";
import { Emitter } from "../events.js";
import type { DapTransport, TransportCloseEvent } from "./types.js";

/**
 * An in-memory, message-oriented transport.
 *
 * Two uses:
 *  - Embedding an in-process debug adapter (no serialization needed).
 *  - Testing: script adapter behaviour without spawning anything.
 *
 * Create a linked pair with {@link InMemoryTransport.createPair}; whatever one
 * side sends is delivered to the other side's `onMessage`.
 */
export class InMemoryTransport implements DapTransport {
  private readonly _onMessage = new Emitter<DebugProtocol.ProtocolMessage>();
  private readonly _onClose = new Emitter<TransportCloseEvent>();
  private readonly _onError = new Emitter<Error>();
  private peer?: InMemoryTransport;
  private started = false;
  private closed = false;

  readonly onMessage = this._onMessage.event;
  readonly onClose = this._onClose.event;
  readonly onError = this._onError.event;

  /** Create two linked transports representing the two ends of one channel. */
  static createPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async start(): Promise<void> {
    this.started = true;
  }

  send(message: DebugProtocol.ProtocolMessage): void {
    if (!this.started || this.closed || !this.peer) {
      return;
    }
    // Deliver asynchronously to mimic a real async channel.
    queueMicrotask(() => this.peer?._onMessage.fire(message));
  }

  /** Test helper: inject a message as if it arrived from the adapter. */
  receive(message: DebugProtocol.ProtocolMessage): void {
    queueMicrotask(() => this._onMessage.fire(message));
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._onClose.fire({ requested: true });
    this.peer?._onClose.fire({ requested: false });
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onError.dispose();
  }
}
