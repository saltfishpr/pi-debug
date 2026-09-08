import type { DebugProtocol } from "@vscode/debugprotocol";
import { CAPABILITY_BY_COMMAND, mergeCapabilities } from "./capabilities.js";
import { DapConnection, type ReverseRequest, type RequestOptions } from "./connection.js";
import { DapUnsupportedError } from "./errors.js";
import { Emitter, type EventSource, once } from "./events.js";

/** Lifecycle states, guarding against invalid operations and races. */
export type ClientState = "unconnected" | "initializing" | "initialized" | "configured" | "terminated";

/** Opt-in workarounds for real-world adapter deviations from the spec. */
export interface Quirks {
  /**
   * Some adapters do not emit a `continued` event after a step/continue
   * request. When enabled, a synthetic `continued` event is fired if no
   * `stopped` event arrived while the request was in flight.
   */
  synthesizeContinuedAfterStep?: boolean;
}

export interface DebugClientOptions {
  quirks?: Quirks;
}

/** Handler for a reverse request; returns the response body (or void). */
export type ReverseRequestHandler = (args: unknown, request: DebugProtocol.Request) => unknown | Promise<unknown>;

/**
 * Layer 4 — Session facade.
 *
 * Typed, capability-gated DAP methods; strongly-typed, multi-subscriber event
 * streams; an explicit lifecycle state machine; reverse-request registration;
 * and an isolated quirks layer. No editor/UI dependencies: reverse requests and
 * error presentation are delegated to the embedder.
 */
export class DebugClient {
  private _state: ClientState = "unconnected";
  private _capabilities: DebugProtocol.Capabilities = {};
  private stoppedSinceLastStep = false;
  private initializedEvent?: DebugProtocol.InitializedEvent;

  private readonly reverseHandlers = new Map<string, ReverseRequestHandler>();

  private readonly emitters = {
    initialized: new Emitter<DebugProtocol.InitializedEvent>(),
    stopped: new Emitter<DebugProtocol.StoppedEvent>(),
    continued: new Emitter<DebugProtocol.ContinuedEvent>(),
    exited: new Emitter<DebugProtocol.ExitedEvent>(),
    terminated: new Emitter<DebugProtocol.TerminatedEvent>(),
    thread: new Emitter<DebugProtocol.ThreadEvent>(),
    output: new Emitter<DebugProtocol.OutputEvent>(),
    breakpoint: new Emitter<DebugProtocol.BreakpointEvent>(),
    module: new Emitter<DebugProtocol.ModuleEvent>(),
    loadedSource: new Emitter<DebugProtocol.LoadedSourceEvent>(),
    process: new Emitter<DebugProtocol.ProcessEvent>(),
    capabilities: new Emitter<DebugProtocol.CapabilitiesEvent>(),
    progressStart: new Emitter<DebugProtocol.ProgressStartEvent>(),
    progressUpdate: new Emitter<DebugProtocol.ProgressUpdateEvent>(),
    progressEnd: new Emitter<DebugProtocol.ProgressEndEvent>(),
    invalidated: new Emitter<DebugProtocol.InvalidatedEvent>(),
    memory: new Emitter<DebugProtocol.MemoryEvent>(),
    custom: new Emitter<DebugProtocol.Event>(),
  };

