import type { DapTransport, DebugProtocol } from "../dap/index.js";
import { DapConnection, DebugClient, Emitter, type Disposable, type EventSource } from "../dap/index.js";
import type { DebugConfiguration } from "../launchConfig.js";
import type { DebugSessionContext, ResumeOutcome, SessionState, SourceBreakpointSpec, StopSnapshot, VerifiedBreakpoint } from "./types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STACK_FRAMES = 20;
const DEFAULT_MAX_OUTPUT_BUFFER = 1000;

/**
 * Layer 5 — a single debug session, cradle to grave.
 *
 * Owns the DAP handshake choreography, a running/stopped state machine, the
 * event→await bridge (`continueAndWait`/`stepX` resolve on the *next* stop),
 * the stop snapshot with volatile-handle invalidation, and a path-addressed
 * breakpoint model. It reuses `DebugClient` for all protocol work and never
 * re-implements it.
 */
export class DebugSession {
  readonly id: string;

  private _state: SessionState = "created";
  private _stopSnapshot?: StopSnapshot;
  private _exitCode?: number;
  private lastStoppedThreadId?: number;
  private stopGeneration = 0;
  private readyForBreakpoints = false;

  private readonly desiredBreakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
  private readonly verifiedBreakpoints = new Map<string, DebugProtocol.Breakpoint[]>();
  private exceptionFilters: string[] = [];
  private readonly outputBuffer: DebugProtocol.OutputEvent[] = [];

  private readonly subscriptions: Disposable[] = [];
  private readonly configured = deferred<void>();

  private readonly _onStopped = new Emitter<StopSnapshot>();
  private readonly _onOutput = new Emitter<DebugProtocol.OutputEvent>();
  private readonly _onTerminated = new Emitter<{ exitCode?: number }>();
  private readonly _onStateChanged = new Emitter<SessionState>();

  readonly onStopped: EventSource<StopSnapshot> = this._onStopped.event;
  readonly onOutput: EventSource<DebugProtocol.OutputEvent> = this._onOutput.event;
  readonly onTerminated: EventSource<{ exitCode?: number }> = this._onTerminated.event;
  readonly onStateChanged: EventSource<SessionState> = this._onStateChanged.event;

  constructor(
    private readonly client: DebugClient,
    private readonly connection: DapConnection,
    private readonly transport: DapTransport,
    private readonly ctx: DebugSessionContext,
  ) {
    this.id = ctx.id;
    // Register listeners before the first `initialize` so no event is missed.
    this.registerListeners();
  }

  get state(): SessionState {
    return this._state;
  }

  get parentId(): string | undefined {
    return this.ctx.parentId;
  }

  get configuration(): DebugConfiguration {
    return this.ctx.configuration;
  }

  get capabilities(): Readonly<DebugProtocol.Capabilities> {
    return this.client.capabilities;
  }

  // --- Lifecycle orchestration (§5.1) -------------------------------------

