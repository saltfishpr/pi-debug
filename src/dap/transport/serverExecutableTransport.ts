import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { DapConnectionError } from "../util/errors";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import { TcpTransport } from "./tcpTransport";
import { Transport } from "./transport";

export interface ServerExecutableOptions {
  /** Executable that starts a DAP server listening on a TCP port. */
  command: string;
  /**
   * Arguments passed to the executable. The literal token `${port}` in any
   * argument is replaced with the resolved port before spawning.
   */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  host?: string;
  /**
   * Port to connect to. Use the literal string `${port}` to let the client
   * pick a free port and inject it into the arguments.
   */
  port: number | "${port}";
  /** Milliseconds to wait for the server to accept connections. Default 5000. */
  connectTimeoutMs?: number;
  logger?: Logger;
}

/**
 * Launches an adapter that runs as a TCP server, then connects to it. This
 * mirrors nvim-dap's "server adapter with an executable": spawn the process,
 * wait for it to listen, and connect. The spawned process is torn down when
 * the transport is disposed.
 */
export class ServerExecutableTransport extends Transport {
  private child?: ChildProcess;
  private inner?: TcpTransport;
  private resolvedPort?: number;
  private readonly logger: Logger;

  constructor(private readonly options: ServerExecutableOptions) {
    super();
    this.logger = options.logger ?? noopLogger;
  }

  async connect(): Promise<void> {
    const port = this.options.port === "${port}" ? await pickFreePort() : this.options.port;
    this.resolvedPort = port;
    const args = (this.options.args ?? []).map((arg) => arg.replace(/\$\{port\}/g, String(port)));

    this.logger.debug("Spawning server-executable adapter", this.options.command, args);
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.once("error", (err) => this.emit("error", err));
    child.stdout?.on("data", (chunk: Buffer) => this.logger.trace("adapter stdout", chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.emit("stderr", chunk));

    const inner = new TcpTransport({
      host: this.options.host,
      port,
      // Poll while the freshly spawned server comes up.
      maxAttempts: Math.ceil((this.options.connectTimeoutMs ?? 5000) / 250),
      retryDelayMs: 250,
      logger: this.logger,
    });
    this.inner = inner;

    inner.on("error", (err) => this.emit("error", err));
    inner.on("data", (chunk) => this.emit("data", chunk));
    inner.on("close", () => this.emit("close"));

    try {
      await inner.connect();
    } catch (err) {
      this.dispose();
      throw new DapConnectionError(`Server-executable '${this.options.command}' did not become reachable: ${(err as Error).message}`, { cause: err });
    }
  }

  override getEndpoint(): { host: string; port: number } | undefined {
    if (this.resolvedPort === undefined) {
      return undefined;
    }
    return { host: this.options.host ?? "127.0.0.1", port: this.resolvedPort };
  }

  write(data: Buffer): void {
    if (!this.inner) {
      throw new DapConnectionError("Cannot write: server-executable transport is not connected");
    }
    this.inner.write(data);
  }

  dispose(): void {
    this.inner?.dispose();
    this.inner = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

/** Ask the OS for an unused TCP port by binding to port 0. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire a free port")));
      }
    });
  });
}
