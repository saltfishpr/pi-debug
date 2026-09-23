import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Disposable } from "../common/lifecycle";

export interface DapRequestMap {
  initialize: [DebugProtocol.InitializeRequestArguments, DebugProtocol.InitializeResponse];
  launch: [DebugProtocol.LaunchRequestArguments & Record<string, unknown>, DebugProtocol.LaunchResponse];
  attach: [DebugProtocol.AttachRequestArguments & Record<string, unknown>, DebugProtocol.AttachResponse];
  configurationDone: [DebugProtocol.ConfigurationDoneArguments | undefined, DebugProtocol.ConfigurationDoneResponse];
  setBreakpoints: [DebugProtocol.SetBreakpointsArguments, DebugProtocol.SetBreakpointsResponse];
  setFunctionBreakpoints: [DebugProtocol.SetFunctionBreakpointsArguments, DebugProtocol.SetFunctionBreakpointsResponse];
  setExceptionBreakpoints: [
    DebugProtocol.SetExceptionBreakpointsArguments,
    DebugProtocol.SetExceptionBreakpointsResponse,
  ];
  continue: [DebugProtocol.ContinueArguments, DebugProtocol.ContinueResponse];
  next: [DebugProtocol.NextArguments, DebugProtocol.NextResponse];
  stepIn: [DebugProtocol.StepInArguments, DebugProtocol.StepInResponse];
  stepOut: [DebugProtocol.StepOutArguments, DebugProtocol.StepOutResponse];
  pause: [DebugProtocol.PauseArguments, DebugProtocol.PauseResponse];
  threads: [undefined, DebugProtocol.ThreadsResponse];
  stackTrace: [DebugProtocol.StackTraceArguments, DebugProtocol.StackTraceResponse];
  scopes: [DebugProtocol.ScopesArguments, DebugProtocol.ScopesResponse];
  variables: [DebugProtocol.VariablesArguments, DebugProtocol.VariablesResponse];
  evaluate: [DebugProtocol.EvaluateArguments, DebugProtocol.EvaluateResponse];
  disconnect: [DebugProtocol.DisconnectArguments | undefined, DebugProtocol.DisconnectResponse];
  terminate: [DebugProtocol.TerminateArguments | undefined, DebugProtocol.TerminateResponse];
}

export interface DebugAdapter extends Disposable {
  readonly onError: Event<Error>;
  readonly onExit: Event<number | null>;

  onMessage(callback: (message: DebugProtocol.ProtocolMessage) => void): void;
  onRequest(callback: (request: DebugProtocol.Request) => void): void;
  onEvent(callback: (event: DebugProtocol.Event) => void): void;

  startSession(signal?: AbortSignal): Promise<void>;
  stopSession(): Promise<void>;

  sendMessage(message: DebugProtocol.ProtocolMessage): void;
  sendResponse(response: DebugProtocol.Response): void;
  sendRequest(command: string, args: unknown, clb: (result: DebugProtocol.Response) => void, timeout?: number): number;
}

/** A function that subscribes to a debug adapter event. */
export type Event<T> = (listener: (value: T) => void) => Disposable;
