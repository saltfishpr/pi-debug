import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Disposable } from "../common/lifecycle";

export interface DapRequestMap {
  initialize: [DebugProtocol.InitializeRequest, DebugProtocol.InitializeResponse];
  launch: [DebugProtocol.LaunchRequest, DebugProtocol.LaunchResponse];
  attach: [DebugProtocol.AttachRequest, DebugProtocol.AttachResponse];
  disconnect: [DebugProtocol.DisconnectRequest, DebugProtocol.DisconnectResponse];
  configurationDone: [DebugProtocol.ConfigurationDoneRequest, DebugProtocol.ConfigurationDoneResponse];
  setBreakpoints: [DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse];
  setExceptionBreakpoints: [
    DebugProtocol.SetExceptionBreakpointsRequest,
    DebugProtocol.SetExceptionBreakpointsResponse,
  ];
  continue: [DebugProtocol.ContinueRequest, DebugProtocol.ContinueResponse];
  next: [DebugProtocol.NextRequest, DebugProtocol.NextResponse];
  stepIn: [DebugProtocol.StepInRequest, DebugProtocol.StepInResponse];
  stepOut: [DebugProtocol.StepOutRequest, DebugProtocol.StepOutResponse];
  pause: [DebugProtocol.PauseRequest, DebugProtocol.PauseResponse];
  stackTrace: [DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse];
  scopes: [DebugProtocol.ScopesRequest, DebugProtocol.ScopesResponse];
  variables: [DebugProtocol.VariablesRequest, DebugProtocol.VariablesResponse];
  threads: [DebugProtocol.ThreadsRequest, DebugProtocol.ThreadsResponse];
  evaluate: [DebugProtocol.EvaluateRequest, DebugProtocol.EvaluateResponse];
}

export type DapRequestCommand = keyof DapRequestMap;
export type DapRequest<C extends DapRequestCommand> = DapRequestMap[C][0];
export type DapRequestArguments<C extends DapRequestCommand> = C extends "launch" | "attach"
  ? Record<string, unknown>
  : DapRequest<C>["arguments"];
export type DapResponse<C extends DapRequestCommand> = DapRequestMap[C][1];

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