  // Typed event streams (multi-subscriber).
  readonly onInitialized: EventSource<DebugProtocol.InitializedEvent> = this.emitters.initialized.event;
  readonly onStopped: EventSource<DebugProtocol.StoppedEvent> = this.emitters.stopped.event;
  readonly onContinued: EventSource<DebugProtocol.ContinuedEvent> = this.emitters.continued.event;
  readonly onExited: EventSource<DebugProtocol.ExitedEvent> = this.emitters.exited.event;
  readonly onTerminated: EventSource<DebugProtocol.TerminatedEvent> = this.emitters.terminated.event;
  readonly onThread: EventSource<DebugProtocol.ThreadEvent> = this.emitters.thread.event;
  readonly onOutput: EventSource<DebugProtocol.OutputEvent> = this.emitters.output.event;
  readonly onBreakpoint: EventSource<DebugProtocol.BreakpointEvent> = this.emitters.breakpoint.event;
  readonly onModule: EventSource<DebugProtocol.ModuleEvent> = this.emitters.module.event;
  readonly onLoadedSource: EventSource<DebugProtocol.LoadedSourceEvent> = this.emitters.loadedSource.event;
  readonly onProcess: EventSource<DebugProtocol.ProcessEvent> = this.emitters.process.event;
  readonly onCapabilities: EventSource<DebugProtocol.CapabilitiesEvent> = this.emitters.capabilities.event;
  readonly onProgressStart: EventSource<DebugProtocol.ProgressStartEvent> = this.emitters.progressStart.event;
  readonly onProgressUpdate: EventSource<DebugProtocol.ProgressUpdateEvent> = this.emitters.progressUpdate.event;
  readonly onProgressEnd: EventSource<DebugProtocol.ProgressEndEvent> = this.emitters.progressEnd.event;
  readonly onInvalidated: EventSource<DebugProtocol.InvalidatedEvent> = this.emitters.invalidated.event;
  readonly onMemory: EventSource<DebugProtocol.MemoryEvent> = this.emitters.memory.event;
  /** Any event whose type is not one of the standard DAP events. */
  readonly onCustomEvent: EventSource<DebugProtocol.Event> = this.emitters.custom.event;

  constructor(
    private readonly connection: DapConnection,
    private readonly options: DebugClientOptions = {},
  ) {
    connection.onEvent((event) => this.handleEvent(event));
    connection.onRequest((incoming) => void this.handleReverseRequest(incoming));
    connection.onClose(() => {
      this._state = "terminated";
    });
    // Only emit a DAP `cancel` for aborted requests when the adapter supports it.
    connection.setCancelPredicate(() => !!this._capabilities.supportsCancelRequest);
  }

  get state(): ClientState {
    return this._state;
  }

  get capabilities(): Readonly<DebugProtocol.Capabilities> {
    return this._capabilities;
  }

  /**
   * Resolves with the `initialized` event. Latched: if the event has already
   * been received it resolves immediately, so the common
   * `await initialize(); await onInitializedOnce()` pattern is race-free.
   */
  onInitializedOnce(): Promise<DebugProtocol.InitializedEvent> {
    return this.initializedEvent ? Promise.resolve(this.initializedEvent) : once(this.onInitialized);
  }

  /** Register a handler for a reverse request such as `runInTerminal`. */
  onReverseRequest(command: string, handler: ReverseRequestHandler): void {
    this.reverseHandlers.set(command, handler);
  }

  // --- Lifecycle ----------------------------------------------------------

  async initialize(args: DebugProtocol.InitializeRequestArguments, options?: RequestOptions): Promise<DebugProtocol.Capabilities> {
    this._state = "initializing";
    const response = await this.connection.sendRequest<DebugProtocol.InitializeResponse>("initialize", args, options);
    this._capabilities = mergeCapabilities(this._capabilities, response.body);
    this._state = "initialized";
    return this._capabilities;
  }

  async launch(args: DebugProtocol.LaunchRequestArguments, options?: RequestOptions): Promise<DebugProtocol.LaunchResponse> {
    const response = await this.connection.sendRequest<DebugProtocol.LaunchResponse>("launch", args, options);
    this._capabilities = mergeCapabilities(this._capabilities, response.body);
    return response;
  }

  async attach(args: DebugProtocol.AttachRequestArguments, options?: RequestOptions): Promise<DebugProtocol.AttachResponse> {
    const response = await this.connection.sendRequest<DebugProtocol.AttachResponse>("attach", args, options);
    this._capabilities = mergeCapabilities(this._capabilities, response.body);
    return response;
  }

  async configurationDone(options?: RequestOptions): Promise<void> {
    await this.guarded<DebugProtocol.ConfigurationDoneResponse>("configurationDone", undefined, options);
    this._state = "configured";
  }

