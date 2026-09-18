import type { DebugProtocol } from "@vscode/debugprotocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const argumentsSchema = z.object({
  kind: z.enum(["integrated", "external"]).optional(),
  cwd: z.string(),
  args: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string().nullable()).optional(),
  argsCanBeInterpretedByShell: z.boolean().optional(),
});

/** 启动非交互式命令，并拥有这些命令及其进程组，直到会话关闭。 */
export class TerminalProcesses {
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly workspaceFolder: string,
    private readonly output: (text: string) => void,
  ) {}

  /** 保留参数原文、合并环境变量，在成功 spawn 后返回实际进程 ID。 */
  async run(args: unknown, signal: AbortSignal): Promise<DebugProtocol.RunInTerminalResponse["body"]> {
    signal.throwIfAborted();
    if (this.closing) throw new Error("runInTerminal is unavailable after session shutdown.");
    const parsed = argumentsSchema.safeParse(args);
    if (!parsed.success) throw new Error(`Invalid runInTerminal arguments: ${parsed.error.message}`);
    const request = parsed.data;
    if (request.kind === "external") {
      throw new Error("External terminals are unsupported. Use an integrated terminal with a non-interactive program.");
    }
    if (request.argsCanBeInterpretedByShell) {
      throw new Error("Shell argument interpretation is unsupported. Pass an executable and literal arguments.");
    }
    if (!request.args[0]) throw new Error("runInTerminal args[0] must be a non-empty executable.");

    const env = { ...process.env };
    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const child = spawn(request.args[0], request.args.slice(1), {
      cwd: resolve(this.workspaceFolder, request.cwd),
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.set(
      child,
      new Promise<void>((done) => {
        child.once("close", () => {
          done();
          if (!child.pid) this.children.delete(child);
          else if (process.platform !== "win32") {
            try {
              process.kill(-child.pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") this.children.delete(child);
            }
          }
        });
      }),
    );
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => this.output(text));
      stream.on("error", (error: Error) => this.output(`runInTerminal output error: ${error.message}\n`));
    }
    child.on("error", (error) => this.output(`runInTerminal process error: ${error.message}\n`));
    try {
      await once(child, "spawn", { signal });
      signal.throwIfAborted();
      if (this.closing) throw new Error("Session closed while starting runInTerminal.");
      this.output(
        "runInTerminal: non-interactive process; stdin is closed (EOF). Interactive input and TTY are unsupported.\n",
      );
      return { processId: child.pid! };
    } catch (error) {
      await this.stop(child);
      this.children.delete(child);
      throw error;
    }
  }

  /** 仅清理由本会话创建的进程；attach 的既有目标不属于此集合。 */
  close(): Promise<void> {
    this.closing ??= Promise.all([...this.children.keys()].map((child) => this.stop(child))).then(() => {
      this.children.clear();
    });
    return this.closing;
  }

  private async stop(child: ChildProcess): Promise<void> {
    try {
      if (!child.pid) return;
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) {
          await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        }
      } else {
        // 父进程可能先退出，仍需清理继承了进程组及输出 pipe 的子进程。
        const kill = async (signal: NodeJS.Signals): Promise<boolean> => {
          try {
            try {
              process.kill(-child.pid!, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
              // macOS 在进程退出但尚未回收时可能暂时报 EPERM，重试后仍失败则向上报告。
              await delay(50);
              process.kill(-child.pid!, signal);
            }
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            throw error;
          }
        };
        if (await kill("SIGTERM")) {
          await delay(250);
          await kill("SIGKILL");
        }
      }
    } finally {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    await this.children.get(child);
  }
}
