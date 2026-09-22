import type { DebugProtocol } from "@vscode/debugprotocol";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DebugConfiguration } from "../config/launch-config.js";
import type { DapRequestArguments, DapRequestCommand, DapResponse, DebugAdapter } from "../dap/index.js";
import type {
  BreakpointSet,
  DebuggeeExit,
  EvaluateOptions,
  Evaluation,
  ExecutionOutcome,
  Inspection,
  InspectOptions,
  Output,
  OutputOptions,
  Page,
  PaginationOptions,
  PauseOptions,
  ResumeOptions,
  SessionEndReason,
  SessionStatus as SessionSnapshot,
  SessionStartOptions,
  SessionState,
  SetBreakpointsResult,
  SourceBreakpoints,
  SourceContext,
  StackTrace,
  StackTraceOptions,
  StartResult,
  Stop,
  ThreadSnapshot,
  ThreadState,
  Variables,
  VariablesOptions,
  WaitOptions,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
const OUTPUT_BUFFER_LIMIT = 1_000;

interface Thread {
  id: number;
  name?: string;
  state: ThreadState;
  executionRevision: number;
  lastRevision: number;
  stop?: Stop;
}

/** One persistent Debug Adapter Protocol session and its command semantics. */
export class DebugSession {
  // Lifecycle and transport state
  private state: SessionState = { state: "starting" };
  private debuggeeExit: DebuggeeExit | undefined;
  private readonly lifetime = new AbortController();
  private transportStart: Promise<void> | undefined;
  private initializeCompleted = false;
  private adapterExited = false;
  private closePromise: Promise<void> | undefined;

  // Negotiated protocol state
  private capabilities: DebugProtocol.Capabilities = {};

  // Thread execution state
  private readonly threadsById = new Map<number, Thread>();
  private revision = 0;
  private lastStoppedThreadId: number | undefined;
  private lastStop: { revision: number; threadId?: number; details: Stop } | undefined;
  private allThreadsStoppedRevision: number | undefined;

  // Debuggee output state
  private readonly outputBuffer: DebugProtocol.OutputEvent["body"][] = [];

  // Startup handshake state
  private initializedSeen = false;
  private configureOnInitialized: (() => void) | undefined;

  // Concurrency coordination
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

  // State queries
  get isClosed(): boolean {
    return this.state.state === "closed";
  }

  snapshot(): SessionSnapshot {
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
      state: structuredClone(this.state),
      configuration: {
        name: this.configuration.name,
        type: this.configuration.type,
        request: this.configuration.request,
      },
      capabilities: {
        supportsSingleThreadExecutionRequests: this.capabilities.supportsSingleThreadExecutionRequests === true,
      },
      threads,
      ...(this.debuggeeExit ? { debuggeeExit: { ...this.debuggeeExit } } : {}),
    };
  }

  // Lifecycle commands

  /** Start the transport and complete the DAP configuration handshake. */
  async start(options: SessionStartOptions, signal?: AbortSignal): Promise<StartResult> {
    if (this.state.state !== "starting" || this.transportStart) {
      throw new Error(`Cannot start a debug session in state '${this.state.state}'.`);
    }
    const baseline = this.revision;
    const startupSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const onAbort = (): void => {
      void this.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal?.aborted) onAbort();
      startupSignal.throwIfAborted();
      // Register the resource acquisition before invoking adapter code, which may close us synchronously.
      this.transportStart = Promise.resolve().then(async () => {
        startupSignal.throwIfAborted();
        await this.adapter.startSession(startupSignal);
      });
      await this.transportStart;
      startupSignal.throwIfAborted();

      const initialize = await this.request(
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
        },
        START_TIMEOUT_MS,
        signal,
      );
      startupSignal.throwIfAborted();
      this.mergeCapabilities(initialize.body);
      this.initializeCompleted = true;

      const configurationDone = new Promise<BreakpointSet[]>((resolve, reject) => {
        this.configureOnInitialized = () => {
          this.configureOnInitialized = undefined;
          void this.configure(options.breakpoints, startupSignal).then(resolve, reject);
        };
      });
      const configured = withTimeout(configurationDone, START_TIMEOUT_MS, "debug configuration", startupSignal);
      // initialized may arrive before the initialize continuation installs the configuration callback.
      if (this.initializedSeen) this.configureOnInitialized?.();

      const launchOrAttach = this.request(this.configuration.request, this.configuration, START_TIMEOUT_MS, signal);
      const [, breakpoints] = await Promise.all([launchOrAttach, configured]);

      startupSignal.throwIfAborted();
      this.state = { state: "active" };
      const waited = await this.waitAfter(baseline, { waitMs: options.waitMs }, signal);
      return {
        execution: waited,
        breakpoints,
      };
    } catch (error) {
      await this.beginClose({ kind: "error", message: errorMessage(error) });
      throw error;
    } finally {
      this.configureOnInitialized = undefined;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Request closure and await cleanup. Failures are reported in the final status, not thrown. */
  close(): Promise<void> {
    return this.beginClose({ kind: "requested" });
  }

  // Breakpoint commands

  /** Replace all source breakpoints in one file. */
  async setBreakpoints(file: string, lines: readonly number[], signal?: AbortSignal): Promise<SetBreakpointsResult> {
    this.assertActive();
    return this.withMutation(async () => {
      this.assertActive();
      const breakpoints = await this.sendBreakpoints(file, lines, signal);
      return { breakpoints: { source: { path: resolve(this.cwd, file) }, breakpoints: breakpoints } };
    });
  }

  // Execution commands

  /** Continue a stopped thread or all threads. */
  async continue(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.resume("continue", options, signal);
  }

  /** Step over in a stopped thread. */
  async next(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.resume("next", options, signal);
  }

  /** Step into in a stopped thread. */
  async stepIn(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.resume("stepIn", options, signal);
  }

  /** Step out in a stopped thread. */
  async stepOut(options: ResumeOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.resume("stepOut", options, signal);
  }

  /** Pause a running thread and optionally wait for the resulting stop. */
  async pause(options: PauseOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    this.assertActive();
    let baseline = this.revision;
    let threadId = 0;

    await this.withMutation(async () => {
      this.assertActive();
      threadId = await this.selectRunningThread(options.threadId, signal);
      baseline = this.revision;
      await this.request("pause", { threadId }, REQUEST_TIMEOUT_MS, signal);
    }).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (!this.lifetime.signal.aborted || error !== this.lifetime.signal.reason) throw error;
    });

    return this.waitAfter(baseline, { threadId, waitMs: options.waitMs }, signal);
  }

  /** Wait for a new stop, thread exit or completed closure; an already closed session returns immediately. */
  async wait(options: WaitOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.waitAfter(this.revision, options, signal);
  }

  // Inspection commands

  /** Refresh and return a page of active threads. */
  async threads(options: PaginationOptions, signal?: AbortSignal): Promise<Page<ThreadSnapshot>> {
    this.assertActive();
    const all = await this.fetchThreads(signal);
    const page = all.slice(options.start, options.start + options.count).map(toThreadSnapshot);
    const nextStart = options.start + page.length < all.length ? options.start + page.length : undefined;
    return {
      start: options.start,
      items: page,
      ...(nextStart !== undefined ? { nextStart } : {}),
      total: all.length,
    };
  }

  /** Return a page of stack frames for a stopped thread. */
  async stackTrace(options: StackTraceOptions, signal?: AbortSignal): Promise<StackTrace> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const response = await this.request(
      "stackTrace",
      {
        threadId: thread.id,
        startFrame: options.start,
        levels: options.count,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    const frames = response.body.stackFrames.map((data, offset) => ({ index: options.start + offset, data }));
    const total = response.body.totalFrames;
    const nextStart =
      frames.length === options.count && (total === undefined || options.start + frames.length < total)
        ? options.start + frames.length
        : undefined;
    return {
      threadId: thread.id,
      stack: {
        start: options.start,
        items: frames,
        ...(total !== undefined ? { total } : {}),
        ...(nextStart !== undefined ? { nextStart } : {}),
      },
    };
  }

  /** Return one page of direct children from a scope or variable container. */
  async variables(options: VariablesOptions, signal?: AbortSignal): Promise<Variables> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    let variablesReference: number;
    let container: Variables["container"];

    if (options.variablesReference !== undefined) {
      if (options.variablesReference <= 0) throw new Error("variablesReference must be greater than zero.");
      variablesReference = options.variablesReference;
      container = { kind: "variable", variablesReference };
    } else {
      const frame = await this.resolveFrame(thread.id, options.frame, revision, signal);
      const scope = await this.resolveScope(frame.id, options.scope, thread.id, revision, signal);
      variablesReference = scope.variablesReference;
      container = { kind: "scope", frameIndex: options.frame, scope };
    }

    const page = await this.readVariablesPage(
      variablesReference,
      options.start,
      options.count,
      thread.id,
      revision,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    return {
      threadId: thread.id,
      container,
      variables: {
        start: options.start,
        items: page.variables,
        ...(page.nextStart !== undefined ? { nextStart: page.nextStart } : {}),
      },
    };
  }

  /** Evaluate an expression in a stopped stack frame. */
  async evaluate(options: EvaluateOptions, signal?: AbortSignal): Promise<Evaluation> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const frame = await this.resolveFrame(thread.id, options.frame, revision, signal);
    const response = await this.request(
      "evaluate",
      {
        expression: options.expression,
        frameId: frame.id,
        context: "watch",
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);
    return { threadId: thread.id, frameIndex: options.frame, data: response.body };
  }

  /** Return a page of buffered debuggee output. */
  output(options: OutputOptions): Page<Output> {
    const all = options.category
      ? this.outputBuffer.filter((entry) => entry.category === options.category)
      : this.outputBuffer;
    const output = all.slice(options.start, options.start + options.count);
    const nextStart = options.start + output.length < all.length ? options.start + output.length : undefined;
    return {
      start: options.start,
      items: output,
      ...(nextStart !== undefined ? { nextStart } : {}),
      total: all.length,
    };
  }

  /** Return a fixed-budget overview of a stopped thread and one selected frame. */
  async inspect(options: InspectOptions, signal?: AbortSignal): Promise<Inspection> {
    this.assertActive();
    const thread = await this.selectStoppedThread(options.threadId, signal);
    const revision = thread.executionRevision;
    const stackResponse = await this.request(
      "stackTrace",
      { threadId: thread.id, startFrame: 0, levels: 20 },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(thread.id, revision);

    const frames = stackResponse.body.stackFrames.map((data, index) => ({ index, data }));
    const selectedFrame = frames[options.frame] ?? {
      index: options.frame,
      data: await this.resolveFrame(thread.id, options.frame, revision, signal),
    };
    const scopesResponse = await this.request("scopes", { frameId: selectedFrame.data.id }, REQUEST_TIMEOUT_MS, signal);
    this.assertThreadRevision(thread.id, revision);

    const scopes = scopesResponse.body.scopes;
    const selected = this.selectInspectScope(scopes, options.scope);
    const page = selected
      ? await this.readVariablesPage(selected.variablesReference, 0, 50, thread.id, revision, signal)
      : undefined;
    this.assertThreadRevision(thread.id, revision);

    const total = stackResponse.body.totalFrames;
    const stackNextStart =
      (total !== undefined && frames.length < total) || (total === undefined && frames.length === 20)
        ? frames.length
        : undefined;
    const sourcePath = selectedFrame.data.source?.path;
    const sourceContext = sourcePath ? await this.readSourceContext(sourcePath, selectedFrame.data.line) : undefined;
    this.assertThreadRevision(thread.id, revision);
    return {
      thread: toThreadSnapshot(thread),
      stack: {
        start: 0,
        items: frames,
        ...(total !== undefined ? { total } : {}),
        ...(stackNextStart !== undefined ? { nextStart: stackNextStart } : {}),
      },
      selection: {
        frame: selectedFrame,
        scopes: scopes,
        ...(selected && page
          ? {
              variables: {
                threadId: thread.id,
                container: { kind: "scope", frameIndex: options.frame, scope: selected },
                variables: {
                  start: 0,
                  items: page.variables,
                  ...(page.nextStart !== undefined ? { nextStart: page.nextStart } : {}),
                },
              },
            }
          : {}),
        ...(sourceContext ? { sourceContext } : {}),
      },
    };
  }

  // Lifecycle and configuration

  private beginClose(reason: SessionEndReason): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Publish the promise before abort/notifications can reenter close().
    this.closePromise = Promise.resolve().then(() => this.closeOnce(reason));
    this.state = { state: "closing", reason };
    this.lifetime.abort(new Error("Debug session is closing."));
    this.notifyChange();
    return this.closePromise;
  }

  private async closeOnce(reason: SessionEndReason): Promise<void> {
    const errors: string[] = [];
    // Await only resource acquisition: start() itself waits for this cleanup on failure.
    await this.transportStart?.catch(() => undefined);

    // DAP forbids further requests before the initialize response, even during startup cancellation.
    if (this.initializeCompleted && !this.adapterExited) {
      const args: DebugProtocol.DisconnectArguments = {};
      if (this.capabilities.supportTerminateDebuggee) {
        args.terminateDebuggee = reason.kind !== "terminated" && this.configuration.request === "launch";
      }
      try {
        await this.sendRequest("disconnect", args, reason.kind === "error" ? 200 : DISCONNECT_TIMEOUT_MS);
      } catch {
        // Local resource cleanup remains authoritative if graceful disconnect fails.
      }
    }
    try {
      await this.adapter.stopSession();
    } catch (error) {
      errors.push(`stopSession: ${errorMessage(error)}`);
    }
    try {
      this.adapter.dispose();
    } catch (error) {
      errors.push(`dispose: ${errorMessage(error)}`);
    }
    this.state = {
      state: "closed",
      reason,
      ...(errors.length ? { cleanupError: errors.join("; ") } : {}),
    };
    this.notifyChange();
  }

  private async configure(breakpoints: readonly SourceBreakpoints[], signal: AbortSignal): Promise<BreakpointSet[]> {
    signal.throwIfAborted();
    const byFile = new Map<string, Set<number>>();
    for (const source of breakpoints) {
      const path = resolve(this.cwd, source.file);
      const lines = byFile.get(path) ?? new Set<number>();
      source.lines.forEach((line) => lines.add(line));
      byFile.set(path, lines);
    }
    const supportsConfigurationDone = this.capabilities.supportsConfigurationDoneRequest === true;
    let configurationFailed = false;
    try {
      const sourceBreakpoints = Promise.all(
        [...byFile].map(async ([file, lines]) => ({
          source: { path: file },
          breakpoints: await this.sendBreakpoints(file, [...lines], signal),
        })),
      );
      if (supportsConfigurationDone) {
        const [results] = await Promise.all([
          sourceBreakpoints,
          this.capabilities.exceptionBreakpointFilters?.length
            ? this.request("setExceptionBreakpoints", { filters: [] }, START_TIMEOUT_MS, signal)
            : undefined,
        ]);
        return results;
      }
      const results = await sourceBreakpoints;
      // Legacy adapters use the last exception-breakpoint request as the configuration barrier.
      await this.request("setExceptionBreakpoints", { filters: [] }, START_TIMEOUT_MS, signal);
      return results;
    } catch (error) {
      configurationFailed = true;
      throw error;
    } finally {
      // Complete the handshake even if a breakpoint request failed, unless closure/cancellation has begun.
      if (supportsConfigurationDone && !signal.aborted) {
        try {
          await this.request("configurationDone", {}, START_TIMEOUT_MS, signal);
        } catch (error) {
          // A secondary handshake failure must not replace the original configuration error.
          if (!configurationFailed) throw error;
        }
      }
    }
  }

  // Breakpoints

  private async sendBreakpoints(
    file: string,
    lines: readonly number[],
    signal?: AbortSignal,
  ): Promise<DebugProtocol.Breakpoint[]> {
    const path = resolve(this.cwd, file);
    const requested = [...new Set(lines)].sort((a, b) => a - b);
    const response = await this.request(
      "setBreakpoints",
      {
        source: { path },
        breakpoints: requested.map((line) => ({ line })),
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return response.body.breakpoints;
  }

  // Execution and waiting

  private async resume(
    command: "continue" | "next" | "stepIn" | "stepOut",
    options: ResumeOptions,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
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
      const response = await this.request(
        command,
        { threadId, singleThread: options.singleThread },
        REQUEST_TIMEOUT_MS,
        signal,
      );

      this.assertActive();
      const currentThread = this.threadsById.get(threadId);
      if (currentThread?.state === "stopped" && currentThread.executionRevision === threadRevision) {
        const responseAllThreads = (response.body as { allThreadsContinued?: boolean } | undefined)
          ?.allThreadsContinued;
        this.markContinued(threadId, responseAllThreads ?? !options.singleThread);
      }
    }).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (!this.lifetime.signal.aborted || error !== this.lifetime.signal.reason) throw error;
    });

    return this.waitAfter(baseline, { threadId, waitMs: options.waitMs }, signal);
  }

  private async waitAfter(baseline: number, options: WaitOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    const deadline = Date.now() + options.waitMs;
    while (true) {
      signal?.throwIfAborted();
      const outcome = this.findWaitOutcome(baseline, options.threadId);
      if (outcome) {
        const enriched = await this.enrichExecutionResult(outcome, signal);
        if (outcome.kind !== "stopped" || !this.lifetime.signal.aborted) return enriched;
        continue;
      }
      if (options.waitMs === 0 || Date.now() >= deadline) return { kind: "timeout", status: this.snapshot() };
      await this.waitForChange(deadline - Date.now(), signal);
    }
  }

  private findWaitOutcome(baseline: number, threadId?: number): ExecutionOutcome | undefined {
    if (this.isClosed) return { kind: "closed", status: this.snapshot() };
    if (this.state.state === "closing") return undefined;

    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (thread && thread.lastRevision > baseline) {
        if (thread.state === "stopped") return { kind: "stopped", thread: toThreadSnapshot(thread) };
        if (thread.state === "exited") return { kind: "threadExited", threadId };
      }
      return undefined;
    }

    if (this.lastStop && this.lastStop.revision > baseline) {
      const thread = this.lastStop.threadId === undefined ? undefined : this.threadsById.get(this.lastStop.threadId);
      if (thread) return { kind: "stopped", thread: toThreadSnapshot(thread) };
    }
    return undefined;
  }

  private async enrichExecutionResult(result: ExecutionOutcome, signal?: AbortSignal): Promise<ExecutionOutcome> {
    if (result.kind !== "stopped" || !result.thread.stop) return result;

    try {
      const response = await this.request(
        "stackTrace",
        { threadId: result.thread.id, startFrame: 0, levels: 1 },
        REQUEST_TIMEOUT_MS,
        signal,
      );
      const data = response.body.stackFrames[0];
      if (!data) return result;
      return { ...result, thread: { ...result.thread, stop: { ...result.thread.stop, topFrame: { index: 0, data } } } };
    } catch {
      signal?.throwIfAborted();
      return result;
    }
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

  // Thread selection and inspection

  private async fetchThreads(signal?: AbortSignal): Promise<Thread[]> {
    const response = await this.request("threads", {}, REQUEST_TIMEOUT_MS, signal);
    this.assertActive();
    const activeIds = new Set(response.body.threads.map((thread) => thread.id));
    let removedThread = false;
    for (const thread of this.threadsById.values()) {
      if (thread.state === "exited" || activeIds.has(thread.id)) continue;
      const revision = ++this.revision;
      thread.state = "exited";
      thread.executionRevision++;
      thread.lastRevision = revision;
      thread.stop = undefined;
      removedThread = true;
    }
    for (const value of response.body.threads) {
      const existing = this.threadsById.get(value.id);
      if (existing) {
        existing.name = value.name;
        if (
          this.allThreadsStoppedRevision !== undefined &&
          existing.lastRevision < this.allThreadsStoppedRevision &&
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
          lastRevision: 0,
          ...(coveredByAllThreadsStop ? { stop: this.lastStop?.details } : {}),
        });
      }
    }
    if (removedThread) this.notifyChange();
    return [...this.threadsById.values()]
      .filter((thread) => thread.state !== "exited" && activeIds.has(thread.id))
      .sort((a, b) => a.id - b.id);
  }

  private async selectStoppedThread(threadId: number | undefined, signal?: AbortSignal): Promise<Thread> {
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

  private async resolveFrame(
    threadId: number,
    frameIndex: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<DebugProtocol.StackFrame> {
    const response = await this.request(
      "stackTrace",
      { threadId, startFrame: frameIndex, levels: 1 },
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
    const response = await this.request("scopes", { frameId }, REQUEST_TIMEOUT_MS, signal);
    this.assertThreadRevision(threadId, revision);
    const requested = requestedName.toLocaleLowerCase();
    const scope = response.body.scopes.find((candidate) => candidate.name.toLocaleLowerCase() === requested);
    if (scope) return scope;
    const available = response.body.scopes.map((candidate) => candidate.name).join(", ");
    throw new Error(`Scope '${requestedName}' is not available. Available scopes: ${available || "none"}.`);
  }

  private selectInspectScope(
    scopes: readonly DebugProtocol.Scope[],
    requestedName: string | undefined,
  ): DebugProtocol.Scope | undefined {
    if (requestedName !== undefined) {
      const requested = requestedName.toLocaleLowerCase();
      const scope = scopes.find((candidate) => candidate.name.toLocaleLowerCase() === requested);
      if (scope) return scope;
      const available = scopes.map((candidate) => candidate.name).join(", ");
      throw new Error(`Scope '${requestedName}' is not available. Available scopes: ${available || "none"}.`);
    }
    return (
      scopes.find((scope) => scope.presentationHint === "locals") ??
      scopes.find((scope) => scope.name.toLocaleLowerCase() === "locals") ??
      scopes.find((scope) => !scope.expensive) ??
      scopes[0]
    );
  }

  private async readSourceContext(path: string, line: number): Promise<SourceContext | undefined> {
    try {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      const startLine = Math.max(1, line - 2);
      return {
        path,
        lines: lines
          .slice(startLine - 1, Math.min(lines.length, line + 2))
          .map((content, index) => ({ line: startLine + index, content })),
      };
    } catch {
      return undefined;
    }
  }

  private async readVariablesPage(
    reference: number,
    start: number,
    count: number,
    threadId: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{ variables: DebugProtocol.Variable[]; nextStart?: number }> {
    if (reference <= 0) return { variables: [] };
    const response = await this.request(
      "variables",
      { variablesReference: reference, start, count: count + 1 },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertThreadRevision(threadId, revision);
    const variables = response.body.variables.slice(0, count);
    const nextStart = response.body.variables.length > count ? start + variables.length : undefined;
    return { variables, ...(nextStart !== undefined ? { nextStart } : {}) };
  }

  private assertThreadRevision(threadId: number, revision: number): void {
    this.assertActive();
    const thread = this.threadsById.get(threadId);
    if (!thread || thread.state !== "stopped" || thread.executionRevision !== revision) {
      throw new Error(`Thread ${threadId} resumed or changed while it was being inspected; inspect it again.`);
    }
  }

  // Adapter events and state transitions

  private handleEvent(event: DebugProtocol.Event): void {
    if (this.isClosed) return;
    if (this.state.state === "closing") {
      if (event.event !== "output" && event.event !== "exited") return;
    }

    switch (event.event) {
      case "initialized":
        this.initializedSeen = true;
        this.configureOnInitialized?.();
        break;
      case "capabilities":
        this.mergeCapabilities((event as DebugProtocol.CapabilitiesEvent).body.capabilities);
        break;
      case "output":
        this.outputBuffer.push((event as DebugProtocol.OutputEvent).body);
        if (this.outputBuffer.length > OUTPUT_BUFFER_LIMIT) this.outputBuffer.shift();
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
        this.debuggeeExit = { exitCode: exited.body.exitCode };
        this.notifyChange();
        break;
      }
      case "terminated":
        void this.beginClose({ kind: "terminated" });
        break;
    }
  }

  private handleStopped(event: DebugProtocol.StoppedEvent): void {
    const revision = ++this.revision;
    const details: Stop = { event: { ...event.body } };
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

  private updateStoppedThread(thread: Thread, revision: number, details: Stop): void {
    thread.state = "stopped";
    thread.executionRevision++;
    thread.lastRevision = revision;
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
      thread.lastRevision = revision;
      thread.stop = undefined;
    }
    this.notifyChange();
  }

  private handleThread(event: DebugProtocol.ThreadEvent): void {
    const revision = ++this.revision;
    const thread = this.getOrCreateThread(event.body.threadId);
    thread.executionRevision++;
    thread.lastRevision = revision;
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
      thread.lastRevision = revision;
    }
    this.notifyChange();
  }

  private handleReverseRequest(request: DebugProtocol.Request): void {
    if (this.isClosed) return;
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
    void this.beginClose({ kind: "error", message: error.message });
  }

  private handleAdapterExit(code: number | null): void {
    if (this.isClosed) return;
    this.adapterExited = true;
    void this.beginClose({
      kind: "error",
      message: `Debug adapter exited unexpectedly${code === null ? "." : ` with code ${code}.`}`,
    });
  }

  // State and request utilities

  private mergeCapabilities(capabilities: DebugProtocol.Capabilities | undefined): void {
    if (capabilities) Object.assign(this.capabilities, capabilities);
  }

  private getOrCreateThread(id: number): Thread {
    let thread = this.threadsById.get(id);
    if (!thread) {
      thread = { id, state: "unknown", executionRevision: 0, lastRevision: 0 };
      this.threadsById.set(id, thread);
    }
    return thread;
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  private assertActive(): void {
    if (this.state.state !== "active") {
      throw new Error(`Debug session is not active; current state is '${this.state.state}'.`);
    }
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

  private async request<C extends DapRequestCommand>(
    command: C,
    args: DapRequestArguments<C>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DapResponse<C>> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const response = await this.sendRequest(command, args, timeoutMs, combined);
    combined.throwIfAborted();
    return response;
  }

  private sendRequest<C extends DapRequestCommand>(
    command: C,
    args: DapRequestArguments<C>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DapResponse<C>> {
    return new Promise<DapResponse<C>>((resolvePromise, rejectPromise) => {
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
      try {
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
            resolvePromise(response as DapResponse<C>);
          },
          timeoutMs,
        );
      } catch (error) {
        settled = true;
        signal?.removeEventListener("abort", aborted);
        rejectPromise(error);
      }
    });
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    signal.throwIfAborted();
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = (): void => {
      cleanup();
      rejectPromise(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for ${operation}.`));
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatResponseError(response: DebugProtocol.Response): string {
  const errorResponse = response as DebugProtocol.ErrorResponse;
  const error = errorResponse.body?.error;
  if (!error) return response.message || `Debug adapter rejected '${response.command}'.`;

  return error.format.replace(/{([^{}]+)}/g, (placeholder, name: string) => error.variables?.[name] ?? placeholder);
}

function toThreadSnapshot(thread: Thread): ThreadSnapshot {
  return {
    id: thread.id,
    ...(thread.name ? { name: thread.name } : {}),
    state: thread.state,
    ...(thread.stop ? { stop: thread.stop } : {}),
  };
}
