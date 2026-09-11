import type { DebugProtocol } from "@vscode/debugprotocol";
import { DapCancellationError, DapConnectionClosedError, DapResponseError, DapTimeoutError } from "./errors.js";
import { Emitter, type EventSource } from "./events.js";
import type { DapTransport } from "./transport/types.js";

/**
 * Observes every message crossing the connection. Useful for building a DAP
 * log panel, telemetry, or record/replay — kept as a neutral hook instead of
 * baking telemetry into the core (unlike VS Code's RawDebugSession).
 */
export interface DapTracer {
  onSend?(message: DebugProtocol.ProtocolMessage): void;
  onReceive?(message: DebugProtocol.ProtocolMessage): void;
  /** Non-fatal adapter diagnostics (e.g. child-process stderr). Observability only. */
  onDiagnostic?(text: string): void;
}

export interface DapConnectionOptions {
  tracer?: DapTracer;
  /** Default per-request timeout in ms. `0` disables. Default: 0 (no timeout). */
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  /** Cancel the request; maps to a DAP `cancel` request when supported. */
  signal?: AbortSignal;
  /** Override the default timeout for this request (ms). `0` disables. */
  timeoutMs?: number;
}

/** A reverse request (adapter -> client), e.g. `runInTerminal`. */
export interface ReverseRequest {
  readonly request: DebugProtocol.Request;
  /** Reply with a successful response body. */
  respond(body?: unknown): void;
  /** Reply with a failure. */
  reject(message: string): void;
}

interface Pending {
  readonly command: string;
  resolve(response: DebugProtocol.Response): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/**
 * Layer 3 — Protocol engine.
 *
 * Command-agnostic. Owns sequence numbers, correlates responses to requests as
 * Promises, enforces deterministic in-order delivery of inbound messages, and
 * surfaces events and reverse requests. Knows nothing about specific DAP
 * commands — that lives in Layer 4.
 */
export class DapConnection {
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private closeError?: Error;
  private cancelPredicate: () => boolean = () => true;

  private readonly _onEvent = new Emitter<DebugProtocol.Event>();
  private readonly _onRequest = new Emitter<ReverseRequest>();
  private readonly _onClose = new Emitter<{ error?: Error }>();

  /** DAP events (adapter -> client, unsolicited). */
  readonly onEvent: EventSource<DebugProtocol.Event> = this._onEvent.event;
  /** Reverse requests (adapter -> client). */
  readonly onRequest: EventSource<ReverseRequest> = this._onRequest.event;
  /** Fired once when the connection closes. */
  readonly onClose: EventSource<{ error?: Error }> = this._onClose.event;

  constructor(
    private readonly transport: DapTransport,
    private readonly options: DapConnectionOptions = {},
  ) {
    transport.onMessage((message) => this.enqueue(message));
    transport.onError((error) => this.shutdown(error));
    transport.onClose(() => this.shutdown());
    // Non-fatal diagnostics (stderr) are observed, never fatal: do not shut down.
    transport.onDiagnostic?.((text) => this.options.tracer?.onDiagnostic?.(text));
  }

