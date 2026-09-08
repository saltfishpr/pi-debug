import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { DapConnectionError } from "../util/errors";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import { Transport } from "./transport";

export interface StdioTransportOptions {
  /** Executable to launch, e.g. `node` or `/usr/bin/lldb-vscode`. */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Environment variables merged onto the parent environment. */
  env?: Record<string, string>;
  logger?: Logger;
}

/**
 * Talks to a debug adapter launched as a child process, exchanging DAP
 * messages over the process's stdin/stdout. This is the `executable` adapter
 * type in nvim-dap / VS Code terms.
 */
export class StdioTransport extends Transport {
  private child?: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;

  constructor(private readonly options: StdioTransportOptions) {
    super();
    this.logger = options.logger ?? noopLogger;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { command, args = [], cwd, env } = this.options;
      this.logger.debug("Spawning debug adapter", command, args);

      const child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const onSpawnError = (err: Error) => {
        reject(new DapConnectionError(`Failed to spawn adapter '${command}': ${err.message}`, { cause: err }));
      };
      child.once("error", onSpawnError);

      child.once("spawn", () => {
        child.off("error", onSpawnError);
        child.on("error", (err) => this.fire("error", err));
        child.stdout.on("data", (chunk: Buffer) => this.fire("data", chunk));
        child.stderr.on("data", (chunk: Buffer) => this.fire("stderr", chunk));
        child.once("close", (code) => {
          this.logger.debug("Adapter process exited", code);
          this.fire("close");
        });
        resolve();
      });
    });
  }

  write(data: Buffer): void {
    if (!this.child) {
      throw new DapConnectionError("Cannot write: stdio transport is not connected");
    }
    this.child.stdin.write(data);
  }

  dispose(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}
