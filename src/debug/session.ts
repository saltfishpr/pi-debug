import type { DebugProtocol } from "@vscode/debugprotocol";
import { resolve } from "node:path";
import type { DebugConfiguration } from "../config/launch-config.js";
import type { DapRequestMap, DebugAdapter } from "../dap/index.js";
import { finishesWithin, observe } from "./async.js";
import { DapClient } from "./dap-client.js";
import { abortError, DebugError, throwIfAborted } from "./errors.js";
import type {
  BreakpointsResult,
  ExecuteAction,
  ExecuteOptions,
  ExecutionOutcome,
  FrameSelection,
  FunctionBreakpointSpec,
  FunctionBreakpointsResult,
  InitialBreakpoints,
  InitialBreakpointsResult,
  Inspection,
  OutputOptions,
  Page,
  PageInfo,
  PageOptions,
  SessionEndReason,
  SessionSnapshot,
  SessionState,
  SourceBreakpoints,
  SourceBreakpointSpec,
  StackResult,
  StartOptions,
  StopContext,
  StoppedThread,
  ThreadSelection,
  ThreadSnapshot,
  ThreadState,
  VariablesResult,
  VariablesSelection,
  WaitOptions,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
const START_CLEANUP_WAIT_MS = 5_000;

interface ThreadRecord {
  id: number;
  name?: string;
  state: ThreadState;
  // Prevent an older response from overwriting newer evidence about this thread.
  lastChangedRevision: number;
  // Keep references valid across unrelated stops while this thread stays stopped.
  stopRevision?: number;
  stop?: DebugProtocol.StoppedEvent["body"];
}

interface StopEventRecord {
  revision: number;
  body: DebugProtocol.StoppedEvent["body"];
  threadId?: number;
}

/** One DAP session, including its observed thread state and all debug operations. */
export class DebugSession {
  private readonly client: DapClient;
  private readonly lifetime = new AbortController();
  private readonly threadsById = new Map<number, ThreadRecord>();
  private readonly changeWaiters = new Set<() => void>();
  private readonly outputEvents: DebugProtocol.OutputEvent["body"][] = [];
  private readonly pendingBreakpointFiles = new Set<string>();
  private pendingFunctionBreakpoints = false;

  private state: SessionState = { state: "starting" };
  private capabilities: DebugProtocol.Capabilities = {};
  private revision = 0;
  private lastStoppedThreadId: number | undefined;
  private lastStop: StopEventRecord | undefined;
  private pendingAllStop: StopEventRecord | undefined;
  private debuggeeExit: { exitCode: number } | undefined;

  private initializedSeen = false;
  private initializedCompleted = false;
  private launchDispatched = false;
  private transportFailed = false;
  private transportStart: Promise<void> | undefined;
  private startCalled = false;
  private cleanupPromise: Promise<void> | undefined;
  private busy = false;
  private pendingExecution = false;

  constructor(
    private readonly adapter: DebugAdapter,
    private readonly configuration: DebugConfiguration,
    private readonly cwd: string,
  ) {
    this.client = new DapClient(adapter);
    adapter.onEvent((event) => {
      try {
        this.handleEvent(event);
      } catch (error) {
        void this.close({ kind: "error", message: errorMessage(error) });
      }
    });
    adapter.onRequest((request) => this.handleReverseRequest(request));
    adapter.onError((error) => this.handleTransportFailure(error));
    adapter.onExit((code) => this.handleTransportFailure(new Error(`Debug adapter exited with code ${code}.`)));
  }

  get isClosed(): boolean {
    return this.state.state === "closed";
  }

  /** Return only state already observed locally; this never asks the adapter for threads. */
  snapshot(): SessionSnapshot {
    return {
      configuration: {
        name: this.configuration.name,
        type: this.configuration.type,
        request: this.configuration.request,
      },
      capabilities: {
        supportsSingleThreadExecutionRequests: this.capabilities.supportsSingleThreadExecutionRequests === true,
        supportsConditionalBreakpoints: this.capabilities.supportsConditionalBreakpoints === true,
        supportsHitConditionalBreakpoints: this.capabilities.supportsHitConditionalBreakpoints === true,
        supportsLogPoints: this.capabilities.supportsLogPoints === true,
        supportsFunctionBreakpoints: this.capabilities.supportsFunctionBreakpoints === true,
      },
      state: structuredClone(this.state),
      revision: this.revision,
      threads: [...this.threadsById.values()]
        .filter((thread) => thread.state !== "exited")
        .sort((a, b) => a.id - b.id)
        .map((thread) => this.threadSnapshot(thread)),
      ...(this.debuggeeExit ? { debuggeeExit: { ...this.debuggeeExit } } : {}),
    };
  }

  /** Complete the startup handshake, then observe an initial stop for waitMs. */
  async start(
    options: StartOptions,
    signal?: AbortSignal,
  ): Promise<{ execution: ExecutionOutcome; breakpoints: InitialBreakpointsResult }> {
    if (this.startCalled || this.state.state !== "starting") {
      throw new DebugError("INVALID_STATE", "Debug session startup has already begun.");
    }
    this.startCalled = true;

    const deadline = new AbortController();
    const remaining = options.deadline - Date.now();
    const timeoutError = new DebugError("REQUEST_TIMEOUT", "Debug session startup timed out.", {
      timeoutMs: 30_000,
    });
    const timer = setTimeout(() => deadline.abort(timeoutError), Math.max(0, remaining));
    const startupSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal, deadline.signal])
      : AbortSignal.any([this.lifetime.signal, deadline.signal]);

    let breakpoints: InitialBreakpointsResult;
    let baseline: number;
    try {
      this.assertWaitMs(options.waitMs);
      throwIfAborted(startupSignal);
      this.transportStart = Promise.resolve().then(() => this.adapter.startSession(startupSignal));
      await observe(
        this.transportStart.catch((error: unknown) => {
          if (startupSignal.aborted) throw abortError(startupSignal);
          throw new DebugError("CONNECTION_ERROR", `Unable to start debug adapter: ${errorMessage(error)}`, undefined, {
            cause: error,
          });
        }),
        startupSignal,
      );
      this.assertStarting();

      const initialize = await this.call(
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
        this.startupRequestTimeout(options.deadline),
        startupSignal,
      );
      this.assertStarting();
      this.capabilities = { ...this.capabilities, ...initialize.body };
      this.initializedCompleted = true;

      baseline = this.revision;
      this.launchDispatched = true;
      const launched = this.call(
        this.configuration.request,
        this.configuration,
        this.startupRequestTimeout(options.deadline),
        startupSignal,
      );
      // A launch response may wait for configurationDone, so both paths must progress together.
      const [launchResponse, configured] = await Promise.all([
        launched,
        this.configure(options.breakpoints, options.deadline, startupSignal),
      ]);
      this.assertStarting();
      this.capabilities = { ...this.capabilities, ...launchResponse.body };
      breakpoints = configured;
      this.state = { state: "active" };
      this.notifyChange();
    } catch (error) {
      const reason: SessionEndReason =
        error instanceof DebugError && error.code === "CANCELLED"
          ? { kind: "requested" }
          : { kind: "error", message: errorMessage(error) };
      const cleanup = this.close(reason);
      await finishesWithin(cleanup, START_CLEANUP_WAIT_MS);
      const finalState = this.snapshot().state;
      const cleanupError = finalState.state === "closed" ? finalState.cleanupError : undefined;
      if (cleanupError && error instanceof DebugError) {
        throw new DebugError(error.code, error.message, { ...error.details, cleanupError }, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    return {
      breakpoints,
      execution: await this.waitAfter(baseline, { waitMs: options.waitMs }, signal),
    };
  }

  /** Begin one cleanup task; its final error, if any, is retained in the closed snapshot. */
  close(reason: SessionEndReason = { kind: "requested" }): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = Promise.resolve().then(() => this.closeOnce(reason));
    this.state = { state: "closing", reason };
    this.lifetime.abort(
      reason.kind === "error"
        ? new DebugError("CONNECTION_ERROR", reason.message)
        : new DebugError("INVALID_STATE", "Debug session is closing."),
    );
    this.client.failPending(abortError(this.lifetime.signal));
    this.notifyChange();
    return this.cleanupPromise;
  }

  /** Replace all source breakpoints in one file. */
  async setBreakpoints(source: SourceBreakpoints, signal?: AbortSignal): Promise<BreakpointsResult> {
    return this.withOperation(async () => {
      this.assertActive();
      const path = resolve(this.cwd, source.file);
      if (this.pendingBreakpointFiles.has(path)) {
        throw new DebugError("OPERATION_CONFLICT", `A breakpoint update for '${path}' is still pending.`);
      }
      const breakpoints = this.toDapBreakpoints(source.lines);
      const request = this.client.request(
        "setBreakpoints",
        { source: { path }, breakpoints },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      this.pendingBreakpointFiles.add(path);
      const settled = request.then(
        (response) => {
          this.pendingBreakpointFiles.delete(path);
          return response;
        },
        (error: unknown) => {
          this.pendingBreakpointFiles.delete(path);
          throw error;
        },
      );
      void settled.catch(() => undefined);
      const response = await observe(settled, this.operationSignal(signal));
      this.assertActive();
      return { source: { path }, body: response.body };
    }, signal);
  }

  /** Replace all function breakpoints; the list is global, not per-source. */
  async setFunctionBreakpoints(
    specs: FunctionBreakpointSpec[],
    signal?: AbortSignal,
  ): Promise<FunctionBreakpointsResult> {
    return this.withOperation(async () => {
      this.assertActive();
      if (this.capabilities.supportsFunctionBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support function breakpoints.");
      }
      if (this.pendingFunctionBreakpoints) {
        throw new DebugError("OPERATION_CONFLICT", "A function-breakpoint update is still pending.");
      }
      const breakpoints = this.toDapFunctionBreakpoints(specs);
      this.pendingFunctionBreakpoints = true;
      const request = this.client.request("setFunctionBreakpoints", { breakpoints }, { timeoutMs: REQUEST_TIMEOUT_MS });
      const settled = request.then(
        (response) => {
          this.pendingFunctionBreakpoints = false;
          return response;
        },
        (error: unknown) => {
          this.pendingFunctionBreakpoints = false;
          throw error;
        },
      );
      void settled.catch(() => undefined);
      const response = await observe(settled, this.operationSignal(signal));
      this.assertActive();
      return { body: response.body };
    }, signal);
  }

  /** Execute one control request and observe a currently valid stop, exit, or closure. */
  async execute(action: ExecuteAction, options: ExecuteOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    return this.withOperation(async () => {
      this.assertActive();
      this.assertWaitMs(options.waitMs);
      if (action !== "pause" && options.singleThread && !this.capabilities.supportsSingleThreadExecutionRequests) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support single-thread execution requests.");
      }
      if (action === "pause" && options.singleThread !== undefined) {
        throw new DebugError("INVALID_ARGUMENT", "`pause` does not accept singleThread.");
      }

      const targetId =
        action === "pause"
          ? this.selectPausableThread(options.threadId).id
          : this.selectStoppedThread(options).threadId;
      const baseline = this.revision;
      const command = action === "step_in" ? "stepIn" : action === "step_out" ? "stepOut" : action;
      const before = new Map([...this.threadsById].map(([id, thread]) => [id, thread.lastChangedRevision]));
      const args =
        action === "pause" ? { threadId: targetId } : { threadId: targetId, singleThread: options.singleThread };

      this.pendingExecution = true;
      const request = this.client.request(command, args, { timeoutMs: REQUEST_TIMEOUT_MS });
      const settled = request.then(
        (response) => {
          if (this.state.state === "active" && action !== "pause") {
            const all =
              action === "continue"
                ? (response as DebugProtocol.ContinueResponse).body?.allThreadsContinued !== false
                : options.singleThread !== true;
            this.applySuccessfulResume(targetId, all, before);
          }
          this.pendingExecution = false;
          return response;
        },
        (error: unknown) => {
          this.pendingExecution = false;
          throw error;
        },
      );
      void settled.catch(() => undefined);
      await observe(settled, this.operationSignal(signal));
      return this.waitAfter(
        baseline,
        { threadId: action === "pause" ? targetId : undefined, waitMs: options.waitMs },
        signal,
        targetId,
      );
    }, signal);
  }

  /** Observe without sending a DAP request. */
  async wait(options: WaitOptions, signal?: AbortSignal): Promise<ExecutionOutcome> {
    if (this.state.state === "closed") return { kind: "closed", snapshot: this.snapshot() };
    return this.withOperation(
      async () => {
        if (this.state.state === "starting") throw new DebugError("INVALID_STATE", "Debug session is still starting.");
        this.assertWaitMs(options.waitMs);
        if (options.threadId !== undefined && !this.threadsById.has(options.threadId)) {
          throw new DebugError("THREAD_NOT_FOUND", `Unknown thread ${options.threadId}.`, {
            threadId: options.threadId,
          });
        }
        return this.waitAfter(options.revision ?? -1, options, signal);
      },
      signal,
      true,
    );
  }

  /** Refresh active thread IDs and names, then return the requested page. */
  async threads(page: PageOptions, signal?: AbortSignal): Promise<Page<ThreadSnapshot>> {
    return this.withOperation(async () => {
      this.assertActive();
      this.assertPage(page);
      const before = new Map([...this.threadsById].map(([id, thread]) => [id, thread.lastChangedRevision]));
      const response = await this.call("threads", undefined, REQUEST_TIMEOUT_MS, signal);
      this.assertActive();
      if (!Array.isArray(response.body?.threads)) {
        throw new DebugError("CONNECTION_ERROR", "Malformed threads response.");
      }
      this.applyThreadsResponse(response.body.threads, before);
      const active = [...this.threadsById.values()]
        .filter((thread) => thread.state !== "exited")
        .sort((a, b) => a.id - b.id);
      return this.page(
        active.map((thread) => this.threadSnapshot(thread)),
        page,
      );
    }, signal);
  }

  /** Return complete DAP frames for one stack page. */
  async stackTrace(selection: ThreadSelection, page: PageOptions, signal?: AbortSignal): Promise<StackResult> {
    return this.withOperation(async () => {
      this.assertPage(page);
      const stop = this.selectStoppedThread(selection);
      const paged = this.capabilities.supportsDelayedStackTraceLoading === true;
      const response = await this.call(
        "stackTrace",
        paged ? { threadId: stop.threadId, startFrame: page.start, levels: page.count } : { threadId: stop.threadId },
        REQUEST_TIMEOUT_MS,
        signal,
      );
      this.assertStop(stop);
      if (!Array.isArray(response.body?.stackFrames)) {
        throw new DebugError("CONNECTION_ERROR", "Malformed stackTrace response.");
      }
      const frames = paged
        ? response.body.stackFrames.slice(0, page.count)
        : response.body.stackFrames.slice(page.start, page.start + page.count);
      const total = response.body.totalFrames ?? (paged ? undefined : response.body.stackFrames.length);
      return {
        ...stop,
        body: { ...response.body, stackFrames: frames },
        page: this.pageInfo(page, frames.length, total),
      };
    }, signal);
  }

  /** Read one scope or variable container while its stop revision remains valid. */
  async variables(selection: VariablesSelection, page: PageOptions, signal?: AbortSignal): Promise<VariablesResult> {
    return this.withOperation(async () => {
      this.assertPage(page);
      const stop = this.selectStoppedThread(selection);
      let reference: number;
      if ("variablesReference" in selection && selection.variablesReference !== undefined) {
        if (selection.revision === undefined || selection.variablesReference <= 0) {
          throw new DebugError("INVALID_ARGUMENT", "Expanding a variable requires a positive reference and revision.");
        }
        reference = selection.variablesReference;
      } else {
        const frame = await this.resolveFrame(stop, selection.frameIndex, signal);
        const scopes = await this.call("scopes", { frameId: frame.id }, REQUEST_TIMEOUT_MS, signal);
        this.assertStop(stop);
        if (!Array.isArray(scopes.body?.scopes)) {
          throw new DebugError("CONNECTION_ERROR", "Malformed scopes response.");
        }
        const matches = scopes.body.scopes.filter(
          (scope) => scope.name.toLowerCase() === selection.scope.toLowerCase(),
        );
        if (matches.length !== 1) {
          throw new DebugError("INVALID_ARGUMENT", `Scope '${selection.scope}' is missing or ambiguous.`, {
            availableScopes: scopes.body.scopes.map((scope) => scope.name),
          });
        }
        reference = matches[0].variablesReference;
      }

      if (reference === 0) {
        return { ...stop, body: { variables: [] }, page: this.pageInfo(page, 0, 0) };
      }
      const response = await this.call(
        "variables",
        { variablesReference: reference, start: page.start, count: page.count },
        REQUEST_TIMEOUT_MS,
        signal,
      );
      this.assertStop(stop);
      if (!Array.isArray(response.body?.variables)) {
        throw new DebugError("CONNECTION_ERROR", "Malformed variables response.");
      }
      const variables = response.body.variables.slice(0, page.count);
      return {
        ...stop,
        body: { ...response.body, variables },
        page: this.pageInfo(page, variables.length),
      };
    }, signal);
  }

  /** Evaluate in a selected stopped frame; expressions may have target-side effects. */
  async evaluate(
    selection: FrameSelection,
    expression: string,
    signal?: AbortSignal,
  ): Promise<Inspection<DebugProtocol.EvaluateResponse["body"]>> {
    return this.withOperation(async () => {
      if (!expression.trim()) throw new DebugError("INVALID_ARGUMENT", "Expression must not be empty.");
      const stop = this.selectStoppedThread(selection);
      const frame = await this.resolveFrame(stop, selection.frameIndex, signal);
      const response = await this.call(
        "evaluate",
        { expression, frameId: frame.id, context: "watch" },
        REQUEST_TIMEOUT_MS,
        signal,
      );
      this.assertStop(stop);
      return { ...stop, body: response.body };
    }, signal);
  }

  /** Return an event page after exact category filtering. */
  output(options: OutputOptions): Page<DebugProtocol.OutputEvent["body"]> {
    this.assertPage(options);
    const events = options.category
      ? this.outputEvents.filter((event) => event.category === options.category)
      : this.outputEvents;
    const result = this.page(events, options);
    return { ...result, items: result.items.map((event) => structuredClone(event)) };
  }

  private toDapBreakpoints(specs: SourceBreakpointSpec[]): DebugProtocol.SourceBreakpoint[] {
    return specs.map((spec) => {
      if (spec.condition !== undefined && this.capabilities.supportsConditionalBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support conditional breakpoints.");
      }
      if (spec.hitCondition !== undefined && this.capabilities.supportsHitConditionalBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support hit-count conditional breakpoints.");
      }
      if (spec.logMessage !== undefined && this.capabilities.supportsLogPoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support log points.");
      }
      return {
        line: spec.line,
        ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
        ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
        ...(spec.logMessage !== undefined ? { logMessage: spec.logMessage } : {}),
      };
    });
  }

  private toDapFunctionBreakpoints(specs: FunctionBreakpointSpec[]): DebugProtocol.FunctionBreakpoint[] {
    return specs.map((spec) => {
      if (spec.condition !== undefined && this.capabilities.supportsConditionalBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support conditional breakpoints.");
      }
      if (spec.hitCondition !== undefined && this.capabilities.supportsHitConditionalBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support hit-count conditional breakpoints.");
      }
      return {
        name: spec.name,
        ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
        ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
      };
    });
  }

  private async configure(
    breakpoints: InitialBreakpoints,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<InitialBreakpointsResult> {
    while (!this.initializedSeen) {
      this.assertStarting();
      throwIfAborted(signal);
      await this.waitForChange(this.startupRemaining(deadlineAt), signal);
    }

    const source: BreakpointsResult[] = [];
    const seen = new Set<string>();
    for (const entry of breakpoints.source ?? []) {
      const path = resolve(this.cwd, entry.file);
      if (seen.has(path)) {
        throw new DebugError("INVALID_ARGUMENT", `Initial breakpoints repeat source '${path}'.`);
      }
      seen.add(path);
      const response = await this.call(
        "setBreakpoints",
        { source: { path }, breakpoints: this.toDapBreakpoints(entry.lines) },
        this.startupRequestTimeout(deadlineAt),
        signal,
      );
      this.assertStarting();
      source.push({ source: { path }, body: response.body });
    }

    let functionResult: FunctionBreakpointsResult | undefined;
    if (breakpoints.function !== undefined) {
      if (this.capabilities.supportsFunctionBreakpoints !== true) {
        throw new DebugError("INVALID_ARGUMENT", "This adapter does not support function breakpoints.");
      }
      const response = await this.call(
        "setFunctionBreakpoints",
        { breakpoints: this.toDapFunctionBreakpoints(breakpoints.function) },
        this.startupRequestTimeout(deadlineAt),
        signal,
      );
      this.assertStarting();
      functionResult = { body: response.body };
    }

    const filters =
      this.capabilities.exceptionBreakpointFilters?.filter((filter) => filter.default).map((filter) => filter.filter) ??
      [];
    if (this.capabilities.exceptionBreakpointFilters?.length) {
      await this.call("setExceptionBreakpoints", { filters }, this.startupRequestTimeout(deadlineAt), signal);
      this.assertStarting();
    }
    if (this.capabilities.supportsConfigurationDoneRequest) {
      await this.call("configurationDone", undefined, this.startupRequestTimeout(deadlineAt), signal);
      this.assertStarting();
    }
    return { source, ...(functionResult ? { function: functionResult } : {}) };
  }

  private startupRemaining(deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new DebugError("REQUEST_TIMEOUT", "Debug session startup timed out.");
    return remaining;
  }

  private startupRequestTimeout(deadlineAt: number): number {
    return Math.min(REQUEST_TIMEOUT_MS, this.startupRemaining(deadlineAt));
  }

  private assertStarting(): void {
    if (this.state.state !== "starting") {
      throw new DebugError("INVALID_STATE", `Debug session is ${this.state.state}.`, { state: this.state.state });
    }
  }

  private selectPausableThread(threadId?: number): ThreadRecord {
    this.assertActive();
    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (!thread) throw new DebugError("THREAD_NOT_FOUND", `Unknown thread ${threadId}.`);
      if (thread.state === "running" || thread.state === "unknown") return thread;
      throw new DebugError("INVALID_STATE", `Thread ${threadId} cannot be paused from state '${thread.state}'.`);
    }
    const pausable = [...this.threadsById.values()].filter(
      (thread) => thread.state === "running" || thread.state === "unknown",
    );
    if (pausable.length !== 1) {
      throw new DebugError("THREAD_SELECTION_REQUIRED", "Specify one pausable thread.", {
        pausableThreadIds: pausable.map((thread) => thread.id),
      });
    }
    return pausable[0];
  }

  private selectStoppedThread(selection: ThreadSelection): StopContext {
    this.assertActive();
    let thread: ThreadRecord | undefined;
    if (selection.threadId !== undefined) {
      thread = this.threadsById.get(selection.threadId);
      if (!thread) throw new DebugError("THREAD_NOT_FOUND", `Unknown thread ${selection.threadId}.`);
    } else {
      thread = this.lastStoppedThreadId === undefined ? undefined : this.threadsById.get(this.lastStoppedThreadId);
      if (thread?.state !== "stopped") {
        const stopped = [...this.threadsById.values()].filter((entry) => entry.state === "stopped");
        if (stopped.length !== 1) {
          throw new DebugError("THREAD_SELECTION_REQUIRED", "Specify one stopped thread.", {
            stoppedThreadIds: stopped.map((entry) => entry.id),
          });
        }
        thread = stopped[0];
      }
    }
    if (thread.state !== "stopped" || thread.stopRevision === undefined) {
      throw new DebugError("INVALID_STATE", `Thread ${thread.id} is not stopped.`, { threadId: thread.id });
    }
    if (selection.revision !== undefined && selection.revision !== thread.stopRevision) {
      throw new DebugError("STALE_REVISION", `Thread ${thread.id} no longer has stop revision ${selection.revision}.`, {
        threadId: thread.id,
        revision: selection.revision,
        currentRevision: thread.stopRevision,
      });
    }
    return { threadId: thread.id, revision: thread.stopRevision };
  }

  private applySuccessfulResume(threadId: number, all: boolean, before: ReadonlyMap<number, number>): void {
    const candidates = all ? [...this.threadsById.values()] : [this.threadsById.get(threadId)];
    const unchanged = candidates.filter(
      (thread): thread is ThreadRecord =>
        thread !== undefined && thread.state !== "exited" && before.get(thread.id) === thread.lastChangedRevision,
    );
    if (!unchanged.length) return;
    const revision = ++this.revision;
    for (const thread of unchanged) this.setRunning(thread, revision);
    this.pendingAllStop = undefined;
    this.lastStop = undefined;
    this.notifyChange();
  }

  private async waitAfter(
    baseline: number,
    options: { threadId?: number; waitMs: number },
    signal?: AbortSignal,
    selectedThreadId?: number,
  ): Promise<ExecutionOutcome> {
    const deadline = Date.now() + options.waitMs;
    while (true) {
      throwIfAborted(signal);
      const outcome = this.findOutcome(baseline, options.threadId, selectedThreadId);
      if (outcome) return outcome;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", snapshot: this.snapshot() };
      await this.waitForChange(remaining, signal);
    }
  }

  private findOutcome(baseline: number, threadId?: number, selectedThreadId?: number): ExecutionOutcome | undefined {
    if (this.state.state === "closed") return { kind: "closed", snapshot: this.snapshot() };
    if (this.state.state === "closing") return undefined;
    if (threadId !== undefined) {
      const thread = this.threadsById.get(threadId);
      if (thread?.state === "exited") return { kind: "threadExited", threadId };
      if (thread?.state === "stopped" && thread.stopRevision !== undefined && thread.stopRevision > baseline) {
        return { kind: "stopped", thread: this.stoppedThread(thread) };
      }
      return undefined;
    }
    if (selectedThreadId !== undefined && this.threadsById.get(selectedThreadId)?.state === "exited") {
      return { kind: "threadExited", threadId: selectedThreadId };
    }
    const stopped = [...this.threadsById.values()]
      .filter(
        (thread) => thread.state === "stopped" && thread.stopRevision !== undefined && thread.stopRevision > baseline,
      )
      .sort((a, b) => b.stopRevision! - a.stopRevision!);
    if (stopped.length) return { kind: "stopped", thread: this.stoppedThread(stopped[0]) };
    if (
      this.lastStop?.revision !== undefined &&
      this.lastStop.revision > baseline &&
      this.lastStop.threadId === undefined
    ) {
      return { kind: "stopped", revision: this.lastStop.revision, stop: structuredClone(this.lastStop.body) };
    }
    return undefined;
  }

  private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted) return rejectPromise(abortError(signal));
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.changeWaiters.delete(done);
        signal?.removeEventListener("abort", aborted);
      };
      const done = (): void => {
        cleanup();
        resolvePromise();
      };
      const aborted = (): void => {
        cleanup();
        rejectPromise(abortError(signal!));
      };
      this.changeWaiters.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(done, timeoutMs);
    });
  }

  private notifyChange(): void {
    for (const notify of [...this.changeWaiters]) notify();
  }

  private applyThreadsResponse(values: DebugProtocol.Thread[], before: ReadonlyMap<number, number>): void {
    const activeIds = new Set(values.map((thread) => thread.id));
    const disappeared = [...this.threadsById.values()].filter(
      (thread) =>
        thread.state !== "exited" && !activeIds.has(thread.id) && before.get(thread.id) === thread.lastChangedRevision,
    );
    const discovered = values.filter((value) => {
      const existing = this.threadsById.get(value.id);
      return !existing || (existing.state === "exited" && before.get(value.id) === existing.lastChangedRevision);
    });
    const revision = disappeared.length || discovered.length ? ++this.revision : this.revision;

    for (const thread of disappeared) {
      thread.state = "exited";
      thread.stop = undefined;
      thread.stopRevision = undefined;
      thread.lastChangedRevision = revision;
    }
    for (const value of values) {
      const existing = this.threadsById.get(value.id);
      if (existing) {
        existing.name = value.name;
        if (existing.state === "exited" && before.get(value.id) === existing.lastChangedRevision) {
          existing.state = "unknown";
          existing.lastChangedRevision = revision;
        }
      } else {
        const stopped = this.pendingAllStop;
        this.threadsById.set(value.id, {
          id: value.id,
          name: value.name,
          state: stopped ? "stopped" : "unknown",
          lastChangedRevision: revision,
          ...(stopped ? { stopRevision: stopped.revision, stop: stopped.body } : {}),
        });
      }
    }
    this.pendingAllStop = undefined;
    if (disappeared.length || discovered.length) this.notifyChange();
  }

  private async resolveFrame(
    stop: StopContext,
    frameIndex: number,
    signal?: AbortSignal,
  ): Promise<DebugProtocol.StackFrame> {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new DebugError("INVALID_ARGUMENT", "frameIndex must be a non-negative integer.");
    }
    const paged = this.capabilities.supportsDelayedStackTraceLoading === true;
    const response = await this.call(
      "stackTrace",
      paged ? { threadId: stop.threadId, startFrame: frameIndex, levels: 1 } : { threadId: stop.threadId },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    this.assertStop(stop);
    const frames = response.body?.stackFrames;
    if (!Array.isArray(frames)) throw new DebugError("CONNECTION_ERROR", "Malformed stackTrace response.");
    const frame = paged ? frames[0] : frames[frameIndex];
    if (!frame) {
      throw new DebugError("INVALID_ARGUMENT", `Frame ${frameIndex} does not exist on thread ${stop.threadId}.`, {
        threadId: stop.threadId,
        frameIndex,
      });
    }
    return frame;
  }

  private assertStop(stop: StopContext): void {
    this.assertActive();
    const thread = this.threadsById.get(stop.threadId);
    if (thread?.state !== "stopped" || thread.stopRevision !== stop.revision) {
      throw new DebugError("STALE_REVISION", `Thread ${stop.threadId} changed while it was being inspected.`, {
        threadId: stop.threadId,
        revision: stop.revision,
      });
    }
  }

  private handleEvent(event: DebugProtocol.Event): void {
    if (this.state.state === "closed") return;
    if (this.state.state === "closing" && event.event !== "output" && event.event !== "exited") return;
    switch (event.event) {
      case "initialized":
        this.initializedSeen = true;
        this.notifyChange();
        break;
      case "capabilities":
        this.capabilities = {
          ...this.capabilities,
          ...(event as DebugProtocol.CapabilitiesEvent).body.capabilities,
        };
        break;
      case "output":
        this.outputEvents.push((event as DebugProtocol.OutputEvent).body);
        if (this.outputEvents.length > 1000) this.outputEvents.shift();
        break;
      case "stopped":
        this.handleStopped((event as DebugProtocol.StoppedEvent).body);
        break;
      case "continued": {
        const body = (event as DebugProtocol.ContinuedEvent).body;
        const revision = ++this.revision;
        const affected =
          body.allThreadsContinued === false
            ? [this.getOrCreateThread(body.threadId)]
            : [...this.threadsById.values(), this.getOrCreateThread(body.threadId)];
        for (const thread of new Set(affected)) {
          if (thread.state !== "exited") this.setRunning(thread, revision);
        }
        this.pendingAllStop = undefined;
        this.lastStop = undefined;
        this.notifyChange();
        break;
      }
      case "thread": {
        const body = (event as DebugProtocol.ThreadEvent).body;
        const thread = this.getOrCreateThread(body.threadId);
        const revision = ++this.revision;
        thread.state = body.reason === "exited" ? "exited" : "unknown";
        thread.stop = undefined;
        thread.stopRevision = undefined;
        thread.lastChangedRevision = revision;
        this.notifyChange();
        break;
      }
      case "exited":
        this.debuggeeExit = { exitCode: (event as DebugProtocol.ExitedEvent).body.exitCode };
        this.notifyChange();
        break;
      case "invalidated":
        this.handleInvalidated((event as DebugProtocol.InvalidatedEvent).body);
        break;
      case "terminated":
        void this.close({ kind: "terminated" });
        break;
    }
  }

  private handleInvalidated(body: DebugProtocol.InvalidatedEvent["body"]): void {
    // Missing areas means everything the client cached may be stale.
    const areas = new Set<DebugProtocol.InvalidatedAreas>(body.areas?.length ? body.areas : ["all"]);
    const all = areas.has("all");
    const invalidateStops = all || areas.has("stacks") || areas.has("variables");
    const invalidateThreads = all || areas.has("threads");
    if (!invalidateStops && !invalidateThreads) return;

    const targets =
      invalidateStops && body.threadId !== undefined
        ? [this.threadsById.get(body.threadId)].filter((thread): thread is ThreadRecord => thread !== undefined)
        : [...this.threadsById.values()];
    if (!targets.length) return;

    const revision = ++this.revision;
    for (const thread of targets) {
      if (thread.state === "exited") continue;
      // Refresh stopRevision so cached stop contexts become STALE_REVISION.
      if (invalidateStops && thread.state === "stopped") thread.stopRevision = revision;
      thread.lastChangedRevision = revision;
    }
    this.notifyChange();
  }

  private handleStopped(body: DebugProtocol.StoppedEvent["body"]): void {
    const revision = ++this.revision;
    const stop: StopEventRecord = { revision, body, threadId: body.threadId };
    this.lastStop = stop;
    if (body.allThreadsStopped) {
      this.pendingAllStop = stop;
      for (const thread of this.threadsById.values()) {
        if (thread.state === "exited") continue;
        if (thread.state !== "stopped" || thread.id === body.threadId) this.setStopped(thread, revision, body);
        else thread.lastChangedRevision = revision;
      }
    } else if (body.threadId === undefined) {
      // An anonymous stop must prevent a late resume response from overriding newer evidence.
      for (const thread of this.threadsById.values()) thread.lastChangedRevision = revision;
    }
    if (body.threadId !== undefined) {
      const thread = this.getOrCreateThread(body.threadId);
      this.setStopped(thread, revision, body);
      this.lastStoppedThreadId = body.threadId;
    }
    this.notifyChange();
  }

  private setStopped(thread: ThreadRecord, revision: number, body: DebugProtocol.StoppedEvent["body"]): void {
    thread.state = "stopped";
    thread.stopRevision = revision;
    thread.lastChangedRevision = revision;
    thread.stop = body;
  }

  private setRunning(thread: ThreadRecord, revision: number): void {
    thread.state = "running";
    thread.stopRevision = undefined;
    thread.stop = undefined;
    thread.lastChangedRevision = revision;
  }

  private getOrCreateThread(id: number): ThreadRecord {
    let thread = this.threadsById.get(id);
    if (!thread) {
      thread = { id, state: "unknown", lastChangedRevision: this.revision };
      this.threadsById.set(id, thread);
    }
    return thread;
  }

  private async closeOnce(reason: SessionEndReason): Promise<void> {
    const errors: string[] = [];
    try {
      await this.transportStart?.catch(() => undefined);
      if (this.initializedCompleted && this.launchDispatched && !this.transportFailed) {
        const args: DebugProtocol.DisconnectArguments = {};
        if (this.capabilities.supportTerminateDebuggee) {
          args.terminateDebuggee = this.configuration.request === "launch";
        }
        try {
          await this.client.request("disconnect", args, { timeoutMs: DISCONNECT_TIMEOUT_MS });
        } catch (error) {
          errors.push(`disconnect: ${errorMessage(error)}`);
        }
      }
      try {
        await this.adapter.stopSession();
      } catch (error) {
        errors.push(`stopSession: ${errorMessage(error)}`);
      }
    } finally {
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
  }

  private handleTransportFailure(error: Error): void {
    if (this.state.state === "closing" || this.state.state === "closed") return;
    this.transportFailed = true;
    void this.close({ kind: "error", message: error.message });
  }

  private handleReverseRequest(request: DebugProtocol.Request): void {
    if (this.state.state === "closed") return;
    try {
      this.adapter.sendResponse({
        seq: 0,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: false,
        message: `Reverse request '${request.command}' is not supported.`,
      });
    } catch (error) {
      this.handleTransportFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async call<C extends keyof DapRequestMap>(
    command: C,
    args: DapRequestMap[C][0],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DapRequestMap[C][1]> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    return observe(this.client.request(command, args, { timeoutMs }), operationSignal);
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }

  private async withOperation<T>(work: () => Promise<T>, signal?: AbortSignal, allowPending = false): Promise<T> {
    throwIfAborted(signal);
    if (this.busy || (this.pendingExecution && !allowPending)) {
      throw new DebugError("OPERATION_CONFLICT", "Another debug operation is still in progress.");
    }
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  private assertActive(): void {
    if (this.state.state !== "active") {
      throw new DebugError("INVALID_STATE", `Debug session is ${this.state.state}.`, { state: this.state.state });
    }
  }

  private assertWaitMs(waitMs: number): void {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new DebugError("INVALID_ARGUMENT", "waitMs must be an integer from 0 to 30000.");
    }
  }

  private assertPage(page: PageOptions): void {
    if (
      !Number.isInteger(page.start) ||
      page.start < 0 ||
      !Number.isInteger(page.count) ||
      page.count < 1 ||
      page.count > 100
    ) {
      throw new DebugError("INVALID_ARGUMENT", "Page start must be non-negative and count must be from 1 to 100.");
    }
  }

  private threadSnapshot(thread: ThreadRecord): ThreadSnapshot {
    return {
      id: thread.id,
      ...(thread.name !== undefined ? { name: thread.name } : {}),
      state: thread.state,
      ...(thread.state === "stopped" && thread.stopRevision !== undefined && thread.stop
        ? { revision: thread.stopRevision, stop: structuredClone(thread.stop) }
        : {}),
    };
  }

  private stoppedThread(thread: ThreadRecord): StoppedThread {
    return this.threadSnapshot(thread) as StoppedThread;
  }

  private page<T>(items: readonly T[], options: PageOptions): Page<T> {
    const selected = items.slice(options.start, options.start + options.count);
    return { ...this.pageInfo(options, selected.length, items.length), items: selected };
  }

  private pageInfo(options: PageOptions, length: number, total?: number): PageInfo {
    const next = options.start + length;
    return {
      ...options,
      ...(total !== undefined ? { total } : {}),
      ...(length === options.count && (total === undefined || next < total) ? { nextStart: next } : {}),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