  /**
   * Run the DAP handshake: start → initialize → (fire) launch/attach, while the
   * `initialized` event independently drives breakpoints + configurationDone.
   * launch/attach is intentionally not awaited before configuration to avoid the
   * launch↔configurationDone deadlock some adapters exhibit.
   */
  async configureAndStart(): Promise<void> {
    if (this._state !== "created") {
      throw new Error(`configureAndStart called from invalid state '${this._state}'`);
    }
    try {
      this.setState("initializing");
      await this.transport.start();
      await this.client.initialize(this.buildInitializeArgs());
      this.setState("configuring");
      const launched = this.launchOrAttach();
      await Promise.all([launched, this.configured.promise]);
      if (this.state === "configuring") {
        this.setState("running");
      }
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  terminate(): Promise<void> {
    if (this.isEnded()) {
      return Promise.resolve();
    }
    return this.client.terminate({}).then(
      () => undefined,
      () => undefined,
    );
  }

  disconnect(args: DebugProtocol.DisconnectArguments = {}): Promise<void> {
    if (this.isEnded()) {
      return Promise.resolve();
    }
    return this.client.disconnect(args).then(
      () => undefined,
      () => undefined,
    );
  }

  async dispose(): Promise<void> {
    if (this._state === "disposed") {
      return;
    }
    this._state = "disposed";
    this._onStateChanged.fire("disposed");
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
    try {
      await this.connection.dispose();
    } catch {
      // best effort
    }
    this._onStopped.dispose();
    this._onOutput.dispose();
    this._onTerminated.dispose();
    this._onStateChanged.dispose();
  }

  // --- Breakpoints (desired state, resent on configure) -------------------

  async setBreakpoints(spec: SourceBreakpointSpec): Promise<DebugProtocol.Breakpoint[]> {
    this.desiredBreakpoints.set(spec.path, spec.breakpoints);
    if (!this.canSendBreakpoints()) {
      return [];
    }
    return this.applySourceBreakpoints(spec.path, spec.breakpoints);
  }

  async setExceptionBreakpoints(filters: string[]): Promise<void> {
    this.exceptionFilters = [...filters];
    if (this.canSendBreakpoints()) {
      await this.client.setExceptionBreakpoints({ filters: this.exceptionFilters });
    }
  }

  listBreakpoints(): ReadonlyArray<VerifiedBreakpoint> {
    const result: VerifiedBreakpoint[] = [];
    for (const [path, breakpoints] of this.verifiedBreakpoints) {
      for (const breakpoint of breakpoints) {
        result.push({ path, breakpoint });
      }
    }
    return result;
  }

  // --- Execution control: resolve on the next stop/exit (§5.2) ------------

  continueAndWait(threadId?: number): Promise<ResumeOutcome> {
    return this.guardedResume(() => {
      this.assertStopped();
      const tid = this.resolveThreadId(threadId);
      return this.client.continue({ threadId: tid });
    });
  }

  stepOver(threadId: number): Promise<ResumeOutcome> {
    return this.guardedResume(() => {
      this.assertStopped();
      return this.client.next({ threadId });
    });
  }

  stepIn(threadId: number): Promise<ResumeOutcome> {
    return this.guardedResume(() => {
      this.assertStopped();
      return this.client.stepIn({ threadId });
    });
  }

  stepOut(threadId: number): Promise<ResumeOutcome> {
    return this.guardedResume(() => {
      this.assertStopped();
      return this.client.stepOut({ threadId });
    });
  }

  async pause(threadId: number): Promise<StopSnapshot> {
    this.assertActive();
    const outcome = this.waitForOutcome();
    await this.client.pause({ threadId });
    const result = await outcome;
    if (result.outcome === "stopped") {
      return result.snapshot;
    }
    throw new Error(`pause did not lead to a stop (${result.outcome})`);
  }

  // --- Inspection (valid while stopped) -----------------------------------

  getStopState(): StopSnapshot | undefined {
    return this._stopSnapshot;
  }

  getRecentOutput(): ReadonlyArray<DebugProtocol.OutputEvent> {
    return [...this.outputBuffer];
  }

  async listThreads(): Promise<DebugProtocol.Thread[]> {
    this.assertActive();
    const response = await this.client.threads();
    return response.body?.threads ?? [];
  }

  async getStackTrace(threadId: number, options: { startFrame?: number; levels?: number } = {}): Promise<DebugProtocol.StackFrame[]> {
    this.assertStopped();
    const response = await this.client.stackTrace({ threadId, startFrame: options.startFrame ?? 0, levels: options.levels ?? this.maxStackFrames });
    return response.body?.stackFrames ?? [];
  }

  async getScopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    this.assertStopped();
    const response = await this.client.scopes({ frameId });
    return response.body?.scopes ?? [];
  }

  async getVariables(variablesReference: number): Promise<DebugProtocol.Variable[]> {
    this.assertStopped();
    const response = await this.client.variables({ variablesReference });
    return response.body?.variables ?? [];
  }

  async evaluate(expression: string, frameId?: number, context?: string): Promise<DebugProtocol.EvaluateResponse["body"]> {
    this.assertActive();
    const response = await this.client.evaluate({ expression, frameId, context });
    return response.body;
  }

  // --- Internals ----------------------------------------------------------

  private get maxStackFrames(): number {
    return this.ctx.maxStackFrames ?? DEFAULT_MAX_STACK_FRAMES;
  }

  private get maxOutputBuffer(): number {
    return this.ctx.maxOutputBuffer ?? DEFAULT_MAX_OUTPUT_BUFFER;
  }

  private get waitTimeoutMs(): number {
    return this.ctx.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  }

  private registerListeners(): void {
    const { client, connection } = this;
    this.subscriptions.push(
      client.onInitialized(() => void this.onInitialized()),
      client.onStopped((event) => void this.handleStopped(event)),
      client.onContinued(() => this.handleContinued()),
      client.onTerminated(() => this.handleTerminated()),
      client.onExited((event) => {
        this._exitCode = event.body.exitCode;
      }),
      client.onOutput((event) => this.handleOutput(event)),
      client.onBreakpoint((event) => this.reconcileBreakpoint(event.body.breakpoint)),
      client.onInvalidated(() => this.invalidateStop()),
      connection.onClose(() => this.handleTerminated()),
    );

    if (this.ctx.runInTerminal) {
      client.onReverseRequest("runInTerminal", this.ctx.runInTerminal);
    }
    client.onReverseRequest("startDebugging", async (args) => {
      if (!this.ctx.onStartDebugging) {
        throw new Error("startDebugging is not supported by this embedder");
      }
      const payload = (args ?? {}) as { configuration?: unknown; request?: string };
      await this.ctx.onStartDebugging(payload.configuration ?? {}, payload.request ?? "launch");
      return {};
    });
  }

  private async onInitialized(): Promise<void> {
    this.readyForBreakpoints = true;
    try {
      await this.sendAllBreakpoints();
      if (this.client.capabilities.supportsConfigurationDoneRequest) {
        try {
          await this.client.configurationDone();
        } catch (err) {
          // configurationDone failure → disconnect (mirrors VS Code #10596).
          await this.disconnect({});
          throw err;
        }
      }
      this.configured.resolve();
    } catch (err) {
      this.configured.reject(err as Error);
    }
  }

  private async sendAllBreakpoints(): Promise<void> {
    for (const [path, breakpoints] of this.desiredBreakpoints) {
      await this.applySourceBreakpoints(path, breakpoints);
    }
    if (this.exceptionFilters.length > 0) {
      await this.client.setExceptionBreakpoints({ filters: this.exceptionFilters });
    }
  }

  private async applySourceBreakpoints(path: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    const response = await this.client.setBreakpoints({ source: { path }, breakpoints });
    const verified = response.body?.breakpoints ?? [];
    this.verifiedBreakpoints.set(path, verified);
    return verified;
  }

  /**
   * Validate + issue a resume request, then resolve on the next stop/exit.
   * `send` runs its precondition checks synchronously; failures become a
   * rejected promise. Only after it succeeds do we invalidate the prior stop.
   */
  private async guardedResume(send: () => Promise<unknown>): Promise<ResumeOutcome> {
    const request = send();
    this.invalidateStop();
    this.setState("running");
    const outcome = this.waitForOutcome();
    void request.catch(() => undefined);
    return outcome;
  }

  private waitForOutcome(): Promise<ResumeOutcome> {
    return new Promise<ResumeOutcome>((resolve) => {
      const subs: Disposable[] = [];
      let settled = false;
      const finish = (result: ResumeOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        for (const sub of subs) {
          sub.dispose();
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ outcome: "timeout" }), this.waitTimeoutMs);
      subs.push(
        this.onStopped((snapshot) => finish({ outcome: "stopped", snapshot })),
        this.onTerminated(({ exitCode }) => finish({ outcome: "terminated", exitCode })),
      );
    });
  }

