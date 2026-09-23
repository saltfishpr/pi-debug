import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Event } from "./types";

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Transport-independent low-level Debug Adapter Protocol implementation. */
export abstract class AbstractDebugAdapter {
  protected readonly _onError = new Emitter<Error>();
  protected readonly _onExit = new Emitter<number | null>();

  private messageCallback: ((message: DebugProtocol.ProtocolMessage) => void) | undefined;
  private requestCallback: ((request: DebugProtocol.Request) => void) | undefined;
  private eventCallback: ((event: DebugProtocol.Event) => void) | undefined;
  private queue: DebugProtocol.ProtocolMessage[] = [];

  private sequence = 1;
  private readonly pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();
  private readonly pendingRequestTimers = new Map<number, ReturnType<typeof setTimeout>>();

  abstract startSession(signal?: AbortSignal): Promise<void>;
  abstract stopSession(): Promise<void>;
  abstract sendMessage(message: DebugProtocol.ProtocolMessage): void;

  get onError(): Event<Error> {
    return this._onError.event;
  }

  get onExit(): Event<number | null> {
    return this._onExit.event;
  }

  onMessage(callback: (message: DebugProtocol.ProtocolMessage) => void): void {
    if (this.messageCallback) this._onError.fire(new Error("attempt to set more than one 'Message' callback"));
    this.messageCallback = callback;
  }

  onRequest(callback: (request: DebugProtocol.Request) => void): void {
    if (this.requestCallback) this._onError.fire(new Error("attempt to set more than one 'Request' callback"));
    this.requestCallback = callback;
  }

  onEvent(callback: (event: DebugProtocol.Event) => void): void {
    if (this.eventCallback) this._onError.fire(new Error("attempt to set more than one 'Event' callback"));
    this.eventCallback = callback;
  }

  sendRequest(
    command: string,
    args: unknown,
    callback: (response: DebugProtocol.Response) => void,
    timeout?: number,
  ): number {
    const request: DebugProtocol.Request = { seq: 0, type: "request", command };
    if (args && typeof args === "object" && Object.keys(args).length > 0) request.arguments = args;
    this.internalSend("request", request);
    if (timeout !== undefined) {
      this.pendingRequestTimers.set(
        request.seq,
        setTimeout(() => {
          this.pendingRequestTimers.delete(request.seq);
          const pending = this.pendingRequests.get(request.seq);
          if (!pending) return;
          this.pendingRequests.delete(request.seq);
          pending({
            seq: 0,
            type: "response",
            request_seq: request.seq,
            success: false,
            command: "timeout",
            message: `Timeout after ${timeout} ms for '${command}'`,
          });
        }, timeout),
      );
    }
    this.pendingRequests.set(request.seq, callback);
    return request.seq;
  }

  sendResponse(response: DebugProtocol.Response): void {
    if (response.seq > 0) {
      this._onError.fire(new Error(`attempt to send more than one response for command ${response.command}`));
      return;
    }
    this.internalSend("response", response);
  }

  acceptMessage(message: DebugProtocol.ProtocolMessage): void {
    if (this.messageCallback) {
      this.messageCallback(message);
      return;
    }
    this.queue.push(message);
    if (this.queue.length === 1) void this.processQueue();
  }

  getPendingRequestIds(): number[] {
    return [...this.pendingRequests.keys()];
  }

  dispose(): void {
    for (const timer of this.pendingRequestTimers.values()) clearTimeout(timer);
    this.pendingRequestTimers.clear();
    this.pendingRequests.clear();
    this.queue = [];
    this._onError.dispose();
    this._onExit.dispose();
  }

  protected async cancelPendingRequests(): Promise<void> {
    if (this.pendingRequests.size === 0) return;
    const pending = new Map(this.pendingRequests);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    for (const [requestSeq, callback] of pending) {
      callback({
        seq: 0,
        type: "response",
        request_seq: requestSeq,
        success: false,
        command: "canceled",
        message: "canceled",
      });
      this.pendingRequests.delete(requestSeq);
      this.clearPendingRequestTimer(requestSeq);
    }
  }

  private async processQueue(): Promise<void> {
    let previous: DebugProtocol.ProtocolMessage | undefined;
    while (this.queue.length) {
      if (!previous || this.needsTaskBoundaryBetween(this.queue[0], previous)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const message = this.queue.shift();
      if (!message) {
        return; // may have been disposed of
      }
      previous = message;
      if (message.type === "event") this.eventCallback?.(message as DebugProtocol.Event);
      else if (message.type === "request") this.requestCallback?.(message as DebugProtocol.Request);
      else {
        const response = message as DebugProtocol.Response;
        const callback = this.pendingRequests.get(response.request_seq);
        if (callback) {
          this.pendingRequests.delete(response.request_seq);
          this.clearPendingRequestTimer(response.request_seq);
          callback(response);
        }
      }
    }
  }

  private needsTaskBoundaryBetween(a: DebugProtocol.ProtocolMessage, b: DebugProtocol.ProtocolMessage): boolean {
    return a.type !== "event" || b.type !== "event";
  }

  private internalSend(type: "request" | "response", message: DebugProtocol.ProtocolMessage): void {
    message.type = type;
    message.seq = this.sequence++;
    this.sendMessage(message);
  }

  private clearPendingRequestTimer(requestSeq: number): void {
    const timer = this.pendingRequestTimers.get(requestSeq);
    if (timer) clearTimeout(timer);
    this.pendingRequestTimers.delete(requestSeq);
  }
}
