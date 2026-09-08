import type { DebugProtocol } from "@vscode/debugprotocol";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Session } from "./dap";
import { SessionState } from "./dap";

const SNIPPET_RADIUS = 5;

export interface OutputChunk {
  category: string;
  output: string;
  timestamp: number;
}

export interface BreakpointInput {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface BreakpointSnapshot extends BreakpointInput {
  verified: boolean;
  actualLine?: number;
  message?: string;
  id?: number;
}

export interface FunctionBreakpointInput {
  name: string;
  condition?: string;
  hitCondition?: string;
}

export interface FunctionBreakpointSnapshot extends FunctionBreakpointInput {
  verified: boolean;
  message?: string;
  id?: number;
}

export interface WaitOptions {
  waitForStop: boolean;
  waitTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ContinueOptions extends WaitOptions {
  threadId?: number;
}

export interface NextOptions extends WaitOptions {
  threadId?: number;
  granularity?: DebugProtocol.SteppingGranularity;
}

export interface StepInOptions extends WaitOptions {
  threadId?: number;
  targetId?: number;
  granularity?: DebugProtocol.SteppingGranularity;
}

export interface StepOutOptions extends WaitOptions {
  threadId?: number;
  granularity?: DebugProtocol.SteppingGranularity;
}

export interface StopFrame {
  frameId: number;
  name: string;
  source?: string;
  line?: number;
  column?: number;
  snippet?: string;
}

export interface StopResult {
  state: "stopped" | "running" | "terminated";
  reason?: string;
  description?: string;
  threadId?: number;
  hitBreakpointIds?: number[];
  topFrame?: StopFrame;
  note?: string;
}

export interface ThreadSnapshot {
  id: number;
  name: string;
  stopped: boolean;
}

/**
 * Live snapshot of a {@link PiDebugSession}'s runtime state.
 *
 * Returned by {@link PiDebugSession.snapshot} and used both by the tool
 * dispatcher (as a stable value type for formatting/details) and by callers
 * that want to inspect the session without holding on to the object.
 */
export interface SessionSnapshot {
  id: string;
  state: SessionState;
  configuration: {
    name?: string;
    type?: string;
    request?: string;
  };
  stop?: {
    threadId: number;
    focusedFrameId?: number;
  };
  threads?: {
    total: number;
    stopped: number;
    observedAt: number; // timestamp of last observation
  };
}

/**
 * Extension-level wrapper around a DAP {@link Session}.
 *
 * Owns the output buffer for debuggee stdout/stderr, tracks spawned debuggee
 * processes for `runInTerminal`, and exposes the higher-level control-flow /
 * inspection surface the debug tool needs (wait-for-stop, snippet on stop,
 * incremental breakpoint bookkeeping).
 */
export class PiDebugSession {
  readonly id: string;
  private readonly outputChunks: OutputChunk[] = [];
  private readonly spawnedDebuggees: ChildProcess[] = [];
  private readonly breakpointVerified = new Map<string, BreakpointSnapshot[]>();
  private functionBreakpointVerified: FunctionBreakpointSnapshot[] = [];
  private closedEmitted = false;

  constructor(private readonly dapSession: Session) {
    this.id = dapSession.id;

    dapSession.on("output", (body) => {
      this.appendOutput(body.category ?? "console", body.output ?? "");
    });
    dapSession.on("close", () => {
      this.disposeSpawned();
      this.closedEmitted = true;
    });
    dapSession.on("terminated", () => {
      this.disposeSpawned();
    });
  }

  // ---- state accessors ---------------------------------------------------

  get state(): SessionState {
    return this.dapSession.state;
  }

  get stoppedThreadId(): number | undefined {
    return this.dapSession.stoppedThreadId;
  }

  get focusedFrameId(): number | undefined {
    return this.dapSession.focusedFrameId;
  }

  get config(): Readonly<Record<string, unknown>> {
    return this.dapSession.config as Readonly<Record<string, unknown>>;
  }

  get isClosed(): boolean {
    return this.closedEmitted || this.dapSession.state === SessionState.Terminated;
  }

  // ---- output ------------------------------------------------------------

  registerSpawnedDebuggee(child: ChildProcess): void {
    this.spawnedDebuggees.push(child);
    child.stdout?.on("data", (data: Buffer | string) => this.appendOutput("stdout", data.toString()));
    child.stderr?.on("data", (data: Buffer | string) => this.appendOutput("stderr", data.toString()));
    child.once("exit", (code, signal) => {
      this.appendOutput("console", `\n[debuggee exited: code=${code ?? "null"} signal=${signal ?? "null"}]\n`);
    });
  }

  drainOutput(clear: boolean): OutputChunk[] {
    const snapshot = [...this.outputChunks];
    if (clear) {
      this.outputChunks.length = 0;
    }
    return snapshot;
  }

