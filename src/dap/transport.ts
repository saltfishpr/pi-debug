import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncDisposableStore } from "../common/lifecycle.js";
import { asError, ConnectionClosedError } from "./errors.js";

/**
 * 一条 DAP 双向字节通道的抽象。每个实例只对应一条连接、且只允许一个所有者。
 * `write` 在字节被底层流写出后才 resolve，用于配合上层的写入排队与背压。
 */
export interface DapTransport {
  /** 打开连接并注册事件回调；只能调用一次。 */
  open(handlers: TransportHandlers): Promise<void>;
  /** 写入一个完整的 DAP 帧（含头部+body），完成表示已交付给底层流。 */
  write(data: Buffer): Promise<void>;
  /** 关闭连接并释放持有的资源；多次调用是幂等的。 */
  close(): Promise<void>;
}

/** transport 上报事件的回调集合。 */
export interface TransportHandlers {
  /** 收到原始字节流片段，由上层解码器负责拼帧。 */
  onData(data: Buffer): void;
  /** 连接结束回调；`error` 为空表示正常结束。 */
  onClose(error?: Error): void;
  /** Adapter 进程的 stderr 输出，通常用于诊断日志。 */
  onStderr(data: Buffer): void;
  /** 仅 server 模式下有意义：Adapter 进程的 stdout，本身不是 DAP 帧。 */
  onStdout?(data: Buffer): void;
}

/**
 * 直接基于现有 Readable/Writable 流的 transport 实现。
 *
 * 默认"借用"传入的流，不负责关闭它们；显式传入 `ownsStreams=true` 时才会在
 * `close` 中 destroy 并等待 finish。
 */
export class StreamTransport implements DapTransport {
  private readonly resources = new AsyncDisposableStore();
  /** 用于中止仍在等待写入回调的 Promise 的关闭信号。 */
  private readonly shutdown = new AbortController();

  /** 由 open 注册的上层事件回调。 */
  private handlers: TransportHandlers | undefined;
  /** 标记 transport 是否已经结束，避免重复上报关闭事件。 */
  private ended = false;

  /** 处于 in-flight 的写入数，用于决定何时能安全解除 error 监听。 */
  private pendingWrites = 0;

  constructor(
    /** 提供 Adapter 输出字节的输入流。 */
    private readonly readable: Readable,
    /** 接收 DAP 帧字节的输出流。 */
    private readonly writable: Writable,
    /** 标记关闭时是否应销毁传入的流。 */
    private readonly ownsStreams = false,
  ) {
    this.resources.add({ dispose: () => this.release() });
  }

  /** 注册流事件并开始向上层转发输入字节。 */
  async open(handlers: TransportHandlers): Promise<void> {
    if (this.handlers || this.ended) throw new ConnectionClosedError("Transport cannot be reopened");
    if (
      this.readable.destroyed ||
      this.writable.destroyed ||
      this.readable.readableEnded ||
      this.writable.writableEnded
    ) {
      throw new ConnectionClosedError("Streams are already closed");
    }
    // DAP 按字节计算 Content-Length；一旦流被 setEncoding() 转成字符串模式，
    // 长度会与实际字节数不一致，破坏帧结构。
    if (this.readable.readableEncoding || this.readable.readableObjectMode || this.writable.writableObjectMode) {
      throw new TypeError("DAP requires binary streams");
    }
    this.handlers = handlers;
    this.readable.on("error", this.onError);
    if (!Object.is(this.writable, this.readable)) this.writable.on("error", this.onError);
    this.readable.on("end", this.onEnd);
    this.readable.on("close", this.onEnd);
    this.writable.on("close", this.onEnd);
    this.writable.on("finish", this.onEnd);
    this.readable.on("data", this.onData);
  }

