import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DapClient, RequestOptions } from "../client/dapClient";
import type { RequestArgs, RequestCommand, ResponseBody } from "../client/protocolMaps";
import { Deferred } from "../util/deferred";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import type { Disposable } from "../util/typedEmitter";
import { TypedEventEmitter } from "../util/typedEmitter";
import { SessionState, type DebugConfiguration, type SessionEvents, type SessionStartOptions, type ThreadInfo } from "./types";

let nextSessionId = 1;

/**
 * A single debug session: one connection to one adapter, driving one debuggee.
 *
 * Layered on top of {@link DapClient}, the session adds debugging semantics:
 *  - the initialize → launch/attach → configuration → configurationDone handshake;
 *  - capability tracking;
 *  - live state for threads, stack frames and the "focused" frame;
 *  - breakpoint synchronization;
 *  - typed convenience methods for the common control-flow requests.
 *
 * Parent/child relationships (from `startDebugging` reverse requests) are
 * tracked here and wired up by the {@link SessionManager}.
 */
export class Session extends TypedEventEmitter<SessionEvents> {
  readonly id: string;
  parent?: Session;
  readonly children = new Map<string, Session>();

  private _state: SessionState = SessionState.Initializing;
  private _capabilities: DebugProtocol.Capabilities = {};
  private readonly threads = new Map<number, ThreadInfo>();
  private _stoppedThreadId?: number;
  private _focusedFrameId?: number;

  private readonly logger: Logger;
  private readonly disposables: Disposable[] = [];
  private readonly options: SessionStartOptions;

  private readonly sourceBreakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
  private functionBreakpoints: DebugProtocol.FunctionBreakpoint[] = [];

  private started = false;
  private threadsDirty = true;
  private initializePromise?: Promise<DebugProtocol.Capabilities>;
  private readonly configured = new Deferred<void>();

  constructor(
    readonly client: DapClient,
    readonly config: DebugConfiguration,
    options: SessionStartOptions & { logger?: Logger; id?: string } = {},
  ) {
    super();
    this.id = options.id ?? `session-${nextSessionId++}`;
    this.logger = options.logger ?? noopLogger;
    this.options = {
      autoFetchStackTraceOnStop: true,
      configureTimeoutMs: 8000,
      ...options,
    };

    for (const [path, bps] of Object.entries(options.breakpoints ?? {})) {
      this.sourceBreakpoints.set(path, bps);
    }
    this.functionBreakpoints = options.functionBreakpoints ?? [];

    this.registerClientListeners();
  }

  // ---- public state -------------------------------------------------------

  get state(): SessionState {
    return this._state;
  }

  get capabilities(): Readonly<DebugProtocol.Capabilities> {
    return this._capabilities;
  }

  /** The thread that most recently stopped, if any. */
  get stoppedThreadId(): number | undefined {
    return this._stoppedThreadId;
  }

  /** The currently focused stack frame id, if stopped. */
  get focusedFrameId(): number | undefined {
    return this._focusedFrameId;
  }

  /** Snapshot of the known threads. */
  getThreadInfos(): ThreadInfo[] {
    return [...this.threads.values()];
  }

  /** Focus a specific stack frame (used as the default for `evaluate`, etc.). */
  setFocusedFrame(frameId: number | undefined): void {
    this._focusedFrameId = frameId;
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Run the full startup handshake: connect, `initialize`, `launch`/`attach`,
   * install breakpoints on the `initialized` event, and `configurationDone`.
   * Resolves once the debuggee is configured and the launch/attach acknowledged.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Session already started");
    }
    this.started = true;

    await this.client.start();

    this.initializePromise = this.client.sendRequest("initialize", this.buildInitializeArgs()).then((caps) => {
      this.mergeCapabilities(caps ?? {});
      return this._capabilities;
    });
    await this.initializePromise;

    // Fire launch/attach; the adapter answers the `initialized` event
    // asynchronously, which drives configuration.
    const launchPromise = this.client.sendRequest(this.config.request, this.config as unknown as RequestArgs<"launch">).catch((err: Error) => {
      this.logger.error(`${this.config.request} failed`, err.message);
      this.emit("error", err);
      throw err;
    });