  private appendOutput(category: string, output: string): void {
    if (!output) {
      return;
    }
    this.outputChunks.push({ category, output, timestamp: Date.now() });
  }

  // ---- execution control -------------------------------------------------

  async continueAndWait(opts: ContinueOptions): Promise<StopResult> {
    const target = opts.threadId ?? this.dapSession.stoppedThreadId;
    if (typeof target !== "number") {
      throw new Error("continue: no stopped thread; pass threadId or wait for a stop first");
    }
    const waiter = opts.waitForStop ? this.armStopWaiter(opts.waitTimeoutMs, opts.signal) : undefined;
    await this.dapSession.continue(target);
    return this.finishStopWait(waiter, opts.waitForStop);
  }

  async next(opts: NextOptions): Promise<StopResult> {
    const threadId = opts.threadId ?? this.dapSession.stoppedThreadId;
    if (typeof threadId !== "number") {
      throw new Error("next: no stopped thread; pass threadId or wait for a stop first");
    }
    const waiter = opts.waitForStop ? this.armStopWaiter(opts.waitTimeoutMs, opts.signal) : undefined;
    await this.dapSession.next(threadId, opts.granularity);
    return this.finishStopWait(waiter, opts.waitForStop);
  }

  async stepIn(opts: StepInOptions): Promise<StopResult> {
    const threadId = opts.threadId ?? this.dapSession.stoppedThreadId;
    if (typeof threadId !== "number") {
      throw new Error("step_in: no stopped thread; pass threadId or wait for a stop first");
    }
    const waiter = opts.waitForStop ? this.armStopWaiter(opts.waitTimeoutMs, opts.signal) : undefined;
    await this.dapSession.stepIn(threadId, opts.targetId, opts.granularity);
    return this.finishStopWait(waiter, opts.waitForStop);
  }

  async stepOut(opts: StepOutOptions): Promise<StopResult> {
    const threadId = opts.threadId ?? this.dapSession.stoppedThreadId;
    if (typeof threadId !== "number") {
      throw new Error("step_out: no stopped thread; pass threadId or wait for a stop first");
    }
    const waiter = opts.waitForStop ? this.armStopWaiter(opts.waitTimeoutMs, opts.signal) : undefined;
    await this.dapSession.stepOut(threadId, opts.granularity);
    return this.finishStopWait(waiter, opts.waitForStop);
  }

  async pause(threadId: number): Promise<void> {
    await this.dapSession.pause(threadId);
  }

  // ---- inspection --------------------------------------------------------

  async stackTrace(threadId?: number, startFrame?: number, levels?: number): Promise<DebugProtocol.StackFrame[]> {
    const target = threadId ?? this.dapSession.stoppedThreadId;
    if (typeof target !== "number") {
      throw new Error("stack_trace: no stopped thread; pass threadId or wait for a stop first");
    }
    const args: Omit<DebugProtocol.StackTraceArguments, "threadId"> = {};
    if (startFrame !== undefined) args.startFrame = startFrame;
    if (levels !== undefined) args.levels = levels;
    return this.dapSession.getStackTrace(target, args);
  }

  selectFrame(frameId: number): void {
    this.dapSession.setFocusedFrame(frameId);
  }

  async scopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    return this.dapSession.getScopes(frameId);
  }

  async variables(variablesReference: number): Promise<DebugProtocol.Variable[]> {
    return this.dapSession.getVariables(variablesReference);
  }

  async evaluate(expression: string, frameId?: number, context: string = "repl"): Promise<DebugProtocol.EvaluateResponse["body"]> {
    const args: Omit<DebugProtocol.EvaluateArguments, "expression"> = { context };
    if (frameId !== undefined) args.frameId = frameId;
    return this.dapSession.evaluate(expression, args);
  }

  async threads(): Promise<ThreadSnapshot[]> {
    await this.dapSession.getThreads();
    return this.dapSession.getThreadInfos().map(({ id, name, stopped }) => ({ id, name, stopped }));
  }

  snapshot(): SessionSnapshot {
    const config = this.dapSession.config;
    const threads = this.dapSession.getThreadInfos();
    const snapshot: SessionSnapshot = {
      id: this.id,
      state: this.dapSession.state,
      configuration: {
        name: config.name,
        type: config.type,
        request: config.request,
      },
      threads: {
        total: threads.length,
        stopped: threads.filter((thread) => thread.stopped).length,
        observedAt: Date.now(),
      },
    };

    const stoppedThreadId = this.stoppedThreadId;
    if (stoppedThreadId !== undefined) {
      snapshot.stop = {
        threadId: stoppedThreadId,
        focusedFrameId: this.focusedFrameId,
      };
    }
    return snapshot;
  }