  /** 向输出流写入一帧 DAP 字节，并等待写入回调。 */
  write(data: Buffer): Promise<void> {
    if (!this.handlers || this.ended) return Promise.reject(new ConnectionClosedError("Transport is not open"));
    // 上层 client 已经串行化写入并对队列做了限制。等待 write 回调也能自然处理
    // 背压：writable 拥塞时 Node 会推迟回调触发。
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(new ConnectionClosedError("Transport closed during write"));
      this.shutdown.signal.addEventListener("abort", abort, { once: true });
      this.pendingWrites++;
      try {
        this.writable.write(data, (error) => {
          this.releaseWrite();
          this.shutdown.signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        this.releaseWrite();
        this.shutdown.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  /** 中止读写并释放流事件监听器及自有流。 */
  close(): Promise<void> {
    this.ended = true;
    this.shutdown.abort();
    return this.resources.dispose();
  }

  /** 解除监听器；自有流还会等待销毁完成。 */
  private async release(): Promise<void> {
    this.readable.pause();
    this.readable.off("data", this.onData);
    this.readable.off("end", this.onEnd);
    this.readable.off("close", this.onEnd);
    this.writable.off("close", this.onEnd);
    this.writable.off("finish", this.onEnd);
    if (this.ownsStreams) {
      // 保留 error 监听直到 destroy 完成——包括那些 write 回调已触发、
      // 但 error 事件在下一 tick 才派发的场景。
      const drained = [this.readable, this.writable].map((stream) =>
        finished(stream, { cleanup: true }).catch(() => {}),
      );
      this.readable.destroy();
      this.writable.destroy();
      await Promise.all(drained);
    }
    // 若 readable/writable 是同一个 duplex，需要保留监听器捕获后续写入错误。
    if (!Object.is(this.writable, this.readable)) this.readable.off("error", this.onError);
    // 拥有的流已经在上面 destroy 完毕；借用的流若还有 pending write，
    // 则 error 监听会在 releaseWrite 中解除。
    if (this.ownsStreams || this.pendingWrites === 0) this.writable.off("error", this.onError);
  }

  /** 写回调触发后延后一个 tick 递减计数，让 Node 的 error 事件先派发完。 */
  private releaseWrite(): void {
    setImmediate(() => {
      this.pendingWrites--;
      if (!this.ownsStreams && this.shutdown.signal.aborted && this.pendingWrites === 0) {
        this.writable.off("error", this.onError);
      }
    });
  }

  /** 将输入流字节转发给当前 handlers。 */
  private readonly onData = (data: Buffer): void => this.handlers?.onData(data);
  /** 将流错误收敛为 transport 关闭。 */
  private readonly onError = (error: Error): void => this.finish(error);
  /** 将流结束或关闭收敛为 transport 关闭。 */
  private readonly onEnd = (): void => this.finish();

  /** 唯一的关闭汇聚点：向上通知一次 onClose，并翻转内部状态。 */
  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers?.onClose(error);
    this.shutdown.abort();
  }
}

/** 主动连接一个已在监听的 TCP DAP 端口。不负责启动 server 进程。 */
export class TcpTransport implements DapTransport {
  private readonly resources = new AsyncDisposableStore();
  private stream: StreamTransport | undefined;

  constructor(private readonly options: { port: number; host?: string }) {
    validatePort(options.port);
    this.resources.add({ dispose: () => this.stream?.close() });
  }

  /** 建立 TCP 连接并委托流 transport 处理读写。 */
  async open(handlers: TransportHandlers): Promise<void> {
    if (this.stream || this.resources.isDisposed) throw new ConnectionClosedError("Transport cannot be reopened");
    const socket = createConnection({ port: this.options.port, host: this.options.host ?? "127.0.0.1" });
    socket.setNoDelay(true);
    this.stream = new StreamTransport(socket, socket, true);
    await Promise.all([ready(socket, "connect"), this.stream.open(handlers)]);
  }

  /** 通过已建立的 TCP 连接写入 DAP 帧。 */
  write(data: Buffer): Promise<void> {
    return this.stream?.write(data) ?? Promise.reject(new ConnectionClosedError("Transport is not open"));
  }

  /** 关闭已建立的 TCP 连接。 */
  close(): Promise<void> {
    return this.resources.dispose();
  }
}

/** 启动 Adapter 子进程的通用配置。 */
export interface ProcessOptions {
  /** Adapter 可执行程序路径或命令名。 */
  command: string;
  /** 传给 Adapter 的参数列表。 */
  args?: readonly string[];
  /** 子进程工作目录。 */
  cwd?: string;
  /** 直接透传给 spawn 的环境变量；不设置时继承当前 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** SIGTERM 后等待 Adapter 自行退出的时间（毫秒），超时改用 SIGKILL。 */
  shutdownTimeoutMs?: number;
}

/**
 * 启动 Adapter 子进程并通过 stdin/stdout 与之通信。仅负责 Adapter 生命周期；
 * 真实的 debuggee（被调试程序）仍需通过 DAP 的 `launch` / `attach` 请求发起。
 */
export class StdioTransport implements DapTransport {
  private process: AdapterProcess | undefined;
  private stream: StreamTransport | undefined;
  private readonly resources = new AsyncDisposableStore();

  constructor(private readonly options: ProcessOptions) {
    this.resources.add({ dispose: () => this.process?.stop() });
    this.resources.add({ dispose: () => this.stream?.close() });
  }

  /** 启动 Adapter 子进程并连接其标准输入输出流。 */
  async open(handlers: TransportHandlers): Promise<void> {
    if (this.process || this.resources.isDisposed) throw new ConnectionClosedError("Transport cannot be reopened");
    this.process = new AdapterProcess(this.options, handlers);
    this.stream = new StreamTransport(this.process.child.stdout!, this.process.child.stdin!, true);
    await Promise.all([this.process.ready, this.stream.open(handlers)]);
  }

  /** 通过 Adapter 的标准输入写入 DAP 帧。 */
  write(data: Buffer): Promise<void> {
    return this.stream?.write(data) ?? Promise.reject(new ConnectionClosedError("Transport is not open"));
  }

  /** 依次停止 Adapter 并关闭其通信流。 */
  close(): Promise<void> {
    return this.resources.dispose();
  }
}

/** 启动 Adapter 并等其监听 TCP 端口时使用的配置。 */
export interface ServerOptions extends ProcessOptions {
  /** Adapter 明确会监听的端口号；调用方需确保该端口可用。 */
  port: number;
  /** 连接目标地址，默认 127.0.0.1。 */
  host?: string;
  /** 端口尚未就绪时的重试间隔（毫秒）。 */
  retryIntervalMs?: number;
}

/**
 * 由本进程 spawn 一个 TCP 模式的 DAP server（例如 `dlv dap`），
 * 反复重试直到 TCP 连上，之后保留首次成功的连接。
 * 同时拥有 Adapter 进程和 socket 的生命周期。
 */
export class SpawnedServerTransport implements DapTransport {
  private readonly resources = new AsyncDisposableStore();
  /** 用于在关闭时中止 spawn 与重试连接的整体控制器。 */
  private readonly lifetime = new AbortController();

  private readonly retryInterval: number;
  private process: AdapterProcess | undefined;
  private socket: TcpTransport | undefined;
  /** 标记首次 TCP 连接是否成功，成功前的 socket 关闭仅表示重试。 */
  private connected = false;

  constructor(private readonly options: ServerOptions) {
    validatePort(options.port);
    this.retryInterval = options.retryIntervalMs ?? 50;
    // 连接清理失败也不能跳过进程清理。
    this.resources.add({ dispose: () => this.socket?.close() });
    this.resources.add({ dispose: () => this.process?.stop() });
  }

  /** 启动 server Adapter，循环连接其 TCP 端口直至成功或被中止。 */
  async open(handlers: TransportHandlers): Promise<void> {
    if (this.process || this.lifetime.signal.aborted) throw new ConnectionClosedError("Transport cannot be reopened");
    this.process = new AdapterProcess(this.options, {
      ...handlers,
      onClose: (error) => {
        this.lifetime.abort(error ?? new ConnectionClosedError("Adapter server exited"));
        handlers.onClose(error);
      },
    });
    // server 模式下 stdout 是日志/诊断输出，不是 DAP 帧；两条 pipe 都要 drain 掉。
    this.process.child.stdout!.on("data", (data: Buffer) => handlers.onStdout?.(data));
    this.process.child.stdout!.on("error", (error) => handlers.onClose(asError(error)));
    await this.process.ready;
    while (!this.lifetime.signal.aborted) {
      this.socket = new TcpTransport(this.options);
      try {
        await this.socket.open({
          ...handlers,
          onClose: (error) => {
            if (this.connected) handlers.onClose(error);
          },
        });
        this.lifetime.signal.throwIfAborted();
        this.connected = true;
        return;
      } catch (error) {
        await this.socket.close();
        this.lifetime.signal.throwIfAborted();
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ECONNREFUSED") throw error;
      }
      // 整体的 connect 超时由 DapClient.connect 掌控；这里的等待在 close 时会被 abort。
      try {
        await delay(this.retryInterval, undefined, { signal: this.lifetime.signal });
      } catch (error) {
        this.lifetime.signal.throwIfAborted();
        throw error;
      }
    }
    this.lifetime.signal.throwIfAborted();
  }

  /** 通过已建立的 server TCP 连接写入 DAP 帧。 */
  write(data: Buffer): Promise<void> {
    return this.socket?.write(data) ?? Promise.reject(new ConnectionClosedError("Server is not connected"));
  }

  /** 中止重试连接并依次关闭 socket 与 Adapter 进程。 */
  close(): Promise<void> {
    this.lifetime.abort(new ConnectionClosedError("Server transport closed"));
    return this.resources.dispose();
  }
}

/**
 * 包装 spawn 出来的 Adapter 子进程，暴露 `ready` promise 与统一的 `stop` 流程。
 * 负责把 spawn 错误、进程退出、stderr 数据都转成 handlers 回调。
 */
class AdapterProcess {
  private readonly resources = new AsyncDisposableStore();

  /** 被包装的 Adapter 子进程。 */
  readonly child: ChildProcess;
  /** 发送 SIGTERM 后等待进程自行退出的最长时间。 */
  private readonly shutdownTimeout: number;

  /** Adapter 进程完成 spawn（拿到 pid）后兑现。 */
  readonly ready: Promise<void>;
  /** 进程触发 close 事件后兑现，供终止流程等待实际退出。 */
  private readonly exited: Promise<void>;

  constructor(options: ProcessOptions, handlers: TransportHandlers) {
    this.shutdownTimeout = options.shutdownTimeoutMs ?? 1000;
    const spawnOptions: SpawnOptions = { stdio: "pipe", shell: false, windowsHide: true };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = options.env;
    this.child = spawn(options.command, [...(options.args ?? [])], spawnOptions);
    this.resources.add({ dispose: () => this.terminate() });
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      this.resources.add({
        dispose: () => {
          stream?.destroy();
        },
      });
    }
    this.ready = ready(this.child, "spawn");
    this.exited = new Promise<void>((resolve) =>
      this.child.once("close", (code, signal) => {
        resolve();
        handlers.onClose(
          code === 0 ? undefined : new ConnectionClosedError(`Adapter exited: code=${code}, signal=${signal}`),
        );
      }),
    );
    this.child.on("error", (error) => handlers.onClose(asError(error)));
    this.child.stderr!.on("data", (data: Buffer) => handlers.onStderr(data));
    this.child.stderr!.on("error", (error) => handlers.onClose(asError(error)));
  }

  /** 优雅停止 Adapter：先 SIGTERM 等一段时间，超时再 SIGKILL，最后 destroy stdio。 */
  stop(): Promise<void> {
    return this.resources.dispose();
  }

  /** 终止仍在运行的 Adapter 进程，超时后升级为 SIGKILL。 */
  private async terminate(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.child.kill("SIGKILL");
            resolve();
          }, this.shutdownTimeout);
        }),
      ]).finally(() => clearTimeout(timer));
      await this.exited;
    }
  }
}

/** 校验端口号在合法范围内。 */
function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("port must be between 1 and 65535");
}

/** 等待某个 EventEmitter 首次触发 `event`；`error` / `close` 会以拒绝形式提前结束。 */
function ready(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      emitter.off(event, onReady);
      emitter.off("error", onError);
      emitter.off("close", onClose);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => onError(new ConnectionClosedError("Transport closed before ready"));
    emitter.once(event, onReady);
    emitter.once("error", onError);
    emitter.once("close", onClose);
  });
}
