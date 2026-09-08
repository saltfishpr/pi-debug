import type { DebugProtocol } from "@vscode/debugprotocol";
import { EventEmitter } from "node:events";
import { encodeMessage, MessageParser } from "../protocol/messageCodec";
import type { Transport } from "../transport/transport";
import { DapConnectionError, DapResponseError, DapTimeoutError } from "../util/errors";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import type { Disposable } from "../util/typedEmitter";
import type { EventBodyMap, EventName, RequestArgs, RequestCommand, ResponseBody, ReverseRequestCommand, ReverseRequestTypeMap } from "./protocolMaps";

export interface DapClientOptions {
  logger?: Logger;
  /** Default per-request timeout in ms. `0`/omitted disables the timeout. */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  /** Override the client's default timeout for this request. */
  timeoutMs?: number;
}

/** Handler for an adapter→client (reverse) request. Return the response body. */
export type ReverseRequestHandler<C extends ReverseRequestCommand> = (
  args: ReverseRequestTypeMap[C]["args"],
  request: DebugProtocol.Request,
) => ReverseRequestTypeMap[C]["body"] | Promise<ReverseRequestTypeMap[C]["body"]>;

interface PendingRequest {
  command: string;
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

const EVENT_PREFIX = "dap:event:";
const ANY_EVENT = "dap:anyEvent";
const LIFECYCLE_CLOSE = "dap:close";
const LIFECYCLE_ERROR = "dap:error";
const LIFECYCLE_STDERR = "dap:stderr";

/**
 * The request/response and event-dispatch layer of the DAP stack.
 *
 * Responsibilities, mirroring nvim-dap's `session:request` / `handle_body`:
 *  - assign monotonically increasing sequence numbers to outgoing messages;
 *  - correlate responses back to their originating request via `request_seq`;
 *  - dispatch adapter events to typed listeners;
 *  - route reverse requests (`runInTerminal`, `startDebugging`) to handlers and
 *    reply with a well-formed response.
 *
 * It is intentionally stateless with respect to debugging semantics (threads,
 * breakpoints, ...); that lives in {@link Session}.
 */
export class DapClient {
  private readonly emitter = new EventEmitter();
  private readonly parser = new MessageParser();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reverseHandlers = new Map<string, ReverseRequestHandler<ReverseRequestCommand>>();
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;

  private sequence = 1;
  private started = false;
  private disposed = false;

  constructor(
    private readonly transport: Transport,
    options: DapClientOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 0;
    this.emitter.setMaxListeners(200);
  }

  /** Connect the transport and begin reading messages. Idempotent. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.transport.on("data", (chunk) => this.handleData(chunk));
    this.transport.on("stderr", (chunk) => this.emitter.emit(LIFECYCLE_STDERR, chunk));
    this.transport.on("error", (err) => this.emitter.emit(LIFECYCLE_ERROR, err));
    this.transport.on("close", () => this.handleClose());

    await this.transport.connect();
  }

  // ---- outgoing requests --------------------------------------------------

  sendRequest<C extends RequestCommand>(command: C, args?: RequestArgs<C>, options?: RequestOptions): Promise<ResponseBody<C>>;
  sendRequest(command: string, args?: unknown, options?: RequestOptions): Promise<unknown>;
  sendRequest(command: string, args?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new DapConnectionError(`Cannot send '${command}': client is disposed`));
    }

    const seq = this.nextSeq();
    const request: DebugProtocol.Request = {
      seq,
      type: "request",
      command,
    };
    if (args !== undefined && args !== null) {
      request.arguments = args;
    }

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { command, resolve, reject };

      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(seq)) {
            reject(new DapTimeoutError(command, timeoutMs));
          }
        }, timeoutMs);
        pending.timer.unref?.();
      }

      this.pending.set(seq, pending);
      this.logger.debug("→ request", command, seq);
      try {
        this.transport.write(encodeMessage(request));
      } catch (err) {
        this.pending.delete(seq);
        clearTimeout(pending.timer);
        reject(err as Error);
      }
    });
  }

  // ---- events -------------------------------------------------------------

  /** Subscribe to a specific DAP event by name. */
  onEvent<K extends EventName>(event: K, listener: (body: EventBodyMap[K], raw: DebugProtocol.Event) => void): Disposable {
    return this.subscribe(`${EVENT_PREFIX}${event}`, listener as (...args: unknown[]) => void);
  }

  /** Subscribe to every DAP event, regardless of name. */
  onAnyEvent(listener: (event: DebugProtocol.Event) => void): Disposable {
    return this.subscribe(ANY_EVENT, listener as (...args: unknown[]) => void);
  }