  /**
   * Disconnect and shut down. `terminateDebuggee` / `suspendDebuggee` are only
   * forwarded when the adapter advertises the matching capability (mirrors
   * VS Code's `RawDebugSession.disconnect`).
   */
  disconnect(args: DebugProtocol.DisconnectArguments = {}, options?: RequestOptions): Promise<DebugProtocol.DisconnectResponse> {
    const filtered: DebugProtocol.DisconnectArguments = { restart: args.restart };
    if (this._capabilities.supportTerminateDebuggee) {
      filtered.terminateDebuggee = args.terminateDebuggee;
      if (this._capabilities.supportSuspendDebuggee) {
        filtered.suspendDebuggee = args.suspendDebuggee;
      }
    }
    return this.connection.sendRequest<DebugProtocol.DisconnectResponse>("disconnect", filtered, options);
  }

  /**
   * Terminate the debuggee softly. Falls back to `disconnect(terminateDebuggee)`
   * when the adapter lacks `supportsTerminateRequest` (matching VS Code).
   */
  terminate(
    args: DebugProtocol.TerminateArguments = {},
    options?: RequestOptions,
  ): Promise<DebugProtocol.TerminateResponse | DebugProtocol.DisconnectResponse> {
    if (this._capabilities.supportsTerminateRequest) {
      return this.connection.sendRequest<DebugProtocol.TerminateResponse>("terminate", args, options);
    }
    return this.disconnect({ terminateDebuggee: true, restart: args.restart }, options);
  }

  restart(args: DebugProtocol.RestartArguments = {}, options?: RequestOptions): Promise<DebugProtocol.RestartResponse> {
    return this.guarded<DebugProtocol.RestartResponse>("restart", args, options);
  }

  // --- Execution control (with continued-event quirk) ---------------------

  next(args: DebugProtocol.NextArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.NextResponse>("next", args, args.threadId, options);
  }

  stepIn(args: DebugProtocol.StepInArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.StepInResponse>("stepIn", args, args.threadId, options);
  }

  stepOut(args: DebugProtocol.StepOutArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.StepOutResponse>("stepOut", args, args.threadId, options);
  }

  stepBack(args: DebugProtocol.StepBackArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.StepBackResponse>("stepBack", args, args.threadId, options);
  }

  reverseContinue(args: DebugProtocol.ReverseContinueArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.ReverseContinueResponse>("reverseContinue", args, args.threadId, options);
  }

  async continue(args: DebugProtocol.ContinueArguments, options?: RequestOptions): Promise<DebugProtocol.ContinueResponse> {
    this.stoppedSinceLastStep = false;
    const response = await this.connection.sendRequest<DebugProtocol.ContinueResponse>("continue", args, options);
    const allThreads = response.body?.allThreadsContinued ?? true;
    this.maybeSynthesizeContinued(args.threadId, allThreads);
    return response;
  }

  pause(args: DebugProtocol.PauseArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.PauseResponse>("pause", args, options);
  }

  /**
   * Restart a stack frame and resume. `threadId` is passed separately because
   * `RestartFrameArguments` only carries a `frameId` (matching VS Code).
   */
  restartFrame(args: DebugProtocol.RestartFrameArguments, threadId: number, options?: RequestOptions) {
    return this.stepping<DebugProtocol.RestartFrameResponse>("restartFrame", args, threadId, options);
  }

  goto(args: DebugProtocol.GotoArguments, options?: RequestOptions) {
    return this.stepping<DebugProtocol.GotoResponse>("goto", args, args.threadId, options);
  }

  gotoTargets(args: DebugProtocol.GotoTargetsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.GotoTargetsResponse>("gotoTargets", args, options);
  }

  stepInTargets(args: DebugProtocol.StepInTargetsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.StepInTargetsResponse>("stepInTargets", args, options);
  }

