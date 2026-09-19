import type { DebugProtocol } from "@vscode/debugprotocol";
import { resolve } from "node:path";
import type { DebugConfiguration } from "../config/launch-config.js";
import type { DebugAdapter } from "../dap/index.js";

const REQUEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 2_000;

export type SessionPhase = "starting" | "active" | "stopping" | "ended";
export type ThreadExecutionState = "unknown" | "running" | "stopped" | "exited";
export type WaitOutcome = "stopped" | "threadExited" | "exited" | "terminated" | "adapterExit" | "timeout";

export interface SourceBreakpoints {
  file: string;
  lines: readonly number[];
}

export interface SessionStartOptions {
  breakpoints: readonly SourceBreakpoints[];
  waitMs: number;
}

export interface ResumeOptions {
  threadId?: number;
  singleThread: boolean;
  waitMs: number;
}

export interface PauseOptions {
  threadId?: number;
  waitMs: number;
}

export interface WaitOptions {
  threadId?: number;
  waitMs: number;
}

export interface PaginationOptions {
  start: number;
  count: number;
}

export interface StackTraceOptions extends PaginationOptions {
  threadId?: number;
}

export interface VariablesOptions {
  threadId?: number;
  frame: number;
  scope: string;
  depth: number;
  maxChildren: number;
}

export interface EvaluateOptions {
  threadId?: number;
  frame: number;
  expression: string;
}

export interface InspectOptions extends VariablesOptions {
  stackStart: number;
  stackCount: number;
}

export interface StopDetails {
  reason: string;
  description?: string;
  text?: string;
  hitBreakpointIds?: number[];
  allThreadsStopped?: boolean;
}

export interface ThreadSnapshot {
  id: number;
  name?: string;
  state: ThreadExecutionState;
  stop?: StopDetails;
}

export interface TerminalResult {
  kind: "exited" | "terminated" | "adapterExit" | "error";
  exitCode?: number;
  message?: string;
}

export interface SessionSnapshot {
  lifecycle: SessionPhase;
  name: string;
  type: string;
  request: "launch" | "attach";
  supportsSingleThreadExecution: boolean;
  threads: ThreadSnapshot[];
  exit?: TerminalResult;
}

export interface StackFrameResult {
  name: string;
  line: number;
  column: number;
  source?: string;
  path?: string;
  endLine?: number;
  endColumn?: number;
}

export interface BreakpointResult {
  requestedLine: number;
  verified: boolean;
  line?: number;
  column?: number;
  message?: string;
}

export interface ExecutionResult {
  waitOutcome: WaitOutcome;
  threadId?: number;
  stop?: StopDetails;
  exitCode?: number;
  session: SessionSnapshot;
}

export interface SetBreakpointsResult {
  file: string;
  breakpoints: BreakpointResult[];
  session: SessionSnapshot;
}

export interface ThreadsResult {
  threads: ThreadSnapshot[];
  nextStart?: number;
  total: number;
  session: SessionSnapshot;
}

export interface StackTraceResult {
  threadId: number;
  frames: StackFrameResult[];
  total?: number;
  nextStart?: number;
}

interface ExpandedVariable {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  children?: ExpandedVariable[];
  hasMore: boolean;
}

export interface ExpandedVariables {
  variables: ExpandedVariable[];
  hasMore: boolean;
}

export interface VariablesResult {
  threadId: number;
  frame: number;
  scope: string;
  variables: ExpandedVariable[];
  hasMore: boolean;
}

export interface EvaluateResult {
  threadId: number;
  frame: number;
  result: string;
  type?: string;
  hasChildren: boolean;
}

export interface InspectResult {
  threadId: number;
  frames: StackFrameResult[];
  frame: number;
  scope: string;
  variables: ExpandedVariable[];
  hasMore: boolean;
  session: SessionSnapshot;
}

interface ThreadRecord {
  id: number;
  name?: string;
  state: ThreadExecutionState;
  executionRevision: number;
  lastEventRevision: number;
  stop?: StopDetails;
}

interface TerminalState {
  revision: number;
  kind: "exited" | "terminated" | "adapterExit" | "error";
  exitCode?: number;
  message?: string;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      this.resolvePromise = resolvePromise;
      this.rejectPromise = rejectPromise;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }

  reject(reason: unknown): void {
    this.rejectPromise(reason);
  }
}

