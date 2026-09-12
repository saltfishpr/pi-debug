import type { DebugProtocol } from "@vscode/debugprotocol";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { encodeMessage, MessageDecoder, type CodecOptions, type Message } from "./codec.js";
import {
  asError,
  ConnectionClosedError,
  DapResponseError,
  ProtocolError,
  RequestAbortedError,
  RequestTimeoutError,
} from "./errors.js";
import type { DapTransport } from "./transport.js";
import type { RequestOptions, ReverseRequestHandler } from "./types.js";

/** DapClient 的构造配置：编解码、超时与背压限额。 */
export interface DapClientOptions {
  /** 底层解码器的容量限制，透传给 MessageDecoder。 */
  codec?: CodecOptions;
  /** 单个 request 默认超时（毫秒），可被 RequestOptions.timeoutMs 覆盖。 */
  requestTimeoutMs?: number;
  /** connect 阶段的默认超时（毫秒）。 */
  connectTimeoutMs?: number;
  /** 同时未完成的正向/反向请求上限，超出即拒绝，防止内存无界增长。 */
  maxPendingRequests?: number;
  /** 出站队列累计字节数上限，超出即拒绝新的 write。 */
  maxQueuedBytes?: number;
}

/** 已发出、等待 Adapter 响应的请求条目。 */
interface PendingRequest {
  command: string;
  resolve(response: DebugProtocol.Response): void;
  reject(error: Error): void;
}

/**
 * 单个 DAP 连接。仅负责协议帧的收发、请求/响应配对、事件分发、反向请求处理，
 * 以及并发和超时控制。会话状态（capabilities 协商、breakpoints 缓存等）由调用方维护。
 */
export class DapClient {
  private readonly events = new EventEmitter();
  private readonly decoder: MessageDecoder;
  private readonly requestTimeout: number;
  private readonly connectTimeout: number;
  private readonly maxPending: number;
  private readonly maxQueuedBytes: number;

  /** 未完成的正向请求：seq → 请求条目。 */
  private readonly pending = new Map<number, PendingRequest>();
  /** 已注册的反向请求处理器：command → handler。 */
  private readonly reverseHandlers = new Map<string, ReverseRequestHandler>();
  /** 整个 client 生命周期的 abort 源，close/fail 时统一触发。 */
  private readonly lifetime = new AbortController();
  /** 连接状态机；一旦进入 closed 就不再流转。 */
  private state: "new" | "connecting" | "open" | "closed" = "new";
  /** 下一次发出的消息 seq。 */
  private sequence = 1;
  /** 出站写入串行化的尾部 promise，保证 transport.write 按序执行。 */
  private outgoing = Promise.resolve();
  /** 入站消息分发的串行化尾部 promise，保持消息按到达顺序处理。 */
  private incoming = Promise.resolve();
  /** 当前出站队列累计字节数，与 maxQueuedBytes 对比背压。 */
  private queuedBytes = 0;
  /** 已解码但尚未 dispatch 的消息数，与 maxPending 对比防止分发积压。 */
  private queuedMessages = 0;
  /** 正在执行的反向请求数，与 maxPending 对比防止 handler 积压。 */
  private reverseRequests = 0;
  /** 关闭流程的 promise，作为 close() 的幂等结果。 */
  private closing: Promise<void> | undefined;

