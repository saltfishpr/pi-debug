import type { DebugProtocol } from "@vscode/debugprotocol";
import * as pty from "node-pty";
import { platform } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { killProcessTree } from "../common/process.js";
import { finishesWithin } from "./async.js";

const TERMINATE_TIMEOUT_MS = 1_000;
const runInTerminalArgumentsSchema = z
  .object({
    kind: z.enum(["integrated", "external"]).optional(),
    title: z.string().optional(),
    cwd: z.string(),
    args: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string().nullable()).optional(),
    argsCanBeInterpretedByShell: z.boolean().optional(),
  })
  .loose();

interface TerminalRecord {
  terminal: pty.IPty;
  exited: Promise<void>;
  hasExited: boolean;
  disposeData: () => void;
  disposeExit: () => void;
}

interface IntegratedTerminalHostOptions {
  workspaceFolder: string;
  onOutput: (output: string) => void;
}

/** Owns the non-interactive integrated terminals launched for one debug session. */
export class IntegratedTerminalHost {
  private readonly terminals = new Set<TerminalRecord>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: IntegratedTerminalHostOptions) {}

  /** Launch a command directly in a PTY and return its process ID. */
  run(arguments_: unknown, signal?: AbortSignal): DebugProtocol.RunInTerminalResponse["body"] {
    if (this.closed) throw new Error("Integrated terminal host is closed.");
    signal?.throwIfAborted();

    const parsed = runInTerminalArgumentsSchema.safeParse(arguments_);
    if (!parsed.success) throw new Error(`Invalid runInTerminal arguments: ${z.prettifyError(parsed.error)}`);
    const request = parsed.data;
    if (request.kind === "external") throw new Error("External terminals are not supported.");
    if (request.argsCanBeInterpretedByShell === true) {
      throw new Error("Shell-interpreted terminal arguments are not supported.");
    }
    this.assertNoNullCharacters(request);

    const [command, ...args] = request.args;
    if (!command) throw new Error("`runInTerminal.args` must contain a non-empty command.");
    const terminal = pty.spawn(command, args, {
      cwd: resolve(this.options.workspaceFolder, request.cwd || "."),
      env: this.resolveEnvironment(request.env),
      name: process.env.TERM || "xterm-256color",
      cols: 80,
      rows: 24,
    });

    let resolveExited!: () => void;
    const record: TerminalRecord = {
      terminal,
      exited: new Promise<void>((resolvePromise) => {
        resolveExited = resolvePromise;
      }),
      hasExited: false,
      disposeData: () => undefined,
      disposeExit: () => undefined,
    };
    record.disposeData = terminal.onData((output) => {
      if (!this.closed) this.options.onOutput(output);
    }).dispose;
    record.disposeExit = terminal.onExit(() => {
      if (record.hasExited) return;
      record.hasExited = true;
      this.terminals.delete(record);
      record.disposeData();
      record.disposeExit();
      resolveExited();
    }).dispose;
    this.terminals.add(record);

    try {
      if (this.closed) throw new Error("Integrated terminal host is closed.");
      signal?.throwIfAborted();
      return { processId: terminal.pid };
    } catch (error) {
      this.terminals.delete(record);
      record.disposeData();
      record.disposeExit();
      try {
        terminal.kill();
      } catch {
        // Preserve the error that prevented the launch from being acknowledged.
      }
      throw error;
    }
  }

  /** Stop every terminal and prevent any later launches. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const records = [...this.terminals];
    for (const record of records) record.disposeData();
    const results = await Promise.allSettled(records.map((record) => this.stop(record)));
    for (const record of records) {
      this.terminals.delete(record);
      record.disposeExit();
    }
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => errorMessage(result.reason));
    if (errors.length) throw new Error(errors.join("; "));
  }

  private async stop(record: TerminalRecord): Promise<void> {
    if (record.hasExited) return;
    await this.signal(record, "SIGTERM");
    if (await finishesWithin(record.exited, TERMINATE_TIMEOUT_MS)) return;
    await this.signal(record, "SIGKILL");
    if (!(await finishesWithin(record.exited, TERMINATE_TIMEOUT_MS))) {
      throw new Error(`Terminal process ${record.terminal.pid} did not exit.`);
    }
  }

  private async signal(record: TerminalRecord, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    try {
      await killProcessTree(record.terminal.pid, signal);
    } catch {
      // Exit observation below determines whether cleanup succeeded.
    }
  }

  private resolveEnvironment(overrides?: Record<string, string | null>): Record<string, string> {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    for (const [name, value] of Object.entries(overrides ?? {})) {
      const existing =
        platform() === "win32"
          ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
          : name;
      if (existing !== undefined) delete environment[existing];
      if (value !== null) environment[name] = value;
    }
    return environment;
  }

  private assertNoNullCharacters(arguments_: z.infer<typeof runInTerminalArgumentsSchema>): void {
    const values = [arguments_.cwd, ...arguments_.args];
    for (const [name, value] of Object.entries(arguments_.env ?? {})) {
      values.push(name);
      if (value !== null) values.push(value);
    }
    if (values.some((value) => value.includes("\0"))) {
      throw new Error("runInTerminal arguments must not contain null characters.");
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
