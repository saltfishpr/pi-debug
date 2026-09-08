import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Readable, Writable } from "node:stream";
import { encodeMessage, MessageDecoder } from "../../codec.js";
import { Emitter } from "../../events.js";
import type { DapTransport, TransportCloseEvent } from "../types.js";

/**
 * Shared base for transports that talk over a Node duplex byte stream
 * (a child process's stdio, a TCP socket, a named pipe, ...).
 *
 * Subclasses only provide the readable/writable pair and lifecycle hooks.
 */
export abstract class StreamTransport implements DapTransport {
  protected readonly _onMessage = new Emitter<DebugProtocol.ProtocolMessage>();
  protected readonly _onClose = new Emitter<TransportCloseEvent>();
  protected readonly _onError = new Emitter<Error>();
  private readonly decoder = new MessageDecoder();
  private writable?: Writable;
  private disposed = false;

  readonly onMessage = this._onMessage.event;
  readonly onClose = this._onClose.event;
  readonly onError = this._onError.event;

  abstract start(): Promise<void>;

  /** Subclasses call this once their streams are ready. */
  protected attach(readable: Readable, writable: Writable): void {
    this.writable = writable;
    readable.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.decoder.push(chunk)) {
          this._onMessage.fire(message);
        }
      } catch (err) {
        this._onError.fire(err as Error);
      }
    });
    readable.on("error", (err) => this._onError.fire(err));
    writable.on("error", (err) => this._onError.fire(err));
  }

  protected fireClose(event: TransportCloseEvent): void {
    this._onClose.fire(event);
  }

  send(message: DebugProtocol.ProtocolMessage): void {
    this.writable?.write(encodeMessage(message));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.teardown();
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onError.dispose();
  }

  /** Subclasses release their resources (kill process / end socket). */
  protected abstract teardown(): Promise<void>;
}