  constructor(
    private readonly transport: DapTransport,
    options: DapClientOptions = {},
  ) {
    this.decoder = new MessageDecoder(options.codec);
    this.requestTimeout = options.requestTimeoutMs ?? 30_000;
    this.connectTimeout = options.connectTimeoutMs ?? 10_000;
    this.maxPending = options.maxPendingRequests ?? 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
    for (const value of [this.requestTimeout, this.connectTimeout, this.maxPending, this.maxQueuedBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Client limits must be positive integers");
    }
  }

  // -- 生命周期 ---------------------------------------------------------------

  /**
   * 建立 transport 连接并挂载事件回调。仅能调用一次；任何失败都会驱动 client 进入 closed。
   */
  async connect(options: RequestOptions = {}): Promise<void> {
    if (this.state !== "new") throw new ConnectionClosedError("Client cannot be reopened");
    this.state = "connecting";
    try {
      await withDeadline(
        () =>
          this.transport.open({
            onData: (data) => this.receive(data),
            onClose: (error) => {
              // 把 EOF 排到 incoming 队尾，保证在关闭前先派发完最后一批完整帧。
              this.incoming = this.incoming
                .then(() => {
                  this.decoder.end();
                  this.fail(error ?? new ConnectionClosedError("Adapter connection closed"));
                })
                .catch((cause) => this.fail(asError(cause)));
            },
            onStderr: (data) => this.events.emit("stderr", data),
            onStdout: (data) => this.events.emit("stdout", data),
          }),
        options.timeoutMs ?? this.connectTimeout,
        [this.lifetime.signal, options.signal],
      );
      this.lifetime.signal.throwIfAborted();
      this.state = "open";
    } catch (error) {
      this.fail(asError(error));
      await this.close();
      throw error;
    }
  }

  /** 关闭 transport 并释放资源。发起调试会话结束前应先发 `disconnect` 请求。 */
  close(): Promise<void> {
    if (!this.closing) this.fail(new ConnectionClosedError("DAP client closed"));
    return this.closing!;
  }

  // -- 请求收发 ---------------------------------------------------------------

  /**
   * 发送一个 DAP 请求并等待响应。
   *
   * 协议层的强类型（每个 command 的 args/response shape）应放在上层封装里；
   * 本方法保持单一统一签名。返回的响应带有 `success=true`；`success=false`
   * 会以 `DapResponseError` 抛出。
   */
  async request(command: string, args?: unknown, options: RequestOptions = {}): Promise<DebugProtocol.Response> {
    if (this.state !== "open") throw new ConnectionClosedError("Client is not connected");
    if (this.pending.size >= this.maxPending) throw new Error("Too many pending DAP requests");
    const seq = this.sequence++;
    const message: DebugProtocol.Request = { seq, type: "request", command };
    if (args !== undefined) message.arguments = args;
    // 在注册 pending 之前先编码：若本地参数非法，不会污染连接、也不会留下无人应答的空槽。
    const frame = encodeMessage(message);
    try {
      return await withDeadline(
        () =>
          new Promise<DebugProtocol.Response>((resolve, reject) => {
            this.pending.set(seq, { command, resolve, reject });
            this.send(frame, () => this.pending.has(seq)).catch(reject);
          }),
        options.timeoutMs ?? this.requestTimeout,
        [this.lifetime.signal, options.signal],
      );
    } finally {
      this.pending.delete(seq);
    }
  }

  // -- 事件订阅 ---------------------------------------------------------------

  /**
   * 订阅 DAP `event` 帧。返回解绑函数。
   * 若某事件可能被请求触发，应在请求之前先订阅，避免竞态漏事件。
   */
  onEvent(handler: (event: DebugProtocol.Event) => void): () => void {
    this.events.on("event", handler);
    return () => {
      this.events.off("event", handler);
    };
  }

  /** 订阅连接关闭事件；`error` 为 `ConnectionClosedError` 或底层错误。 */
  onClose(handler: (error: Error) => void): () => void {
    this.events.on("closed", handler);
    return () => {
      this.events.off("closed", handler);
    };
  }

  /**
   * 订阅 Adapter 进程的诊断输出（stdout/stderr）。与 DAP `output` 事件不同，
   * 这里是进程级的字节流，用来接日志。
   */
  onOutput(channel: "stdout" | "stderr", handler: (data: Buffer) => void): () => void {
    this.events.on(channel, handler);
    return () => {
      this.events.off(channel, handler);
    };
  }

  /**
   * 注册反向请求处理器（Adapter → Client）。同一 command 只能注册一个。
   * handler 返回的值作为响应 body；抛错则以失败响应回复 Adapter。
   */
  onReverseRequest(command: string, handler: ReverseRequestHandler): () => void {
    if (this.reverseHandlers.has(command)) throw new Error(`Handler already registered for '${command}'`);
    this.reverseHandlers.set(command, handler);
    return () => {
      if (this.reverseHandlers.get(command) === handler) this.reverseHandlers.delete(command);
    };
  }

  // -- 内部：状态流转 ---------------------------------------------------------

  /**
   * 进入 closed 状态的唯一入口：关闭 transport、拒绝所有 pending、清理监听器，
   * 并向订阅方派发一次 `closed` 事件。多次调用是幂等的。
   */
  private fail(error: Error): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closing = Promise.resolve().then(() => this.transport.close());
    // 自动清理不能产生 unhandledRejection；显式 close() 仍会拿到原始的 promise
    // 以便观察 transport.close 的失败。
    void this.closing.catch(() => {});
    this.lifetime.abort(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.reverseHandlers.clear();
    try {
      this.events.emit("closed", error);
    } finally {
      this.events.removeAllListeners();
    }
  }

  // -- 内部：I/O ------------------------------------------------------------

  /**
   * 串行化出站写入并做队列长度控制。`active` 用于在 promise 排队期间校验
   * 请求是否仍需发送（例如已超时/取消则丢帧）。
   */
  private async send(frame: Buffer, active: () => boolean = () => true): Promise<void> {
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) throw new Error("DAP write queue is full");
    this.queuedBytes += frame.length;
    const write = this.outgoing.then(async () => {
      if (this.state === "closed" || !active()) return;
      try {
        await this.transport.write(frame);
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
    });
    this.outgoing = write.catch(() => {});
    try {
      await write;
    } finally {
      this.queuedBytes -= frame.length;
    }
  }

  /** 接收 transport 交付的原始字节，喂给 decoder；每个完整消息进入串行分发队列。 */
  private receive(data: Buffer): void {
    if (this.state === "closed") return;
    try {
      this.decoder.push(data, (message) => {
        if (++this.queuedMessages > this.maxPending) throw new ProtocolError("DAP receive queue is full");
        this.incoming = this.incoming
          .then(async () => {
            // 插入一个 task 边界，让响应的 continuation 有机会在下一个 event
            // 之前先执行，即便两个帧在同一个 stream chunk 里到达。
            await nextTurn();
            this.queuedMessages--;
            if (this.state !== "closed") this.dispatch(message);
          })
          .catch((error) => this.fail(asError(error)));
      });
    } catch (error) {
      this.fail(asError(error));
    }
  }

  /** 按消息类型分发到 event 订阅者 / pending 请求 / 反向请求处理器。 */
  private dispatch(message: Message): void {
    if (message.type === "event") {
      this.events.emit("event", message);
    } else if (message.type === "response") {
      const request = this.pending.get(message.request_seq);
      if (!request) return; // 本地已超时或取消，Adapter 才姗姗来迟。
      this.pending.delete(message.request_seq);
      if (message.command !== request.command) {
        const error = new ProtocolError("DAP response command does not match request");
        request.reject(error);
        throw error;
      }
      if (message.success) request.resolve(message);
      else request.reject(new DapResponseError(message));
    } else {
      // 反向请求 handler 内部还可能发起正向请求，绝不能阻塞入站分发。
      if (this.reverseRequests >= this.maxPending) throw new ProtocolError("Too many reverse requests");
      this.reverseRequests++;
      void this.respond(message)
        .catch((error) => this.fail(asError(error)))
        .finally(() => {
          this.reverseRequests--;
        });
    }
  }

  /** 执行反向请求 handler 并把结果封装成 response 帧写回 Adapter。 */
  private async respond(request: DebugProtocol.Request): Promise<void> {
    const response: DebugProtocol.Response = {
      seq: 0,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: true,
    };
    const controller = new AbortController();
    try {
      const handler = this.reverseHandlers.get(request.command);
      if (!handler) throw new Error(`Unsupported reverse request: ${request.command}`);
      response.body = await withDeadline(
        () => Promise.resolve(handler(request, controller.signal)),
        this.requestTimeout,
        [this.lifetime.signal],
      );
    } catch (error) {
      response.success = false;
      response.message = asError(error).message;
    } finally {
      controller.abort();
    }
    if (this.state === "closed") return;
    response.seq = this.sequence++;
    await this.send(encodeMessage(response));
  }
}

/**
 * 给一个异步操作套上超时 + 多个 AbortSignal。任一 signal 触发或超时到期都会拒绝返回的 promise，
 * 并在退出时清理定时器与监听器。`signals[0]` 视作"主 signal"，其 reason 优先作为 abort 原因。
 */
function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signals: (AbortSignal | undefined)[],
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new RangeError("timeoutMs must be an integer between 1 and 2147483647"));
  }
  const signal = AbortSignal.any(signals.filter((value): value is AbortSignal => value !== undefined));
  const abortError = (): Error =>
    signals[0]?.aborted
      ? asError(signals[0].reason)
      : new RequestAbortedError("DAP operation aborted", { cause: signal.reason });
  if (signal.aborted) return Promise.reject(abortError());
  let cleanup = (): void => {};
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    const timer = setTimeout(
      () => reject(new RequestTimeoutError(`DAP operation timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortError();
        return operation();
      })
      .then(resolve, reject);
    // cleanup 归外层 promise 所有，超时与 abort 分支都走这里。
    cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
  }).finally(() => cleanup());
}
