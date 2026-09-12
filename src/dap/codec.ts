import type { DebugProtocol } from "@vscode/debugprotocol";
import { ProtocolError } from "./errors.js";

/** `MessageDecoder` 的容量限制配置，超过限制会抛 `ProtocolError`。 */
export interface CodecOptions {
  /** 单个消息头部字节上限，防止恶意/异常输入耗尽内存。默认 8 KiB。 */
  maxHeaderBytes?: number;
  /** 单个消息体字节上限。默认 16 MiB。 */
  maxMessageBytes?: number;
}

/**
 * 已解析并通过基础校验的 DAP 消息帧。判别式 `type` 与 DAP 规范一致：
 * `request` / `response` / `event`。
 */
export type Message =
  | (DebugProtocol.Request & { type: "request" })
  | (DebugProtocol.Response & { type: "response" })
  | (DebugProtocol.Event & { type: "event" });

/**
 * 把消息编码为 DAP 线上帧：`Content-Length` 头 + 空行 + UTF-8 JSON body。
 * 头部长度使用 body 的**字节数**，避免多字节字符导致长度错位。
 */
export function encodeMessage(message: DebugProtocol.ProtocolMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * 增量式字节解码器。持续 `push` 原始字节，遇到完整帧则回调 `accept`。
 *
 * 一旦抛出 `ProtocolError`，内部状态即不再可信，调用方应丢弃当前 decoder 并关闭连接。
 */
export class MessageDecoder {
  private readonly maxHeaderBytes: number;
  private readonly maxMessageBytes: number;

  // 当前正在累积的头部字节（尚未见到 \r\n\r\n）。
  private header = Buffer.alloc(0);
  // 当前正在填充的 body 缓冲区；`undefined` 表示还在解析头部。
  private body: Buffer | undefined;
  // 已写入 `body` 的字节数，用于追踪填充进度。
  private offset = 0;

  constructor(options: CodecOptions = {}) {
    this.maxHeaderBytes = options.maxHeaderBytes ?? 8192;
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    for (const limit of [this.maxHeaderBytes, this.maxMessageBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Codec limits must be positive integers");
    }
  }

  /**
   * 追加一段字节。解析出的完整消息通过 `accept` 回调交付；单次 `push` 可能触发 0 到多次回调。
   * 回调内抛出的异常会向上冒泡，调用方需在外层捕获并终止连接。
   */
  push(data: Buffer, accept: (message: Message) => void): void {
    while (data.length) {
      if (!this.body) {
        // 头部较小且有硬上限；body 一次性按 Content-Length 分配，避免大响应
        // 分多个 chunk 到达时反复拷贝造成的 O(n²) 成本。
        const previousLength = this.header.length;
        const candidate = Buffer.concat([this.header, data.subarray(0, this.maxHeaderBytes - previousLength)]);
        const end = candidate.indexOf("\r\n\r\n");
        if (end === -1) {
          if (candidate.length >= this.maxHeaderBytes) throw new ProtocolError("DAP header is too large");
          this.header = candidate;
          return;
        }
        const lengths = candidate
          .subarray(0, end)
          .toString("latin1")
          .split("\r\n")
          .filter((line) => /^Content-Length:/i.test(line));
        const match = lengths.length === 1 ? /^Content-Length:\s*(\d+)\s*$/i.exec(lengths[0]) : null;
        const length = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(length) || length <= 0 || length > this.maxMessageBytes) {
          throw new ProtocolError("Invalid or oversized DAP Content-Length");
        }
        data = data.subarray(end + 4 - previousLength);
        this.header = Buffer.alloc(0);
        this.body = Buffer.allocUnsafe(length);
        this.offset = 0;
      }
      const count = Math.min(data.length, this.body.length - this.offset);
      data.copy(this.body, this.offset, 0, count);
      this.offset += count;
      data = data.subarray(count);
      if (this.offset === this.body.length) {
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.body));
        } catch (cause) {
          throw new ProtocolError("Invalid DAP JSON payload", { cause });
        }
        this.body = undefined;
        this.offset = 0;
        accept(validateMessage(value));
      }
    }
  }

  /**
   * 通知解码器输入流已结束。若仍存在半个帧（残余头部或未填满的 body），
   * 说明对端在帧中间断开，抛 `ProtocolError`。
   */
  end(): void {
    if (this.header.length || this.body) throw new ProtocolError("Connection ended during a DAP frame");
  }
}

/**
 * 对反序列化后的 JSON 做最小结构校验，确保 `seq`/`type`/关键字段满足 DAP 规范。
 * 只做协议层校验，不校验 `arguments` / `body` 的具体 shape。
 */
function validateMessage(value: unknown): Message {
  if (!value || typeof value !== "object") throw new ProtocolError("Invalid DAP message");
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 0) throw new ProtocolError("Invalid DAP seq");
  switch (message.type) {
    case "request":
      if (typeof message.command === "string") return value as Message;
      break;
    case "event":
      if (typeof message.event === "string") return value as Message;
      break;
    case "response":
      if (
        typeof message.command === "string" &&
        typeof message.success === "boolean" &&
        Number.isSafeInteger(message.request_seq) &&
        (message.request_seq as number) >= 0
      ) {
        return value as Message;
      }
  }
  throw new ProtocolError("Invalid DAP message envelope");
}