  /** Fired once when the underlying transport closes. */
  onClose(listener: () => void): Disposable {
    return this.subscribe(LIFECYCLE_CLOSE, listener);
  }

  /** Fired on transport-level errors. */
  onError(listener: (error: Error) => void): Disposable {
    return this.subscribe(LIFECYCLE_ERROR, listener as (...args: unknown[]) => void);
  }

  /** Diagnostic output written by the adapter to stderr (executable adapters). */
  onStderr(listener: (chunk: Buffer) => void): Disposable {
    return this.subscribe(LIFECYCLE_STDERR, listener as (...args: unknown[]) => void);
  }

  // ---- reverse requests ---------------------------------------------------

  /** Register a handler for an adapter→client request. */
  setReverseRequestHandler<C extends ReverseRequestCommand>(command: C, handler: ReverseRequestHandler<C>): void {
    this.reverseHandlers.set(command, handler as unknown as ReverseRequestHandler<ReverseRequestCommand>);
  }

  removeReverseRequestHandler(command: ReverseRequestCommand): void {
    this.reverseHandlers.delete(command);
  }

  // ---- teardown -----------------------------------------------------------

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DapConnectionError(`Client disposed before '${pending.command}' completed`));
    }
    this.pending.clear();
    this.transport.dispose();
    this.parser.reset();
    this.emitter.removeAllListeners();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ---- internals ----------------------------------------------------------

  private nextSeq(): number {
    return this.sequence++;
  }

  private subscribe(event: string, listener: (...args: unknown[]) => void): Disposable {
    this.emitter.on(event, listener);
    return { dispose: () => this.emitter.off(event, listener) };
  }

  private handleData(chunk: Buffer): void {
    let messages: DebugProtocol.ProtocolMessage[];
    try {
      messages = this.parser.append(chunk);
    } catch (err) {
      this.logger.error("Failed to parse adapter message", err);
      this.emitter.emit(LIFECYCLE_ERROR, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: DebugProtocol.ProtocolMessage): void {
    switch (message.type) {
      case "response":
        this.handleResponse(message as DebugProtocol.Response);
        break;
      case "event":
        this.handleEvent(message as DebugProtocol.Event);
        break;
      case "request":
        void this.handleReverseRequest(message as DebugProtocol.Request);
        break;
      default:
        this.logger.warn("Received message with unexpected type", message);
    }
  }

  private handleResponse(response: DebugProtocol.Response): void {
    const pending = this.pending.get(response.request_seq);
    if (!pending) {
      this.logger.warn("Received response with no matching request", response.request_seq, response.command);
      return;
    }
    this.pending.delete(response.request_seq);
    clearTimeout(pending.timer);
    this.logger.debug("← response", response.command, response.request_seq, response.success);
    if (response.success) {
      pending.resolve(response.body);
    } else {
      pending.reject(new DapResponseError(response));
    }
  }

  private handleEvent(event: DebugProtocol.Event): void {
    this.logger.debug("← event", event.event);
    this.emitter.emit(`${EVENT_PREFIX}${event.event}`, event.body, event);
    this.emitter.emit(ANY_EVENT, event);
  }

  private async handleReverseRequest(request: DebugProtocol.Request): Promise<void> {
    this.logger.debug("← reverse request", request.command, request.seq);
    const handler = this.reverseHandlers.get(request.command);
    if (!handler) {
      this.logger.warn("No handler for reverse request", request.command);
      this.sendResponse(request, false, undefined, `No handler registered for reverse request '${request.command}'`);
      return;
    }
    try {
      const body = await handler(request.arguments as never, request);
      this.sendResponse(request, true, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Reverse request '${request.command}' handler failed`, message);
      this.sendResponse(request, false, undefined, message);
    }
  }

  private sendResponse(request: DebugProtocol.Request, success: boolean, body?: unknown, message?: string): void {
    if (this.disposed) {
      return;
    }
    const response: DebugProtocol.Response = {
      seq: this.nextSeq(),
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
    };
    if (body !== undefined) {
      response.body = body;
    }
    if (message !== undefined) {
      response.message = message;
    }
    try {
      this.transport.write(encodeMessage(response));
    } catch (err) {
      this.logger.error("Failed to send reverse-request response", err);
    }
  }

  private handleClose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DapConnectionError(`Connection closed before '${pending.command}' completed`));
    }
    this.pending.clear();
    this.emitter.emit(LIFECYCLE_CLOSE);
  }
}
