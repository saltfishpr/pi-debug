import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { StreamTransport } from "./stream.js";

export interface SubprocessSocketTransportOptions {
  /** Executable that starts the DAP server (e.g. 'dlv', 'node', an absolute path). */
  command: string;
  /**
   * Arguments for the server process. When `port` is omitted the transport
   * allocates a free port and substitutes the `${host}` / `${port}` placeholders
   * here before spawning, e.g. ["dap", "--listen=${host}:${port}"].
   */
  args?: readonly string[];
  /** Working directory for the spawned server. */
  cwd?: string;
  /** Extra environment variables, merged over the current process env. */
  env?: Readonly<Record<string, string>>;

  /** Host the server listens on / we connect to. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * Fixed port. Omit to let the transport allocate a free port and inject it via
   * the `${port}` placeholder in `args` (recommended, avoids collisions).
   */
  port?: number;

  /** Overall budget for "spawn → port accepts a connection". Defaults to 10000ms. */
  readyTimeoutMs?: number;
  /** Delay between connection retries while the port is not yet listening. Defaults to 100ms. */
  retryIntervalMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

/**
 * Spawns a debug adapter that itself listens on TCP, waits until the port accepts
 * a connection, then speaks DAP over that socket. Owns *both* the child process
 * and the socket: `dispose()` ends the socket and kills the child.
 *
 * This is the missing diagonal between {@link StdioTransport} (we spawn, but talk
 * over stdio) and {@link SocketTransport} (we talk over a socket, but connect to a
 * server someone else started). It is the mode used by adapters like `dlv dap`.
 */
export class SubprocessSocketTransport extends StreamTransport {
  private child?: ChildProcess;
  private socket?: net.Socket;

  constructor(private readonly options: SubprocessSocketTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    const host = this.options.host ?? DEFAULT_HOST;
    const port = this.options.port ?? (await pickFreePort(host));
    const args = substitute(this.options.args ?? [], host, port);

    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => this._onError.fire(err));
    child.on("exit", (code) => this.fireClose({ code, requested: false }));
    // stderr is non-fatal server diagnostics, not a transport error; drain both
    // pipes so the server never blocks, but never let stderr close the connection.
    child.stderr?.on("data", (chunk: Buffer) => {
      this._onDiagnostic.fire(chunk.toString("utf8").trimEnd());
    });
    child.stdout?.on("data", () => {});

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    this.socket = await this.connectWhenReady(host, port);
    this.attach(this.socket, this.socket);
  }

  /** Retry `connect` until the server listens, the process dies, or we time out. */
  private async connectWhenReady(host: string, port: number): Promise<net.Socket> {
    const retryInterval = this.options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

    for (;;) {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`debug adapter exited before listening on ${host}:${port}`);
      }
      try {
        return await tryConnect(host, port);
      } catch (err) {
        if (!isNotReady(err)) {
          throw err;
        }
      }
      if (Date.now() >= deadline) {
        child.kill("SIGTERM");
        throw new Error(`timed out waiting for debug adapter to listen on ${host}:${port}`);
      }
      await delay(retryInterval);
    }
  }

  protected async teardown(): Promise<void> {
    this.socket?.end();
    this.socket = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
  }
}

/** Replace `${host}` / `${port}` placeholders in the server arguments. */
function substitute(args: readonly string[], host: string, port: number): string[] {
  return args.map((arg) => arg.replace(/\$\{host\}/g, host).replace(/\$\{port\}/g, String(port)));
}

/** Ask the OS for a free TCP port, then release it for the child to claim. */
function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("failed to allocate a free port"))));
    });
  });
}

/** Resolve with a connected socket, or reject on the first connection error. */
function tryConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/** A connection error that just means "the server has not started listening yet". */
function isNotReady(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "ECONNRESET";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