    await Promise.all([launchPromise, this.waitForConfigured()]);
    if (this._state === SessionState.Initializing) {
      this.setState(SessionState.Running);
    }
  }

  /** Gracefully disconnect from the adapter. */
  async disconnect(args?: DebugProtocol.DisconnectArguments, options?: RequestOptions): Promise<void> {
    try {
      await this.client.sendRequest("disconnect", args, options);
    } finally {
      this.close();
    }
  }

  /** Terminate the debuggee (falls back to `disconnect` if unsupported). */
  async terminate(args?: DebugProtocol.TerminateArguments, options?: RequestOptions): Promise<void> {
    if (this._capabilities.supportsTerminateRequest) {
      await this.client.sendRequest("terminate", args, options);
    } else {
      await this.disconnect({ terminateDebuggee: true }, options);
    }
  }

  /** Release all resources. Safe to call multiple times. */
  close(): void {
    if (this._state === SessionState.Terminated && this.client.isDisposed) {
      return;
    }
    this.setState(SessionState.Terminated);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.client.dispose();
    if (this.parent) {
      this.parent.children.delete(this.id);
      this.parent = undefined;
    }
    this.emit("close");
  }

  // ---- generic request passthrough ---------------------------------------

  /** Send an arbitrary DAP request (typed for known commands). */
  request<C extends RequestCommand>(command: C, args?: RequestArgs<C>, options?: RequestOptions): Promise<ResponseBody<C>>;
  request(command: string, args?: unknown, options?: RequestOptions): Promise<unknown>;
  request(command: string, args?: unknown, options?: RequestOptions): Promise<unknown> {
    return this.client.sendRequest(command, args, options);
  }

  // ---- execution control --------------------------------------------------

  async continue(threadId = this.requireStoppedThread(), singleThread?: boolean): Promise<DebugProtocol.ContinueResponse["body"]> {
    const body = await this.client.sendRequest("continue", { threadId, singleThread });
    // Some adapters signal all-threads-continued only via the response.
    this.markContinued(threadId, body?.allThreadsContinued ?? true);
    return body;
  }

  async next(threadId = this.requireStoppedThread(), granularity?: DebugProtocol.SteppingGranularity): Promise<void> {
    this.markContinued(threadId, false);
    await this.client.sendRequest("next", { threadId, granularity });
  }

  async stepIn(threadId = this.requireStoppedThread(), targetId?: number, granularity?: DebugProtocol.SteppingGranularity): Promise<void> {
    this.markContinued(threadId, false);
    await this.client.sendRequest("stepIn", { threadId, targetId, granularity });
  }

  async stepOut(threadId = this.requireStoppedThread(), granularity?: DebugProtocol.SteppingGranularity): Promise<void> {
    this.markContinued(threadId, false);
    await this.client.sendRequest("stepOut", { threadId, granularity });
  }

  async pause(threadId: number): Promise<void> {
    await this.client.sendRequest("pause", { threadId });
  }

  // ---- inspection ---------------------------------------------------------

  /** Fetch the thread list and refresh the cached {@link ThreadInfo}s. */
  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const body = await this.client.sendRequest("threads", undefined);
    const threads = body?.threads ?? [];
    const seen = new Set<number>();
    for (const thread of threads) {
      seen.add(thread.id);
      const existing = this.threads.get(thread.id);
      this.threads.set(thread.id, {
        id: thread.id,
        name: thread.name,
        stopped: existing?.stopped ?? false,
        frames: existing?.frames,
      });
    }
    for (const id of [...this.threads.keys()]) {
      if (!seen.has(id)) {
        this.threads.delete(id);
      }
    }
    this.threadsDirty = false;
    return threads;
  }

  async getStackTrace(threadId: number, args: Omit<DebugProtocol.StackTraceArguments, "threadId"> = {}): Promise<DebugProtocol.StackFrame[]> {
    const body = await this.client.sendRequest("stackTrace", { threadId, ...args });
    const frames = body?.stackFrames ?? [];
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.frames = frames;
    }
    return frames;
  }

  async getScopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    const body = await this.client.sendRequest("scopes", { frameId });
    return body?.scopes ?? [];
  }

  async getVariables(variablesReference: number, args: Omit<DebugProtocol.VariablesArguments, "variablesReference"> = {}): Promise<DebugProtocol.Variable[]> {
    const body = await this.client.sendRequest("variables", { variablesReference, ...args });
    return body?.variables ?? [];
  }

  async evaluate(expression: string, args: Omit<DebugProtocol.EvaluateArguments, "expression"> = {}): Promise<DebugProtocol.EvaluateResponse["body"]> {
    return this.client.sendRequest("evaluate", {
      expression,
      frameId: args.frameId ?? this._focusedFrameId,
      context: args.context ?? "repl",
      ...args,
    });
  }

  // ---- breakpoints --------------------------------------------------------

  /**
   * Set the breakpoints for a source. Stores them so they are re-applied on
   * reconnect/configuration, and syncs immediately if the session is live.
   */
  async setBreakpoints(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    const key = source.path ?? source.name ?? String(source.sourceReference ?? "");
    this.sourceBreakpoints.set(key, breakpoints);
    if (this._state === SessionState.Initializing) {
      return [];
    }
    return this.sendSetBreakpoints(source, breakpoints);
  }

  async setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    this.functionBreakpoints = breakpoints;
    if (!this._capabilities.supportsFunctionBreakpoints) {
      this.logger.warn("Adapter does not support function breakpoints");
      return [];
    }
    const body = await this.client.sendRequest("setFunctionBreakpoints", { breakpoints });
    return body?.breakpoints ?? [];
  }

  async setExceptionBreakpoints(filters: string[] | "default"): Promise<void> {
    const resolved = this.resolveExceptionFilters(filters);
    if (!resolved) {
      return;
    }
    await this.client.sendRequest("setExceptionBreakpoints", { filters: resolved });
  }

  // ---- configuration handshake -------------------------------------------

  private async configure(): Promise<void> {
    await this.initializePromise;
    this.logger.debug("Configuring session", this.id);
    try {
      for (const [path, breakpoints] of this.sourceBreakpoints) {
        await this.sendSetBreakpoints({ path, name: path.split(/[\\/]/).pop() }, breakpoints);
      }
      if (this.functionBreakpoints.length > 0 && this._capabilities.supportsFunctionBreakpoints) {
        await this.client.sendRequest("setFunctionBreakpoints", { breakpoints: this.functionBreakpoints });
      }
      if (this.options.exceptionFilters) {
        await this.setExceptionBreakpoints(this.options.exceptionFilters);
      }
      if (this._capabilities.supportsConfigurationDoneRequest) {
        await this.client.sendRequest("configurationDone", undefined);
      }
    } finally {
      this.configured.resolve();
    }
  }

  private async sendSetBreakpoints(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    const body = await this.client.sendRequest("setBreakpoints", {
      source,
      breakpoints,
      lines: breakpoints.map((bp) => bp.line),
      sourceModified: false,
    });
    return body?.breakpoints ?? [];
  }

  private async waitForConfigured(): Promise<void> {
    const timeoutMs = this.options.configureTimeoutMs ?? 8000;
    if (timeoutMs <= 0) {
      return this.configured.promise;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (!this.configured.isSettled) {
          this.logger.warn(`No 'initialized' event within ${timeoutMs}ms; proceeding without configurationDone`);
        }
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([this.configured.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- event wiring -------------------------------------------------------

  private registerClientListeners(): void {
    this.disposables.push(
      this.client.onEvent("initialized", () => {
        this.emit("initialized");
        void this.configure().catch((err: Error) => {
          this.logger.error("Configuration failed", err.message);
          this.emit("error", err);
        });
      }),
      this.client.onEvent("stopped", (body) => this.onStopped(body)),
      this.client.onEvent("continued", (body) => this.onContinued(body)),
      this.client.onEvent("thread", (body) => this.onThread(body)),
      this.client.onEvent("output", (body) => this.emit("output", body)),
      this.client.onEvent("breakpoint", (body) => this.emit("breakpoint", body)),
      this.client.onEvent("capabilities", (body) => {
        this.mergeCapabilities(body.capabilities);
      }),
      this.client.onEvent("exited", (body) => this.emit("exited", body)),
      this.client.onEvent("terminated", (body) => this.onTerminated(body)),
      this.client.onAnyEvent((event) => this.emit("event", event)),
      this.client.onClose(() => this.close()),
      this.client.onError((err) => this.emit("error", err)),
    );
  }

  private onStopped(body: DebugProtocol.StoppedEvent["body"]): void {
    this.setState(SessionState.Stopped);
    if (body.allThreadsStopped) {
      for (const thread of this.threads.values()) {
        thread.stopped = true;
      }
    }
    if (typeof body.threadId === "number") {
      this._stoppedThreadId = body.threadId;
      const thread = this.threads.get(body.threadId);
      if (thread) {
        thread.stopped = true;
      } else {
        this.threads.set(body.threadId, { id: body.threadId, name: "Unknown", stopped: true });
        this.threadsDirty = true;
      }
    }

    this.emit("stopped", body);

    if (this.options.autoFetchStackTraceOnStop && typeof body.threadId === "number") {
      void this.hydrateStoppedThread(body.threadId);
    }
  }

  private async hydrateStoppedThread(threadId: number): Promise<void> {
    try {
      if (this.threadsDirty) {
        await this.getThreads();
      }
      const frames = await this.getStackTrace(threadId, { startFrame: 0 });
      const top = frames.find((frame) => frame.source) ?? frames[0];
      if (top && this._stoppedThreadId === threadId) {
        this._focusedFrameId = top.id;
      }
    } catch (err) {
      this.logger.debug("Failed to hydrate stopped thread", (err as Error).message);
    }
  }

  private onContinued(body: DebugProtocol.ContinuedEvent["body"]): void {
    this.markContinued(body.threadId, body.allThreadsContinued ?? false);
    this.emit("continued", body);
  }

  private onThread(body: DebugProtocol.ThreadEvent["body"]): void {
    if (body.reason === "exited") {
      this.threads.delete(body.threadId);
      if (this._stoppedThreadId === body.threadId) {
        this._stoppedThreadId = undefined;
      }
    } else {
      this.threadsDirty = true;
      if (!this.threads.has(body.threadId)) {
        this.threads.set(body.threadId, { id: body.threadId, name: "Unknown", stopped: false });
      }
    }
    this.emit("thread", body);
  }

  private onTerminated(body: DebugProtocol.TerminatedEvent["body"]): void {
    this.emit("terminated", body);
    this.close();
  }

  // ---- helpers ------------------------------------------------------------

  private markContinued(threadId: number | undefined, allThreads: boolean): void {
    if (allThreads) {
      for (const thread of this.threads.values()) {
        thread.stopped = false;
        thread.frames = undefined;
      }
      this._stoppedThreadId = undefined;
    } else if (typeof threadId === "number") {
      const thread = this.threads.get(threadId);
      if (thread) {
        thread.stopped = false;
        thread.frames = undefined;
      }
      if (this._stoppedThreadId === threadId) {
        this._stoppedThreadId = undefined;
      }
    }
    this._focusedFrameId = undefined;
    if (this._state === SessionState.Stopped && !this.hasStoppedThread()) {
      this.setState(SessionState.Running);
    }
  }

  private hasStoppedThread(): boolean {
    for (const thread of this.threads.values()) {
      if (thread.stopped) {
        return true;
      }
    }
    return false;
  }

  private requireStoppedThread(): number {
    if (typeof this._stoppedThreadId === "number") {
      return this._stoppedThreadId;
    }
    for (const thread of this.threads.values()) {
      if (thread.stopped) {
        return thread.id;
      }
    }
    throw new Error("No stopped thread; cannot perform execution control without a threadId");
  }

  private resolveExceptionFilters(filters: string[] | "default"): string[] | undefined {
    const available = this._capabilities.exceptionBreakpointFilters;
    if (!available || available.length === 0) {
      this.logger.debug("Adapter does not support exception breakpoints");
      return undefined;
    }
    if (filters === "default") {
      return available.filter((f) => f.default).map((f) => f.filter);
    }
    return filters;
  }

  private buildInitializeArgs(): DebugProtocol.InitializeRequestArguments {
    return {
      clientID: "dap-client",
      clientName: "dap-client",
      adapterID: this.config.type,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      locale: "en-US",
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: true,
      supportsProgressReporting: true,
      supportsStartDebuggingRequest: true,
      ...this.options.initializeArgs,
    };
  }

  private mergeCapabilities(capabilities: DebugProtocol.Capabilities): void {
    this._capabilities = { ...this._capabilities, ...capabilities };
    this.emit("capabilities", this._capabilities);
  }

  private setState(next: SessionState): void {
    if (this._state === next) {
      return;
    }
    const previous = this._state;
    this._state = next;
    this.emit("stateChanged", next, previous);
  }
}