  /** Send a request and await its response. Rejects on failure/timeout/abort. */
  sendRequest<R extends DebugProtocol.Response = DebugProtocol.Response>(command: string, args?: unknown, options: RequestOptions = {}): Promise<R> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new DapConnectionClosedError(command));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new DapCancellationError(command));
    }

    const seq = this.seq++;
    const request: DebugProtocol.Request = { seq, type: "request", command };
    if (args !== undefined && args !== null) {
      request.arguments = args;
    }

    return new Promise<R>((resolve, reject) => {
      const pending: Pending = {
        command,
        resolve: (response) => resolve(response as R),
        reject,
      };
      this.pending.set(seq, pending);

      const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 0;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.settle(seq, () => reject(new DapTimeoutError(command, timeoutMs)));
        }, timeoutMs);
      }

      if (options.signal) {
        const signal = options.signal;
        pending.onAbort = () => {
          this.settle(seq, () => reject(new DapCancellationError(command)));
          // Best-effort protocol cancel; adapter may or may not support it.
          this.emitCancel(seq);
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }

      this.write(request);
    });
  }

  /** Send a reverse-request response envelope back to the adapter. */
  private respondTo(request: DebugProtocol.Request, success: boolean, bodyOrMessage?: unknown): void {
    const response: DebugProtocol.Response = {
      seq: this.seq++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
    };
    if (success) {
      if (bodyOrMessage !== undefined) {
        response.body = bodyOrMessage;
      }
    } else if (typeof bodyOrMessage === "string") {
      response.message = bodyOrMessage;
    }
    this.write(response);
  }

  /**
   * Install a predicate deciding whether an aborted request should also send a
   * DAP `cancel` request. The client wires this to `supportsCancelRequest` so
   * we never emit `cancel` to adapters that do not support it (matching VS Code).
   */
  setCancelPredicate(predicate: () => boolean): void {
    this.cancelPredicate = predicate;
  }

  private emitCancel(requestSeq: number): void {
    if (this.closed || !this.cancelPredicate()) {
      return;
    }
    const args: DebugProtocol.CancelArguments = { requestId: requestSeq };
    const request: DebugProtocol.Request = {
      seq: this.seq++,
      type: "request",
      command: "cancel",
      arguments: args,
    };
    this.write(request);
  }

  private write(message: DebugProtocol.ProtocolMessage): void {
    this.options.tracer?.onSend?.(message);
    this.transport.send(message);
  }

  // --- Inbound: strictly ordered dispatch --------------------------------

  private readonly queue: DebugProtocol.ProtocolMessage[] = [];
  private draining = false;

  private enqueue(message: DebugProtocol.ProtocolMessage): void {
    this.queue.push(message);
    if (!this.draining) {
      void this.drain();
    }
  }

  /**
   * Dispatch inbound messages one at a time, awaiting a task boundary between
   * them. This preserves the ordering guarantee VS Code achieves with its
   * `timeout(0)` queue: an event handler's microtasks must fully settle before
   * the next message is delivered, otherwise a synchronously-fired event could
   * be observed before the `await` of the response that logically precedes it.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const message = this.queue.shift()!;
      this.dispatch(message);
      await Promise.resolve(); // yield a macro/microtask boundary
    }
    this.draining = false;
  }

  private dispatch(message: DebugProtocol.ProtocolMessage): void {
    this.options.tracer?.onReceive?.(message);
    switch (message.type) {
      case "event":
        this._onEvent.fire(message as DebugProtocol.Event);
        break;
      case "response":
        this.handleResponse(message as DebugProtocol.Response);
        break;
      case "request":
        this.handleReverseRequest(message as DebugProtocol.Request);
        break;
    }
  }

  private handleResponse(response: DebugProtocol.Response): void {
    const pending = this.pending.get(response.request_seq);
    if (!pending) {
      return; // unknown / already-settled request_seq
    }
    this.settle(response.request_seq, () => {
      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(new DapResponseError(response));
      }
    });
  }

  private handleReverseRequest(request: DebugProtocol.Request): void {
    let answered = false;
    const answer = (fn: () => void) => {
      if (!answered) {
        answered = true;
        fn();
      }
    };
    this._onRequest.fire({
      request,
      respond: (body) => answer(() => this.respondTo(request, true, body)),
      reject: (message) => answer(() => this.respondTo(request, false, message)),
    });
  }

  private settle(seq: number, action: () => void): void {
    const pending = this.pending.get(seq);
    if (!pending) {
      return;
    }
    this.pending.delete(seq);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    action();
  }

  private shutdown(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error ?? new DapConnectionClosedError();
    for (const [seq, pending] of [...this.pending]) {
      this.pending.delete(seq);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(this.closeError);
    }
    this._onClose.fire({ error });
    this._onEvent.dispose();
    this._onRequest.dispose();
    this._onClose.dispose();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Close the underlying transport and reject any in-flight requests. */
  async dispose(): Promise<void> {
    await this.transport.dispose();
    this.shutdown();
  }
}