  private async handleStopped(event: DebugProtocol.StoppedEvent): Promise<void> {
    const generation = ++this.stopGeneration;
    this.lastStoppedThreadId = event.body.threadId;
    this.setState("stopped");
    const snapshot = await this.buildSnapshot(event.body);
    // Drop the snapshot if the session resumed (or re-stopped) while we fetched.
    if (this.stopGeneration !== generation) {
      return;
    }
    this._stopSnapshot = snapshot;
    this._onStopped.fire(snapshot);
  }

  private async buildSnapshot(body: DebugProtocol.StoppedEvent["body"]): Promise<StopSnapshot> {
    const threadId = body.threadId ?? this.lastStoppedThreadId ?? 0;
    let frames: DebugProtocol.StackFrame[] = [];
    try {
      const response = await this.client.stackTrace({ threadId, startFrame: 0, levels: this.maxStackFrames });
      frames = response.body?.stackFrames ?? [];
    } catch {
      // Adapter may have gone away between stop and fetch; keep a minimal snapshot.
    }
    return {
      reason: body.reason,
      threadId,
      allThreadsStopped: body.allThreadsStopped,
      description: body.description,
      text: body.text,
      hitBreakpointIds: body.hitBreakpointIds,
      frames,
    };
  }

  private handleContinued(): void {
    this.invalidateStop();
    if (this._state === "stopped") {
      this.setState("running");
    }
  }

