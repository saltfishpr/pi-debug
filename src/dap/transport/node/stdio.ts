import { type ChildProcess, spawn } from "node:child_process";
import { StreamTransport } from "./stream.js";

export interface StdioTransportOptions {
  /** Executable to run (e.g. 'node', 'python', or an absolute adapter path). */
  command: string;
  /** Arguments passed to the executable. */
  args?: readonly string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra environment variables, merged over the current process env. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Launches a debug adapter as a child process and speaks DAP over its
 * stdin/stdout (the most common adapter deployment).
 */
export class StdioTransport extends StreamTransport {
  private child?: ChildProcess;

  constructor(private readonly options: StdioTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    const { command, args = [], cwd, env } = this.options;
    const child = spawn(command, [...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => this._onError.fire(err));
    child.on("exit", (code) => this.fireClose({ code, requested: false }));
    // stderr is non-fatal adapter diagnostics, not a transport error; drain it
    // so the adapter never blocks, but never let it close the connection.
    child.stderr?.on("data", (chunk: Buffer) => {
      this._onDiagnostic.fire(chunk.toString("utf8").trimEnd());
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    this.attach(child.stdout!, child.stdin!);
  }

  protected async teardown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
  }
}