  // ---- breakpoints -------------------------------------------------------

  async addBreakpoints(source: string, breakpoints: BreakpointInput[]): Promise<BreakpointSnapshot[]> {
    const current = this.getSourceBreakpoints(source);
    const merged = [...current];
    for (const bp of breakpoints) {
      const existingIdx = merged.findIndex((b) => b.line === bp.line);
      if (existingIdx >= 0) {
        merged[existingIdx] = bp;
      } else {
        merged.push(bp);
      }
    }
    return this.applyBreakpoints(source, merged);
  }

  async removeBreakpoints(source: string, lines?: number[]): Promise<BreakpointSnapshot[]> {
    if (!lines || lines.length === 0) {
      return this.applyBreakpoints(source, []);
    }
    const drop = new Set(lines);
    const remaining = this.getSourceBreakpoints(source).filter((bp) => !drop.has(bp.line));
    return this.applyBreakpoints(source, remaining);
  }

  listBreakpoints(source?: string): Record<string, BreakpointSnapshot[]> {
    if (source) {
      const list = this.breakpointVerified.get(source);
      return list ? { [source]: [...list] } : {};
    }
    const result: Record<string, BreakpointSnapshot[]> = {};
    for (const [key, list] of this.breakpointVerified) {
      result[key] = [...list];
    }
    return result;
  }

  private getSourceBreakpoints(source: string): BreakpointInput[] {
    return (this.breakpointVerified.get(source) ?? []).map((bp) => ({
      line: bp.line,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
      logMessage: bp.logMessage,
    }));
  }

  private async applyBreakpoints(source: string, breakpoints: BreakpointInput[]): Promise<BreakpointSnapshot[]> {
    const dapBreakpoints: DebugProtocol.SourceBreakpoint[] = breakpoints.map((bp) => {
      const out: DebugProtocol.SourceBreakpoint = { line: bp.line };
      if (bp.condition !== undefined) out.condition = bp.condition;
      if (bp.hitCondition !== undefined) out.hitCondition = bp.hitCondition;
      if (bp.logMessage !== undefined) out.logMessage = bp.logMessage;
      return out;
    });

    const dapSource: DebugProtocol.Source = { path: source, name: source.split(/[\\/]/).pop() };
    const responses = await this.dapSession.setBreakpoints(dapSource, dapBreakpoints);

    const snapshots: BreakpointSnapshot[] = breakpoints.map((bp, idx) => {
      const resp = responses[idx];
      const snap: BreakpointSnapshot = {
        line: bp.line,
        verified: resp?.verified ?? false,
      };
      if (bp.condition !== undefined) snap.condition = bp.condition;
      if (bp.hitCondition !== undefined) snap.hitCondition = bp.hitCondition;
      if (bp.logMessage !== undefined) snap.logMessage = bp.logMessage;
      if (resp?.line !== undefined && resp.line !== bp.line) snap.actualLine = resp.line;
      if (resp?.message !== undefined) snap.message = resp.message;
      if (resp?.id !== undefined) snap.id = resp.id;
      return snap;
    });

    if (snapshots.length === 0) {
      this.breakpointVerified.delete(source);
    } else {
      this.breakpointVerified.set(source, snapshots);
    }
    return snapshots;
  }

  async addFunctionBreakpoints(breakpoints: FunctionBreakpointInput[]): Promise<FunctionBreakpointSnapshot[]> {
    const current = this.getFunctionBreakpoints();
    const merged = [...current];
    for (const bp of breakpoints) {
      const existingIdx = merged.findIndex((b) => b.name === bp.name);
      if (existingIdx >= 0) {
        merged[existingIdx] = bp;
      } else {
        merged.push(bp);
      }
    }
    return this.applyFunctionBreakpoints(merged);
  }

  async removeFunctionBreakpoints(names?: string[]): Promise<FunctionBreakpointSnapshot[]> {
    if (!names || names.length === 0) {
      return this.applyFunctionBreakpoints([]);
    }
    const drop = new Set(names);
    const remaining = this.getFunctionBreakpoints().filter((bp) => !drop.has(bp.name));
    return this.applyFunctionBreakpoints(remaining);
  }

  listFunctionBreakpoints(): FunctionBreakpointSnapshot[] {
    return [...this.functionBreakpointVerified];
  }

  private getFunctionBreakpoints(): FunctionBreakpointInput[] {
    return this.functionBreakpointVerified.map((bp) => ({
      name: bp.name,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
    }));
  }

