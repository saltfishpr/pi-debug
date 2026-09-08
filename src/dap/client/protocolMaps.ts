import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * Maps each DAP request command to its argument and response-body types.
 *
 * This is the backbone of the client's type-safety: {@link DapClient.sendRequest}
 * and the {@link Session} convenience methods use it so that `command`,
 * `arguments` and the resolved response are all checked against the spec.
 */
export interface RequestTypeMap {
  initialize: { args: DebugProtocol.InitializeRequestArguments; body: DebugProtocol.Capabilities };
  launch: { args: DebugProtocol.LaunchRequestArguments; body: undefined };
  attach: { args: DebugProtocol.AttachRequestArguments; body: undefined };
  restart: { args: DebugProtocol.RestartArguments | undefined; body: undefined };
  disconnect: { args: DebugProtocol.DisconnectArguments | undefined; body: undefined };
  terminate: { args: DebugProtocol.TerminateArguments | undefined; body: undefined };
  configurationDone: { args: DebugProtocol.ConfigurationDoneArguments | undefined; body: undefined };

  setBreakpoints: { args: DebugProtocol.SetBreakpointsArguments; body: DebugProtocol.SetBreakpointsResponse["body"] };
  setFunctionBreakpoints: {
    args: DebugProtocol.SetFunctionBreakpointsArguments;
    body: DebugProtocol.SetFunctionBreakpointsResponse["body"];
  };
  setExceptionBreakpoints: {
    args: DebugProtocol.SetExceptionBreakpointsArguments;
    body: DebugProtocol.SetExceptionBreakpointsResponse["body"];
  };
  setInstructionBreakpoints: {
    args: DebugProtocol.SetInstructionBreakpointsArguments;
    body: DebugProtocol.SetInstructionBreakpointsResponse["body"];
  };
  dataBreakpointInfo: {
    args: DebugProtocol.DataBreakpointInfoArguments;
    body: DebugProtocol.DataBreakpointInfoResponse["body"];
  };
  setDataBreakpoints: {
    args: DebugProtocol.SetDataBreakpointsArguments;
    body: DebugProtocol.SetDataBreakpointsResponse["body"];
  };
  breakpointLocations: {
    args: DebugProtocol.BreakpointLocationsArguments;
    body: DebugProtocol.BreakpointLocationsResponse["body"];
  };

  continue: { args: DebugProtocol.ContinueArguments; body: DebugProtocol.ContinueResponse["body"] };
  next: { args: DebugProtocol.NextArguments; body: undefined };
  stepIn: { args: DebugProtocol.StepInArguments; body: undefined };
  stepOut: { args: DebugProtocol.StepOutArguments; body: undefined };
  stepBack: { args: DebugProtocol.StepBackArguments; body: undefined };
  reverseContinue: { args: DebugProtocol.ReverseContinueArguments; body: undefined };
  restartFrame: { args: DebugProtocol.RestartFrameArguments; body: undefined };
  goto: { args: DebugProtocol.GotoArguments; body: undefined };
  pause: { args: DebugProtocol.PauseArguments; body: undefined };

  stackTrace: { args: DebugProtocol.StackTraceArguments; body: DebugProtocol.StackTraceResponse["body"] };
  scopes: { args: DebugProtocol.ScopesArguments; body: DebugProtocol.ScopesResponse["body"] };
  variables: { args: DebugProtocol.VariablesArguments; body: DebugProtocol.VariablesResponse["body"] };
  setVariable: { args: DebugProtocol.SetVariableArguments; body: DebugProtocol.SetVariableResponse["body"] };
  setExpression: { args: DebugProtocol.SetExpressionArguments; body: DebugProtocol.SetExpressionResponse["body"] };
  source: { args: DebugProtocol.SourceArguments; body: DebugProtocol.SourceResponse["body"] };
  threads: { args: undefined; body: DebugProtocol.ThreadsResponse["body"] };
  terminateThreads: { args: DebugProtocol.TerminateThreadsArguments; body: undefined };
  modules: { args: DebugProtocol.ModulesArguments; body: DebugProtocol.ModulesResponse["body"] };
  loadedSources: { args: DebugProtocol.LoadedSourcesArguments | undefined; body: DebugProtocol.LoadedSourcesResponse["body"] };

  evaluate: { args: DebugProtocol.EvaluateArguments; body: DebugProtocol.EvaluateResponse["body"] };
  completions: { args: DebugProtocol.CompletionsArguments; body: DebugProtocol.CompletionsResponse["body"] };
  exceptionInfo: { args: DebugProtocol.ExceptionInfoArguments; body: DebugProtocol.ExceptionInfoResponse["body"] };
  readMemory: { args: DebugProtocol.ReadMemoryArguments; body: DebugProtocol.ReadMemoryResponse["body"] };
  writeMemory: { args: DebugProtocol.WriteMemoryArguments; body: DebugProtocol.WriteMemoryResponse["body"] };
  disassemble: { args: DebugProtocol.DisassembleArguments; body: DebugProtocol.DisassembleResponse["body"] };
  gotoTargets: { args: DebugProtocol.GotoTargetsArguments; body: DebugProtocol.GotoTargetsResponse["body"] };
  stepInTargets: { args: DebugProtocol.StepInTargetsArguments; body: DebugProtocol.StepInTargetsResponse["body"] };
  cancel: { args: DebugProtocol.CancelArguments; body: undefined };
}

export type RequestCommand = keyof RequestTypeMap;
export type RequestArgs<C extends RequestCommand> = RequestTypeMap[C]["args"];
export type ResponseBody<C extends RequestCommand> = RequestTypeMap[C]["body"];

/** Maps each DAP event name to the type of its `body`. */
export interface EventBodyMap {
  initialized: DebugProtocol.InitializedEvent["body"];
  stopped: DebugProtocol.StoppedEvent["body"];
  continued: DebugProtocol.ContinuedEvent["body"];
  exited: DebugProtocol.ExitedEvent["body"];
  terminated: DebugProtocol.TerminatedEvent["body"];
  thread: DebugProtocol.ThreadEvent["body"];
  output: DebugProtocol.OutputEvent["body"];
  breakpoint: DebugProtocol.BreakpointEvent["body"];
  module: DebugProtocol.ModuleEvent["body"];
  loadedSource: DebugProtocol.LoadedSourceEvent["body"];
  process: DebugProtocol.ProcessEvent["body"];
  capabilities: DebugProtocol.CapabilitiesEvent["body"];
  progressStart: DebugProtocol.ProgressStartEvent["body"];
  progressUpdate: DebugProtocol.ProgressUpdateEvent["body"];
  progressEnd: DebugProtocol.ProgressEndEvent["body"];
  invalidated: DebugProtocol.InvalidatedEvent["body"];
  memory: DebugProtocol.MemoryEvent["body"];
}

export type EventName = keyof EventBodyMap;

/** Maps the two spec-defined reverse (adapter→client) requests to their types. */
export interface ReverseRequestTypeMap {
  runInTerminal: {
    args: DebugProtocol.RunInTerminalRequestArguments;
    body: DebugProtocol.RunInTerminalResponse["body"];
  };
  startDebugging: {
    args: DebugProtocol.StartDebuggingRequestArguments;
    body: undefined;
  };
}

export type ReverseRequestCommand = keyof ReverseRequestTypeMap;
