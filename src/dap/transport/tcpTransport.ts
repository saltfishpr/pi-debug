import { type Socket, connect as netConnect } from "node:net";
import { DapConnectionError } from "../util/errors";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import { Transport } from "./transport";

export interface TcpTransportOptions {
  /** Host to connect to. Defaults to `127.0.0.1`. */
  host?: string;
  /** TCP port the adapter listens on. */
  port: number;
  /** Number of connection attempts before giving up. Defaults to 1. */
  maxRetries?: number;
  /** Delay between retries in milliseconds. Defaults to 250. */
  retryDelayMs?: number;
  logger?: Logger;
}

/**
 * Talks to a debug adapter over TCP. This is the `server` adapter type: the
 * adapter is already listening on a port (started externally or via
 * {@link ServerExecutableTransport}).
 */
export class TcpTransport extends Transport {
  private socket?: Socket;
  private readonly host: string;
  private readonly logger: Logger;

  constructor(private readonly options: TcpTransportOptions) {
    super();
    this.host = options.host ?? "127.0.0.1";
    this.logger = options.logger ?? noopLogger;
  }

  async connect(): Promise<void> {
    const maxRetries = Math.max(1, this.options.maxRetries ?? 1);
    const retryDelayMs = this.options.retryDelayMs ?? 250;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        lastError = err as Error;
        this.logger.debug(`TCP connect attempt ${attempt}/${maxRetries} failed`, lastError.message);
        if (attempt < maxRetries) {
          await delay(retryDelayMs);
        }
      }
    }
    throw new DapConnectionError(`Could not connect to adapter at ${this.host}:${this.options.port}: ${lastError?.message}`, { cause: lastError });
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: this.host, port: this.options.port });

      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);

      socket.once("connect", () => {
        socket.off("error", onError);

        this.socket = socket;
        socket.on("error", (err) => this.emit("error", err));
        socket.on("data", (chunk: Buffer) => this.emit("data", chunk));
        socket.once("close", () => this.emit("close"));
        resolve();
      });
    });
  }

  override getEndpoint(): { host: string; port: number } | undefined {
    return { host: this.host, port: this.options.port };
  }

  write(data: Buffer): void {
    if (!this.socket) {
      throw new DapConnectionError("Cannot write: TCP transport is not connected");
    }
    this.socket.write(data);
  }

  dispose(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = undefined;
    socket.removeAllListeners("data");
    socket.destroy();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