function formatStackFrame(frame: DebugProtocol.StackFrame): StackFrameResult {
  return {
    name: frame.name,
    line: frame.line,
    column: frame.column,
    ...(frame.source?.name ? { source: frame.source.name } : {}),
    ...(frame.source?.path ? { path: frame.source.path } : {}),
    ...(frame.endLine !== undefined ? { endLine: frame.endLine } : {}),
    ...(frame.endColumn !== undefined ? { endColumn: frame.endColumn } : {}),
  };
}

function formatResponseError(response: DebugProtocol.Response): string {
  const body = response.body as { error?: DebugProtocol.Message } | undefined;
  const error = body?.error;
  if (!error) return response.message || `Debug adapter rejected '${response.command}'.`;
  let message = error.format;
  for (const [name, value] of Object.entries(error.variables ?? {})) {
    message = message.replaceAll(`{${name}}`, value);
  }
  return message;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${operation}.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

/** One persistent Debug Adapter Protocol session and its command semantics. */
export class DebugSession {
  private phase: SessionPhase = "starting";
  private terminal: TerminalState | undefined;
  private transportStarted = false;
  private adapterExited = false;
  private closePromise: Promise<void> | undefined;

  private capabilities: DebugProtocol.Capabilities = {};

  private readonly threadsById = new Map<number, ThreadRecord>();
  private revision = 0;
  private lastStoppedThreadId: number | undefined;
  private lastStop: { revision: number; threadId?: number; details: StopDetails } | undefined;
  private allThreadsStoppedRevision: number | undefined;

  private initialized: Deferred<void> | undefined;
  private initializedSeen = false;
  private initialBreakpoints: readonly SourceBreakpoints[] = [];

  private readonly changeListeners = new Set<() => void>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: DebugAdapter,
    private readonly configuration: DebugConfiguration,
    private readonly cwd: string,
  ) {
    adapter.onEvent((event) => this.handleEvent(event));
    adapter.onRequest((request) => this.handleReverseRequest(request));
    adapter.onError((error) => this.handleAdapterError(error));
    adapter.onExit((code) => this.handleAdapterExit(code));
  }

  get isEnded(): boolean {
    return this.phase === "ended";
  }

  /** Return current lifecycle, capabilities, thread states and terminal information without blocking. */
  status(): SessionSnapshot {
    const threads = [...this.threadsById.values()]
      .filter((thread) => thread.state !== "exited")
      .sort((a, b) => a.id - b.id)
      .map((thread) => ({
        id: thread.id,
        ...(thread.name ? { name: thread.name } : {}),
        state: thread.state,
        ...(thread.stop ? { stop: thread.stop } : {}),
      }));

    return {
      lifecycle: this.phase,
      name: this.configuration.name,
      type: this.configuration.type,
      request: this.configuration.request,
      supportsSingleThreadExecution: this.capabilities.supportsSingleThreadExecutionRequests === true,
      threads,
      ...(this.terminal
        ? {
            exit: {
              kind: this.terminal.kind,
              ...(this.terminal.exitCode !== undefined ? { exitCode: this.terminal.exitCode } : {}),
              ...(this.terminal.message ? { message: this.terminal.message } : {}),
            },
          }
        : {}),
    };
  }

  /** Start the transport and complete the DAP configuration handshake. */
  async start(options: SessionStartOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    if (this.phase !== "starting") throw new Error(`Cannot start a debug session in state '${this.phase}'.`);
    const baseline = this.revision;

    try {
      await this.adapter.startSession(signal);
      this.transportStarted = true;

      const initialize = await this.request<DebugProtocol.InitializeResponse>(
        "initialize",
        {
          clientID: "pi-debug",
          clientName: "pi-debug",
          adapterID: this.configuration.type,
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
          supportsVariableType: true,
          supportsVariablePaging: true,
          supportsRunInTerminalRequest: false,
          supportsProgressReporting: false,
          supportsInvalidatedEvent: true,
          supportsMemoryEvent: false,
          supportsStartDebuggingRequest: false,
        } satisfies DebugProtocol.InitializeRequestArguments,
        START_TIMEOUT_MS,
        signal,
      );
      this.mergeCapabilities(initialize.body);

      const configurationDone = new Deferred<void>();
      this.initialized = configurationDone;
      this.initialBreakpoints = options.breakpoints;
      if (this.initializedSeen) void this.configure(this.initialBreakpoints, configurationDone);

      const launchOrAttach = this.request<DebugProtocol.Response>(
        this.configuration.request,
        this.configuration,
        START_TIMEOUT_MS,
        signal,
      );
      await Promise.all([
        launchOrAttach,
        withTimeout(configurationDone.promise, START_TIMEOUT_MS, "debug configuration"),
      ]);

      this.phase = "active";
      const waited = await this.waitAfter(baseline, { waitMs: options.waitMs }, signal);
      return { ...waited, session: this.status() };
    } catch (error) {
      await this.close("startFailed");
      throw error;
    }
  }

  /** Idempotently disconnect and release the adapter. */
  close(reason: "user" | "shutdown" | "startFailed" | "terminated" | "adapterExit" | "error"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOnce(reason);
    return this.closePromise;
  }

  /** Replace all source breakpoints in one file. */
  async setBreakpoints(file: string, lines: readonly number[], signal?: AbortSignal): Promise<SetBreakpointsResult> {
    this.assertActive();
    return this.withMutation(async () => {
      this.assertActive();
      const breakpoints = await this.sendBreakpoints(file, lines, signal);
      return { file: resolve(this.cwd, file), breakpoints, session: this.status() };
    });
  }

  /** Continue a stopped thread or all threads. */
  async continue(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.resume("continue", options, signal);
  }

  /** Step over in a stopped thread. */
  async next(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.resume("next", options, signal);
  }

  /** Step into in a stopped thread. */
  async stepIn(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.resume("stepIn", options, signal);
  }

  /** Step out in a stopped thread. */
  async stepOut(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.resume("stepOut", options, signal);
  }

  /** Pause a running thread and optionally wait for the resulting stop. */
  async pause(options: PauseOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    this.assertActive();
    let baseline = this.revision;
    let threadId = 0;

    await this.withMutation(async () => {
      this.assertActive();
      threadId = await this.selectRunningThread(options.threadId, signal);
      baseline = this.revision;
      await this.request<DebugProtocol.PauseResponse>("pause", { threadId }, REQUEST_TIMEOUT_MS, signal);
    });

    return this.waitAfter(baseline, { threadId, waitMs: options.waitMs }, signal);
  }

  /** Wait for a new stop, thread exit or program termination. */
  async wait(options: WaitOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    this.assertActive();
    return this.waitAfter(this.revision, options, signal);
  }

  /** Refresh and return a page of active threads. */
  async threads(options: PaginationOptions, signal?: AbortSignal): Promise<ThreadsResult> {
    this.assertActive();
    const all = await this.fetchThreads(signal);
    const page = all.slice(options.start, options.start + options.count).map((thread) => ({
      id: thread.id,
      name: thread.name,
      state: thread.state,
      ...(thread.stop ? { stop: thread.stop } : {}),
    }));
    const nextStart = options.start + page.length < all.length ? options.start + page.length : undefined;
    return {
      threads: page,
      ...(nextStart !== undefined ? { nextStart } : {}),
      total: all.length,
      session: this.status(),
    };
  }

  /** Return a page of stack frames for a stopped thread. */
  async stackTrace(options: StackTraceOptions, signal?: AbortSignal): Promise<StackTraceResult> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const response = await this.request<DebugProtocol.StackTraceResponse>(
      "stackTrace",
      {
        threadId: thread.id,
        startFrame: options.start,
        levels: options.count,
      } satisfies DebugProtocol.StackTraceArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    const frames = response.body.stackFrames.map(formatStackFrame);
    const total = response.body.totalFrames;
    const nextStart =
      frames.length === options.count && (total === undefined || options.start + frames.length < total)
        ? options.start + frames.length
        : undefined;
    return {
      threadId: thread.id,
      frames,
      ...(total !== undefined ? { total } : {}),
      ...(nextStart !== undefined ? { nextStart } : {}),
    };
  }

  /** Read and recursively expand one scope in a stopped stack frame. */
  async variables(options: VariablesOptions, signal?: AbortSignal): Promise<VariablesResult> {
    this.assertActive();
    const context = await this.resolveInspectionContext(options, signal);
    const expanded = await this.expandVariables(
      context.scope.variablesReference,
      options.depth,
      options.maxChildren,
      context.thread.id,
      context.revision,
      new Set<number>(),
      signal,
    );
    this.assertThreadRevision(context.thread.id, context.revision);
    return {
      threadId: context.thread.id,
      frame: options.frame,
      scope: context.scope.name,
      variables: expanded.variables,
      hasMore: expanded.hasMore,
    };
  }

  /** Evaluate an expression in a stopped stack frame. */
  async evaluate(options: EvaluateOptions, signal?: AbortSignal): Promise<EvaluateResult> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const frame = await this.resolveFrame(thread.id, options.frame, revision, signal);
    const response = await this.request<DebugProtocol.EvaluateResponse>(
      "evaluate",
      { expression: options.expression, frameId: frame.id, context: "watch" } satisfies DebugProtocol.EvaluateArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    return {
      threadId: thread.id,
      frame: options.frame,
      result: response.body.result,
      ...(response.body.type ? { type: response.body.type } : {}),
      hasChildren: response.body.variablesReference > 0,
    };
  }

  /** Return a bounded stack and scope snapshot after a stop. */
  async inspect(options: InspectOptions, signal?: AbortSignal): Promise<InspectResult> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const stack = await this.request<DebugProtocol.StackTraceResponse>(
      "stackTrace",
      {
        threadId: thread.id,
        startFrame: options.stackStart,
        levels: options.stackCount,
      } satisfies DebugProtocol.StackTraceArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    const frame = await this.resolveFrame(thread.id, options.frame, revision, signal);
    const scope = await this.resolveScope(frame.id, options.scope, thread.id, revision, signal);
    const expanded = await this.expandVariables(
      scope.variablesReference,
      options.depth,
      options.maxChildren,
      thread.id,
      revision,
      new Set<number>(),
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    return {
      threadId: thread.id,
      frames: stack.body.stackFrames.map(formatStackFrame),
      frame: options.frame,
      scope: scope.name,
      variables: expanded.variables,
      hasMore: expanded.hasMore,
      session: this.status(),
    };
  }

  private async closeOnce(reason: string): Promise<void> {
    if (this.phase === "ended") return;
    this.phase = "stopping";
    this.notifyChange();

    try {
      if (this.transportStarted && !this.adapterExited) {
        const args: DebugProtocol.DisconnectArguments = {};
        if (this.capabilities.supportTerminateDebuggee) {
          args.terminateDebuggee = this.configuration.request === "launch";
        }
        try {
          await this.request<DebugProtocol.DisconnectResponse>(
            "disconnect",
            args,
            reason === "error" || reason === "adapterExit" ? 200 : DISCONNECT_TIMEOUT_MS,
          );
        } catch {
          // Transport cleanup below is authoritative even when graceful disconnect fails.
        }
      }
    } finally {
      try {
        await this.adapter.stopSession();
      } finally {
        this.adapter.dispose();
        if (!this.terminal && reason === "user") this.recordTerminal({ kind: "terminated" });
        this.phase = "ended";
        this.notifyChange();
      }
    }
  }

  private async configure(breakpoints: readonly SourceBreakpoints[], deferred: Deferred<void>): Promise<void> {
    try {
      const byFile = new Map<string, Set<number>>();
      for (const source of breakpoints) {
        const path = resolve(this.cwd, source.file);
        const lines = byFile.get(path) ?? new Set<number>();
        source.lines.forEach((line) => lines.add(line));
        byFile.set(path, lines);
      }
      await Promise.all([...byFile].map(([file, lines]) => this.sendBreakpoints(file, [...lines], undefined)));
      if (this.capabilities.supportsConfigurationDoneRequest) {
        await this.request<DebugProtocol.ConfigurationDoneResponse>("configurationDone", {}, START_TIMEOUT_MS);
      } else {
        await this.request<DebugProtocol.SetExceptionBreakpointsResponse>(
          "setExceptionBreakpoints",
          { filters: [] } satisfies DebugProtocol.SetExceptionBreakpointsArguments,
          START_TIMEOUT_MS,
        );
      }
      deferred.resolve();
    } catch (error) {
      deferred.reject(error);
    }
  }

  private async sendBreakpoints(
    file: string,
    lines: readonly number[],
    signal?: AbortSignal,
  ): Promise<BreakpointResult[]> {
    const path = resolve(this.cwd, file);
    const requested = [...new Set(lines)].sort((a, b) => a - b);
    const response = await this.request<DebugProtocol.SetBreakpointsResponse>(
      "setBreakpoints",
      {
        source: { path },
        breakpoints: requested.map((line) => ({ line })),
      } satisfies DebugProtocol.SetBreakpointsArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return requested.map((line, index) => {
      const actual = response.body.breakpoints[index];
      return {
        requestedLine: line,
        verified: actual?.verified ?? false,
        ...(actual?.line !== undefined ? { line: actual.line } : {}),
        ...(actual?.column !== undefined ? { column: actual.column } : {}),
        ...(actual?.message ? { message: actual.message } : {}),
      };
    });
  }

  private async resume(
    command: "continue" | "next" | "stepIn" | "stepOut",
    options: ResumeOptions,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    this.assertActive();
    let baseline = this.revision;
    let threadId = 0;

    await this.withMutation(async () => {
      this.assertActive();
      if (options.singleThread && !this.capabilities.supportsSingleThreadExecutionRequests) {
        throw new Error("The debug adapter does not support single-thread execution requests.");
      }
      const thread = await this.selectStoppedThread(options.threadId, signal);
      threadId = thread.id;
      baseline = this.revision;
      const threadRevision = thread.executionRevision;
      const response = await this.request<DebugProtocol.Response>(
        command,
        { threadId, singleThread: options.singleThread },
        REQUEST_TIMEOUT_MS,
        signal,
      );

      const currentThread = this.threadsById.get(threadId);
      if (currentThread?.state === "stopped" && currentThread.executionRevision === threadRevision) {
        const responseAllThreads = (response.body as { allThreadsContinued?: boolean } | undefined)
          ?.allThreadsContinued;
        this.markContinued(threadId, responseAllThreads ?? !options.singleThread);
      }
    });

    return this.waitAfter(baseline, { threadId, waitMs: options.waitMs }, signal);
  }

  private async waitAfter(baseline: number, options: WaitOptions, signal?: AbortSignal): Promise<ExecutionResult> {
    const deadline = Date.now() + options.waitMs;
    while (true) {
      const outcome = this.findWaitOutcome(baseline, options.threadId);
      if (outcome) return { ...outcome, session: this.status() };
      if (options.waitMs === 0 || Date.now() >= deadline) {
        return { waitOutcome: "timeout", session: this.status() };
      }
      await this.waitForChange(deadline - Date.now(), signal);
    }
  }

  private findWaitOutcome(baseline: number, threadId?: number): Omit<ExecutionResult, "session"> | undefined {
    if (this.terminal && this.terminal.revision > baseline) {
      const kind = this.terminal.kind;
      return {
        waitOutcome: kind === "error" ? "adapterExit" : kind,
        ...(this.terminal.exitCode !== undefined ? { exitCode: this.terminal.exitCode } : {}),
      };
    }

    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (thread && thread.lastEventRevision > baseline) {
        if (thread.state === "stopped") return { waitOutcome: "stopped", threadId, stop: thread.stop };
        if (thread.state === "exited") return { waitOutcome: "threadExited", threadId };
      }
      return undefined;
    }

    if (this.lastStop && this.lastStop.revision > baseline) {
      return { waitOutcome: "stopped", threadId: this.lastStop.threadId, stop: this.lastStop.details };
    }
    return undefined;
  }

  private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        rejectPromise(abortError(signal));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        cleanup();
        resolvePromise();
      };
      const aborted = (): void => {
        cleanup();
        rejectPromise(abortError(signal));
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.changeListeners.delete(done);
        signal?.removeEventListener("abort", aborted);
      };
      this.changeListeners.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(done, Math.max(0, timeoutMs));
    });
  }

  private async fetchThreads(signal?: AbortSignal): Promise<ThreadRecord[]> {
    const response = await this.request<DebugProtocol.ThreadsResponse>("threads", {}, REQUEST_TIMEOUT_MS, signal);
    const activeIds = new Set(response.body.threads.map((thread) => thread.id));
    let removedThread = false;
    for (const thread of this.threadsById.values()) {
      if (thread.state === "exited" || activeIds.has(thread.id)) continue;
      const revision = ++this.revision;
      thread.state = "exited";
      thread.executionRevision++;
      thread.lastEventRevision = revision;
      thread.stop = undefined;
      removedThread = true;
    }
    for (const value of response.body.threads) {
      const existing = this.threadsById.get(value.id);
      if (existing) {
        existing.name = value.name;
        if (
          this.allThreadsStoppedRevision !== undefined &&
          existing.lastEventRevision < this.allThreadsStoppedRevision &&
          existing.state !== "exited"
        ) {
          existing.state = "stopped";
          existing.stop = this.lastStop?.details;
        }
      } else {
        const coveredByAllThreadsStop = this.allThreadsStoppedRevision !== undefined;
        this.threadsById.set(value.id, {
          id: value.id,
          name: value.name,
          state: coveredByAllThreadsStop ? "stopped" : "unknown",
          executionRevision: 0,
          lastEventRevision: 0,
          ...(coveredByAllThreadsStop ? { stop: this.lastStop?.details } : {}),
        });
      }
    }
    if (removedThread) this.notifyChange();
    return [...this.threadsById.values()]
      .filter((thread) => thread.state !== "exited" && activeIds.has(thread.id))
      .sort((a, b) => a.id - b.id);
  }

  private async selectStoppedThread(threadId: number | undefined, signal?: AbortSignal): Promise<ThreadRecord> {
    let stopped = [...this.threadsById.values()].filter((thread) => thread.state === "stopped");
    if (stopped.length === 0 || (threadId !== undefined && !this.threadsById.has(threadId))) {
      await this.fetchThreads(signal);
      stopped = [...this.threadsById.values()].filter((thread) => thread.state === "stopped");
    }

    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (!thread) throw new Error(`Unknown thread ${threadId}.`);
      if (thread.state !== "stopped") throw new Error(`Thread ${threadId} is not stopped.`);
      return thread;
    }

    if (this.lastStoppedThreadId !== undefined) {
      const recent = this.threadsById.get(this.lastStoppedThreadId);
      if (recent?.state === "stopped") return recent;
    }
    if (stopped.length === 1) return stopped[0];
    if (stopped.length === 0) throw new Error("No stopped thread is available.");
    throw new Error("Multiple threads are stopped; provide threadId.");
  }

  private async selectRunningThread(threadId: number | undefined, signal?: AbortSignal): Promise<number> {
    const threads = await this.fetchThreads(signal);
    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (!thread) throw new Error(`Unknown thread ${threadId}.`);
      if (thread.state === "stopped") throw new Error(`Thread ${threadId} is already stopped.`);
      return threadId;
    }
    const running = threads.filter((thread) => thread.state !== "stopped");
    if (running.length === 1) return running[0].id;
    if (running.length === 0) throw new Error("No running thread is available.");
    throw new Error("Multiple threads can be paused; provide threadId.");
  }

  private async resolveInspectionContext(
    options: VariablesOptions,
    signal?: AbortSignal,
  ): Promise<{
    thread: ThreadRecord;
    revision: number;
    frame: DebugProtocol.StackFrame;
    scope: DebugProtocol.Scope;
  }> {
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const frame = await this.resolveFrame(thread.id, options.frame, revision, signal);
    const scope = await this.resolveScope(frame.id, options.scope, thread.id, revision, signal);
    return { thread, revision, frame, scope };
  }

  private async resolveFrame(
    threadId: number,
    frameIndex: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<DebugProtocol.StackFrame> {
    const response = await this.request<DebugProtocol.StackTraceResponse>(
      "stackTrace",
      { threadId, startFrame: frameIndex, levels: 1 } satisfies DebugProtocol.StackTraceArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(threadId, revision);
    const frame = response.body.stackFrames[0];
    if (!frame) throw new Error(`Stack frame ${frameIndex} does not exist on thread ${threadId}.`);
    return frame;
  }

  private async resolveScope(
    frameId: number,
    requestedName: string,
    threadId: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<DebugProtocol.Scope> {
    const response = await this.request<DebugProtocol.ScopesResponse>(
      "scopes",
      { frameId } satisfies DebugProtocol.ScopesArguments,
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(threadId, revision);
    const requested = requestedName.toLocaleLowerCase();
    const scope = response.body.scopes.find((candidate) => candidate.name.toLocaleLowerCase() === requested);
    if (scope) return scope;
    const available = response.body.scopes.map((candidate) => candidate.name).join(", ");
    throw new Error(`Scope '${requestedName}' is not available. Available scopes: ${available || "none"}.`);
  }

  private async expandVariables(
    reference: number,
    depth: number,
    maxChildren: number,
    threadId: number,
    revision: number,
    ancestors: Set<number>,
    signal?: AbortSignal,
  ): Promise<ExpandedVariables> {
    if (reference <= 0 || depth <= 0 || ancestors.has(reference)) return { variables: [], hasMore: false };

    ancestors.add(reference);
    try {
      const response = await this.request<DebugProtocol.VariablesResponse>(
        "variables",
        { variablesReference: reference, start: 0, count: maxChildren + 1 } satisfies DebugProtocol.VariablesArguments,
        REQUEST_TIMEOUT_MS,
        signal,
      );
      this.assertThreadRevision(threadId, revision);
      const output: ExpandedVariable[] = [];
      const values = response.body.variables.slice(0, maxChildren);

      for (const variable of values) {
        const item: ExpandedVariable = {
          name: variable.name,
          value: variable.value,
          ...(variable.type ? { type: variable.type } : {}),
          ...(variable.evaluateName ? { evaluateName: variable.evaluateName } : {}),
          hasMore: false,
        };
        if (variable.variablesReference > 0 && depth > 1 && !ancestors.has(variable.variablesReference)) {
          const children = await this.expandVariables(
            variable.variablesReference,
            depth - 1,
            maxChildren,
            threadId,
            revision,
            ancestors,
            signal,
          );
          item.children = children.variables;
          item.hasMore = children.hasMore;
        }
        output.push(item);
      }
      return { variables: output, hasMore: response.body.variables.length > maxChildren };
    } finally {
      ancestors.delete(reference);
    }
  }

  private assertThreadRevision(threadId: number, revision: number): void {
    const thread = this.threadsById.get(threadId);
    if (!thread || thread.state !== "stopped" || thread.executionRevision !== revision) {
      throw new Error(`Thread ${threadId} resumed or changed while it was being inspected; inspect it again.`);
    }
  }

  private handleEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "initialized":
        this.initializedSeen = true;
        if (this.initialized) void this.configure(this.initialBreakpoints, this.initialized);
        break;
      case "capabilities":
        this.mergeCapabilities((event as DebugProtocol.CapabilitiesEvent).body.capabilities);
        break;
      case "stopped":
        this.handleStopped(event as DebugProtocol.StoppedEvent);
        break;
      case "continued": {
        const continued = event as DebugProtocol.ContinuedEvent;
        this.markContinued(continued.body.threadId, continued.body.allThreadsContinued !== false);
        break;
      }
      case "thread":
        this.handleThread(event as DebugProtocol.ThreadEvent);
        break;
      case "invalidated":
        this.invalidateThreads(event as DebugProtocol.InvalidatedEvent);
        break;
      case "exited": {
        const exited = event as DebugProtocol.ExitedEvent;
        this.recordTerminal({ kind: "exited", exitCode: exited.body.exitCode });
        break;
      }
      case "terminated":
        this.recordTerminal({ kind: "terminated" });
        void this.close("terminated").catch(() => undefined);
        break;
    }
  }

  private handleStopped(event: DebugProtocol.StoppedEvent): void {
    const revision = ++this.revision;
    const details: StopDetails = {
      reason: event.body.reason,
      ...(event.body.description ? { description: event.body.description } : {}),
      ...(event.body.text ? { text: event.body.text } : {}),
      ...(event.body.hitBreakpointIds ? { hitBreakpointIds: event.body.hitBreakpointIds } : {}),
      ...(event.body.allThreadsStopped !== undefined ? { allThreadsStopped: event.body.allThreadsStopped } : {}),
    };
    this.lastStop = { revision, threadId: event.body.threadId, details };
    this.lastStoppedThreadId = event.body.threadId;
    if (event.body.allThreadsStopped) this.allThreadsStoppedRevision = revision;

    if (event.body.allThreadsStopped) {
      for (const thread of this.threadsById.values()) this.updateStoppedThread(thread, revision, details);
    }
    if (event.body.threadId !== undefined) {
      const thread = this.getOrCreateThread(event.body.threadId);
      this.updateStoppedThread(thread, revision, details);
    }
    this.notifyChange();
  }

  private updateStoppedThread(thread: ThreadRecord, revision: number, details: StopDetails): void {
    thread.state = "stopped";
    thread.executionRevision++;
    thread.lastEventRevision = revision;
    thread.stop = details;
  }

  private markContinued(threadId: number, allThreads: boolean): void {
    const revision = ++this.revision;
    if (allThreads) this.allThreadsStoppedRevision = undefined;
    const affected = allThreads ? [...this.threadsById.values()] : [this.getOrCreateThread(threadId)];
    for (const thread of affected) {
      if (thread.state === "exited") continue;
      thread.state = "running";
      thread.executionRevision++;
      thread.lastEventRevision = revision;
      thread.stop = undefined;
    }
    this.notifyChange();
  }

  private handleThread(event: DebugProtocol.ThreadEvent): void {
    const revision = ++this.revision;
    const thread = this.getOrCreateThread(event.body.threadId);
    thread.executionRevision++;
    thread.lastEventRevision = revision;
    if (event.body.reason === "exited") {
      thread.state = "exited";
      thread.stop = undefined;
    } else if (event.body.reason === "started" && thread.state === "exited") {
      thread.state = "unknown";
    }
    this.notifyChange();
  }

  private invalidateThreads(event: DebugProtocol.InvalidatedEvent): void {
    const revision = ++this.revision;
    const threadIds = event.body?.threadId !== undefined ? [event.body.threadId] : [...this.threadsById.keys()];
    for (const id of threadIds) {
      const thread = this.threadsById.get(id);
      if (!thread) continue;
      thread.executionRevision++;
      thread.lastEventRevision = revision;
    }
    this.notifyChange();
  }

  private handleReverseRequest(request: DebugProtocol.Request): void {
    this.adapter.sendResponse({
      seq: 0,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: false,
      message: `Reverse request '${request.command}' is not supported by pi-debug.`,
    });
  }

  private handleAdapterError(error: Error): void {
    this.recordTerminal({ kind: "error", message: error.message });
    void this.close("error").catch(() => undefined);
  }

  private handleAdapterExit(code: number | null): void {
    this.adapterExited = true;
    if (this.phase !== "stopping" && !this.terminal) {
      this.recordTerminal({
        kind: code === 0 || code === null ? "adapterExit" : "error",
        ...(code !== null ? { exitCode: code } : {}),
        ...(code !== 0 && code !== null ? { message: `Debug adapter exited with code ${code}.` } : {}),
      });
    }
    void this.close("adapterExit").catch(() => undefined);
  }

  private recordTerminal(value: Omit<TerminalState, "revision">): void {
    const revision = ++this.revision;
    const previous = this.terminal;
    this.terminal = {
      ...value,
      revision,
      ...(value.exitCode === undefined && previous?.exitCode !== undefined ? { exitCode: previous.exitCode } : {}),
      ...(previous?.kind === "error" && value.kind !== "error"
        ? { kind: "error" as const, message: previous.message }
        : {}),
    };
    this.notifyChange();
  }

  private mergeCapabilities(capabilities: DebugProtocol.Capabilities | undefined): void {
    if (capabilities) Object.assign(this.capabilities, capabilities);
  }

  private getOrCreateThread(id: number): ThreadRecord {
    let thread = this.threadsById.get(id);
    if (!thread) {
      thread = { id, state: "unknown", executionRevision: 0, lastEventRevision: 0 };
      this.threadsById.set(id, thread);
    }
    return thread;
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  private assertActive(): void {
    if (this.phase !== "active") throw new Error(`Debug session is not active; current state is '${this.phase}'.`);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private request<T extends DebugProtocol.Response>(
    command: string,
    args: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        rejectPromise(abortError(signal));
        return;
      }
      let settled = false;
      const aborted = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", aborted);
        rejectPromise(abortError(signal));
      };
      signal?.addEventListener("abort", aborted, { once: true });
      this.adapter.sendRequest(
        command,
        args,
        (response) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", aborted);
          if (!response.success) {
            rejectPromise(new Error(formatResponseError(response)));
            return;
          }
          resolvePromise(response as T);
        },
        timeoutMs,
      );
    });
  }
}