  private async applyFunctionBreakpoints(breakpoints: FunctionBreakpointInput[]): Promise<FunctionBreakpointSnapshot[]> {
    const dapBreakpoints: DebugProtocol.FunctionBreakpoint[] = breakpoints.map((bp) => {
      const out: DebugProtocol.FunctionBreakpoint = { name: bp.name };
      if (bp.condition !== undefined) out.condition = bp.condition;
      if (bp.hitCondition !== undefined) out.hitCondition = bp.hitCondition;
      return out;
    });

    const responses = await this.dapSession.setFunctionBreakpoints(dapBreakpoints);

    const snapshots: FunctionBreakpointSnapshot[] = breakpoints.map((bp, idx) => {
      const resp = responses[idx];
      const snap: FunctionBreakpointSnapshot = {
        name: bp.name,
        verified: resp?.verified ?? false,
      };
      if (bp.condition !== undefined) snap.condition = bp.condition;
      if (bp.hitCondition !== undefined) snap.hitCondition = bp.hitCondition;
      if (resp?.message !== undefined) snap.message = resp.message;
      if (resp?.id !== undefined) snap.id = resp.id;
      return snap;
    });

    this.functionBreakpointVerified = snapshots;
    return snapshots;
  }

  // ---- lifecycle ---------------------------------------------------------

  async stop(terminateDebuggee?: boolean): Promise<void> {
    try {
      const args: DebugProtocol.DisconnectArguments = {};
      if (terminateDebuggee !== undefined) args.terminateDebuggee = terminateDebuggee;
      await this.dapSession.disconnect(args);
    } catch {
      this.dapSession.close();
    } finally {
      this.disposeSpawned();
    }
  }

  // ---- wait-for-stop plumbing -------------------------------------------

  private armStopWaiter(timeoutMs: number, signal?: AbortSignal): Promise<StopResult> {
    return new Promise<StopResult>((resolve) => {
      const disposables: Array<() => void> = [];
      const cleanup = () => {
        for (const d of disposables) d();
        disposables.length = 0;
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({ state: "running", note: "wait timed out" });
      }, timeoutMs);
      timer.unref?.();
      disposables.push(() => clearTimeout(timer));

      if (signal) {
        const onAbort = () => {
          cleanup();
          resolve({ state: "running", note: "wait cancelled" });
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        disposables.push(() => signal.removeEventListener("abort", onAbort));
      }

      const stoppedSub = this.dapSession.on("stopped", (body) => {
        cleanup();
        void this.buildStopResult(body).then(resolve);
      });
      disposables.push(() => stoppedSub.dispose());

      const terminatedSub = this.dapSession.on("terminated", () => {
        cleanup();
        resolve({ state: "terminated" });
      });
      disposables.push(() => terminatedSub.dispose());

      const closeSub = this.dapSession.on("close", () => {
        cleanup();
        resolve({ state: "terminated" });
      });
      disposables.push(() => closeSub.dispose());
    });
  }

  private async finishStopWait(waiter: Promise<StopResult> | undefined, waitForStop: boolean): Promise<StopResult> {
    if (!waitForStop || !waiter) {
      return { state: this.dapSession.state === SessionState.Stopped ? "stopped" : "running" };
    }
    return waiter;
  }

  private async buildStopResult(body: DebugProtocol.StoppedEvent["body"]): Promise<StopResult> {
    const result: StopResult = { state: "stopped" };
    if (body.reason) result.reason = body.reason;
    if (body.description) result.description = body.description;
    if (typeof body.threadId === "number") result.threadId = body.threadId;
    if (body.hitBreakpointIds) result.hitBreakpointIds = body.hitBreakpointIds;

    if (typeof body.threadId === "number") {
      try {
        const frames = await this.dapSession.getStackTrace(body.threadId, { startFrame: 0, levels: 1 });
        const top = frames[0];
        if (top) {
          const frame: StopFrame = { frameId: top.id, name: top.name };
          const sourcePath = top.source?.path;
          if (sourcePath) frame.source = sourcePath;
          if (typeof top.line === "number") frame.line = top.line;
          if (typeof top.column === "number") frame.column = top.column;
          if (sourcePath && typeof top.line === "number") {
            const snippet = await readSourceSnippet(sourcePath, top.line);
            if (snippet) frame.snippet = snippet;
          }
          result.topFrame = frame;
        }
      } catch {
        // best-effort — a missing snippet is not fatal
      }
    }
    return result;
  }

  private disposeSpawned(): void {
    for (const child of this.spawnedDebuggees) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    }
    this.spawnedDebuggees.length = 0;
  }
}

async function readSourceSnippet(path: string, line: number): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, line - SNIPPET_RADIUS);
    const end = Math.min(lines.length, line + SNIPPET_RADIUS);
    const width = String(end).length;
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      const marker = i === line ? "→" : " ";
      out.push(`${marker} ${String(i).padStart(width)}: ${lines[i - 1] ?? ""}`);
    }
    return out.join("\n");
  } catch {
    return undefined;
  }
}
