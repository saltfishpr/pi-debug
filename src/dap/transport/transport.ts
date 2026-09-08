import { TypedEventEmitter } from "../util/typedEmitter";

export type TransportEvents = {
  /** A chunk of raw bytes received from the adapter. */
  data: [Buffer];
  /** Diagnostic output the adapter wrote to a side channel (e.g. stderr). */
  stderr: [Buffer];
  /** The connection has closed; no further data will arrive. */
  close: [];
  /** A transport-level error occurred. */
  error: [Error];
};

/**
 * A bidirectional byte stream to a single debug adapter.
 *
 * Transports are deliberately protocol-agnostic: they move raw bytes and know
 * nothing about the DAP framing. Framing is handled one layer up by
 * {@link DapClient} via {@link MessageParser}.
 */
export abstract class Transport extends TypedEventEmitter<TransportEvents> {
  /** Establish the connection. Resolves once the transport is ready to use. */
  abstract connect(): Promise<void>;

  /** Write raw bytes to the adapter. */
  abstract write(data: Buffer): void;

  /** Tear down the connection and release all resources. */
  abstract dispose(): void;

  /**
   * The TCP endpoint this transport is connected to, if it is TCP-based.
   * Used to let a `startDebugging` child session reconnect to a shared server.
   */
  getEndpoint(): { host: string; port: number } | undefined {
    return undefined;
  }

  // `emit` is protected on TypedEventEmitter; expose a narrow surface so the
  // concrete transports (which live in this module) can fire their events.
  protected fire<K extends keyof TransportEvents & string>(event: K, ...args: TransportEvents[K]): void {
    this.emit(event, ...args);
  }
}
