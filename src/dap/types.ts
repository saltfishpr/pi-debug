import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Disposable } from "../common/lifecycle";

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