  terminateThreads(args: DebugProtocol.TerminateThreadsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.TerminateThreadsResponse>("terminateThreads", args, options);
  }

  // --- Inspection ---------------------------------------------------------

  threads(options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.ThreadsResponse>("threads", undefined, options);
  }

  stackTrace(args: DebugProtocol.StackTraceArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.StackTraceResponse>("stackTrace", args, options);
  }

  scopes(args: DebugProtocol.ScopesArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.ScopesResponse>("scopes", args, options);
  }

  variables(args: DebugProtocol.VariablesArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.VariablesResponse>("variables", args, options);
  }

  evaluate(args: DebugProtocol.EvaluateArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.EvaluateResponse>("evaluate", args, options);
  }

  source(args: DebugProtocol.SourceArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.SourceResponse>("source", args, options);
  }

  locations(args: DebugProtocol.LocationsArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.LocationsResponse>("locations", args, options);
  }

  loadedSources(args: DebugProtocol.LoadedSourcesArguments = {}, options?: RequestOptions) {
    return this.guarded<DebugProtocol.LoadedSourcesResponse>("loadedSources", args, options);
  }

  setVariable(args: DebugProtocol.SetVariableArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.SetVariableResponse>("setVariable", args, options);
  }

  setExpression(args: DebugProtocol.SetExpressionArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.SetExpressionResponse>("setExpression", args, options);
  }

  exceptionInfo(args: DebugProtocol.ExceptionInfoArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.ExceptionInfoResponse>("exceptionInfo", args, options);
  }

  completions(args: DebugProtocol.CompletionsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.CompletionsResponse>("completions", args, options);
  }

  // --- Breakpoints --------------------------------------------------------

  setBreakpoints(args: DebugProtocol.SetBreakpointsArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.SetBreakpointsResponse>("setBreakpoints", args, options);
  }

  setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.SetExceptionBreakpointsResponse>("setExceptionBreakpoints", args, options);
  }

  setFunctionBreakpoints(args: DebugProtocol.SetFunctionBreakpointsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.SetFunctionBreakpointsResponse>("setFunctionBreakpoints", args, options);
  }

  setDataBreakpoints(args: DebugProtocol.SetDataBreakpointsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.SetDataBreakpointsResponse>("setDataBreakpoints", args, options);
  }

  dataBreakpointInfo(args: DebugProtocol.DataBreakpointInfoArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.DataBreakpointInfoResponse>("dataBreakpointInfo", args, options);
  }

  setInstructionBreakpoints(args: DebugProtocol.SetInstructionBreakpointsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.SetInstructionBreakpointsResponse>("setInstructionBreakpoints", args, options);
  }

  breakpointLocations(args: DebugProtocol.BreakpointLocationsArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.BreakpointLocationsResponse>("breakpointLocations", args, options);
  }

  // --- Memory / disassembly ----------------------------------------------

  readMemory(args: DebugProtocol.ReadMemoryArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.ReadMemoryResponse>("readMemory", args, options);
  }

  writeMemory(args: DebugProtocol.WriteMemoryArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.WriteMemoryResponse>("writeMemory", args, options);
  }

  disassemble(args: DebugProtocol.DisassembleArguments, options?: RequestOptions) {
    return this.guarded<DebugProtocol.DisassembleResponse>("disassemble", args, options);
  }

  /**
   * Explicitly cancel a request (`requestId`) or a long-running progress
   * (`progressId`). Per-request cancellation is usually done via a
   * `RequestOptions.signal` instead; this is mainly for progress cancellation.
   * Ungated to match VS Code (best-effort).
   */
  cancel(args: DebugProtocol.CancelArguments, options?: RequestOptions) {
    return this.connection.sendRequest<DebugProtocol.CancelResponse>("cancel", args, options);
  }

  /** Escape hatch for adapter-specific custom requests. */
  custom<R extends DebugProtocol.Response = DebugProtocol.Response>(command: string, args?: unknown, options?: RequestOptions): Promise<R> {
    return this.connection.sendRequest<R>(command, args, options);
  }

  // --- Internals ----------------------------------------------------------

  /** Capability-gated request: rejects up-front if the adapter lacks support. */
  private guarded<R extends DebugProtocol.Response>(command: string, args: unknown, options?: RequestOptions): Promise<R> {
    const capability = CAPABILITY_BY_COMMAND[command];
    if (capability && !this._capabilities[capability]) {
      return Promise.reject(new DapUnsupportedError(command, capability));
    }
    return this.connection.sendRequest<R>(command, args, options);
  }

  private async stepping<R extends DebugProtocol.Response>(command: string, args: unknown, threadId: number, options?: RequestOptions): Promise<R> {
    this.stoppedSinceLastStep = false;
    const response = await this.guarded<R>(command, args, options);
    this.maybeSynthesizeContinued(threadId, false);
    return response;
  }

  private maybeSynthesizeContinued(threadId: number, allThreadsContinued: boolean): void {
    if (!this.options.quirks?.synthesizeContinuedAfterStep || this.stoppedSinceLastStep) {
      return;
    }
    this.emitters.continued.fire({
      seq: 0,
      type: "event",
      event: "continued",
      body: { threadId, allThreadsContinued },
    });
  }

  private handleEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "initialized":
        this.initializedEvent = event as DebugProtocol.InitializedEvent;
        this.emitters.initialized.fire(event as DebugProtocol.InitializedEvent);
        break;
      case "stopped":
        this.stoppedSinceLastStep = true;
        this.emitters.stopped.fire(event as DebugProtocol.StoppedEvent);
        break;
      case "continued":
        this.emitters.continued.fire(event as DebugProtocol.ContinuedEvent);
        break;
      case "exited":
        this.emitters.exited.fire(event as DebugProtocol.ExitedEvent);
        break;
      case "terminated":
        this.emitters.terminated.fire(event as DebugProtocol.TerminatedEvent);
        break;
      case "thread":
        this.emitters.thread.fire(event as DebugProtocol.ThreadEvent);
        break;
      case "output":
        this.emitters.output.fire(event as DebugProtocol.OutputEvent);
        break;
      case "breakpoint":
        this.emitters.breakpoint.fire(event as DebugProtocol.BreakpointEvent);
        break;
      case "module":
        this.emitters.module.fire(event as DebugProtocol.ModuleEvent);
        break;
      case "loadedSource":
        this.emitters.loadedSource.fire(event as DebugProtocol.LoadedSourceEvent);
        break;
      case "process":
        this.emitters.process.fire(event as DebugProtocol.ProcessEvent);
        break;
      case "capabilities": {
        const evt = event as DebugProtocol.CapabilitiesEvent;
        this._capabilities = mergeCapabilities(this._capabilities, evt.body?.capabilities);
        this.emitters.capabilities.fire(evt);
        break;
      }
      case "progressStart":
        this.emitters.progressStart.fire(event as DebugProtocol.ProgressStartEvent);
        break;
      case "progressUpdate":
        this.emitters.progressUpdate.fire(event as DebugProtocol.ProgressUpdateEvent);
        break;
      case "progressEnd":
        this.emitters.progressEnd.fire(event as DebugProtocol.ProgressEndEvent);
        break;
      case "invalidated":
        this.emitters.invalidated.fire(event as DebugProtocol.InvalidatedEvent);
        break;
      case "memory":
        this.emitters.memory.fire(event as DebugProtocol.MemoryEvent);
        break;
      default:
        this.emitters.custom.fire(event);
        break;
    }
  }

  private async handleReverseRequest(incoming: ReverseRequest): Promise<void> {
    const handler = this.reverseHandlers.get(incoming.request.command);
    if (!handler) {
      incoming.reject(`unknown request '${incoming.request.command}'`);
      return;
    }
    try {
      const body = await handler(incoming.request.arguments, incoming.request);
      incoming.respond(body);
    } catch (err) {
      incoming.reject((err as Error).message);
    }
  }
}