  private handleTerminated(): void {
    if (this._state === "terminated" || this._state === "disposed") {
      return;
    }
    this.invalidateStop();
    this.setState("terminated");
    this._onTerminated.fire({ exitCode: this._exitCode });
  }

  private handleOutput(event: DebugProtocol.OutputEvent): void {
    this.outputBuffer.push(event);
    if (this.outputBuffer.length > this.maxOutputBuffer) {
      this.outputBuffer.shift();
    }
    this._onOutput.fire(event);
  }

  private reconcileBreakpoint(updated: DebugProtocol.Breakpoint): void {
    if (updated.id === undefined) {
      return;
    }
    for (const breakpoints of this.verifiedBreakpoints.values()) {
      const index = breakpoints.findIndex((bp) => bp.id === updated.id);
      if (index >= 0) {
        breakpoints[index] = updated;
        return;
      }
    }
  }

  private invalidateStop(): void {
    this.stopGeneration++;
    this._stopSnapshot = undefined;
  }

  private buildInitializeArgs(): DebugProtocol.InitializeRequestArguments {
    return {
      clientID: "pi-debug",
      clientName: "Pi Agent",
      adapterID: this.ctx.configuration.type,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      locale: "en",
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: !!this.ctx.runInTerminal,
      supportsProgressReporting: true,
      supportsInvalidatedEvent: true,
      supportsMemoryReferences: true,
      supportsMemoryEvent: true,
      supportsStartDebuggingRequest: !!this.ctx.onStartDebugging,
      supportsANSIStyling: true,
      ...this.ctx.clientCapabilities,
    };
  }

  private launchOrAttach(): Promise<unknown> {
    const config = this.ctx.configuration as DebugConfiguration & Record<string, unknown>;
    if (config.request === "attach") {
      return this.client.attach(config as DebugProtocol.AttachRequestArguments);
    }
    return this.client.launch(config as DebugProtocol.LaunchRequestArguments);
  }

  private canSendBreakpoints(): boolean {
    return this.readyForBreakpoints && !this.isEnded();
  }

  private resolveThreadId(threadId?: number): number {
    const resolved = threadId ?? this.lastStoppedThreadId;
    if (resolved === undefined) {
      throw new Error("no threadId available; provide one explicitly");
    }
    return resolved;
  }

  private isEnded(): boolean {
    return this._state === "terminated" || this._state === "disposed";
  }

  private assertActive(): void {
    if (this._state === "created" || this.isEnded()) {
      throw new Error(`operation requires an active session (state '${this._state}')`);
    }
  }

  private assertStopped(): void {
    if (this._state !== "stopped") {
      throw new Error(`operation requires a stopped session (state '${this._state}')`);
    }
  }

  private setState(next: SessionState): void {
    if (this._state === next || this._state === "disposed") {
      return;
    }
    this._state = next;
    this._onStateChanged.fire(next);
  }
}
