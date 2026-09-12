import { describe, expect, it } from "vitest";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { encodeMessage, MessageDecoder, type Message } from "../../src/dap/codec.ts";
import { ProtocolError } from "../../src/dap/errors.ts";

/**
 * `encodeMessage` 声明接受 `DebugProtocol.ProtocolMessage`（仅 seq+type），但实际
 * 使用时传入的都是具体的 Request/Response/Event。测试里统一包一层转换，
 * 让断言可以写完整的字段而不报错。
 */
function encode(message: Message): Buffer {
  return encodeMessage(message as DebugProtocol.ProtocolMessage);
}

/** 把 decoder 接收到的所有消息累积到数组，便于断言。 */
function collect(decoder: MessageDecoder, chunks: Buffer[]): Message[] {
  const out: Message[] = [];
  for (const chunk of chunks) decoder.push(chunk, (message) => out.push(message));
  return out;
}

describe("encodeMessage", () => {
  it("使用 body 的字节数作为 Content-Length，头部使用 CRLFCRLF 分隔", () => {
    const frame = encode({ seq: 1, type: "event", event: "stopped" });
    const text = frame.toString("utf8");
    const separator = text.indexOf("\r\n\r\n");
    expect(separator).toBeGreaterThan(0);
    const header = text.slice(0, separator);
    const body = text.slice(separator + 4);
    expect(header).toMatch(/^Content-Length: \d+$/);
    const length = Number(/Content-Length: (\d+)/.exec(header)![1]);
    expect(length).toBe(Buffer.byteLength(body, "utf8"));
    expect(JSON.parse(body)).toEqual({ seq: 1, type: "event", event: "stopped" });
  });

  it("对多字节字符按字节而不是字符长度计算", () => {
    const message = { seq: 2, type: "event" as const, event: "output", body: { output: "你好, 🌟" } };
    const frame = encode(message);
    const text = frame.toString("utf8");
    const separator = text.indexOf("\r\n\r\n");
    const length = Number(/Content-Length: (\d+)/.exec(text.slice(0, separator))![1]);
    const body = frame.subarray(separator + 4);
    expect(length).toBe(body.length);
    // 与字符长度不同，验证按字节计数
    expect(length).not.toBe(JSON.stringify(message).length);
  });
});

describe("MessageDecoder 正常路径", () => {
  it("解析单个完整帧", () => {
    const decoder = new MessageDecoder();
    const frame = encode({ seq: 1, type: "event", event: "initialized" });
    const messages = collect(decoder, [frame]);
    expect(messages).toEqual([{ seq: 1, type: "event", event: "initialized" }]);
  });

  it("对同一 chunk 中的多条消息按顺序回调", () => {
    const decoder = new MessageDecoder();
    const frames = Buffer.concat([
      encode({ seq: 1, type: "event", event: "one" }),
      encode({ seq: 2, type: "event", event: "two" }),
      encode({ seq: 3, type: "event", event: "three" }),
    ]);
    const messages = collect(decoder, [frames]);
    expect(messages.map((m) => (m as { event: string }).event)).toEqual(["one", "two", "three"]);
  });

  it("允许把一条消息按任意字节切分成多个 chunk", () => {
    const decoder = new MessageDecoder();
    const frame = encode({
      seq: 7,
      type: "response",
      request_seq: 5,
      command: "threads",
      success: true,
      body: { threads: [] },
    });
    const chunks: Buffer[] = [];
    for (let i = 0; i < frame.length; i++) chunks.push(frame.subarray(i, i + 1));
    const messages = collect(decoder, chunks);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "response", command: "threads", success: true });
  });

  it("支持三种消息判别式：request / response / event", () => {
    const decoder = new MessageDecoder();
    const messages = collect(decoder, [
      encode({ seq: 1, type: "request", command: "runInTerminal" }),
      encode({ seq: 2, type: "response", request_seq: 1, command: "runInTerminal", success: true }),
      encode({ seq: 3, type: "event", event: "stopped" }),
    ]);
    expect(messages.map((m) => m.type)).toEqual(["request", "response", "event"]);
  });

  it("push 空 buffer 时不产生任何回调", () => {
    const decoder = new MessageDecoder();
    const messages = collect(decoder, [Buffer.alloc(0)]);
    expect(messages).toEqual([]);
    // 干净的 decoder 允许 end
    expect(() => decoder.end()).not.toThrow();
  });
});

describe("MessageDecoder 错误路径", () => {
  it("头部过大时抛 ProtocolError", () => {
    const decoder = new MessageDecoder({ maxHeaderBytes: 32 });
    const oversized = Buffer.from("X-Very-Long-Header: " + "a".repeat(64) + "\r\n\r\n", "ascii");
    expect(() => decoder.push(oversized, () => {})).toThrow(ProtocolError);
  });

  it("Content-Length 缺失时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    const frame = Buffer.from("X-Other: 1\r\n\r\n{}", "ascii");
    expect(() => decoder.push(frame, () => {})).toThrow(/Content-Length/);
  });

  it("Content-Length 为非法值（负数/非整数）时抛 ProtocolError", () => {
    for (const value of ["-1", "0", "abc", "3.14"]) {
      const decoder = new MessageDecoder();
      const frame = Buffer.from(`Content-Length: ${value}\r\n\r\n`, "ascii");
      expect(() => decoder.push(frame, () => {})).toThrow(ProtocolError);
    }
  });

  it("Content-Length 超过 maxMessageBytes 时抛 ProtocolError", () => {
    const decoder = new MessageDecoder({ maxMessageBytes: 16 });
    const frame = Buffer.from("Content-Length: 1024\r\n\r\n", "ascii");
    expect(() => decoder.push(frame, () => {})).toThrow(/oversized/i);
  });

  it("出现重复的 Content-Length 头时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    const body = "{}";
    const frame = Buffer.from(`Content-Length: 2\r\nContent-Length: 2\r\n\r\n${body}`, "ascii");
    expect(() => decoder.push(frame, () => {})).toThrow(ProtocolError);
  });

  it("body 不是合法 UTF-8 JSON 时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    const body = Buffer.from("not-json");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    expect(() => decoder.push(frame, () => {})).toThrow(/Invalid DAP JSON/);
  });

  it("消息 envelope 缺少必要字段时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    const bad = Buffer.from(JSON.stringify({ seq: 1, type: "response", success: true }), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`, "ascii"), bad]);
    expect(() => decoder.push(frame, () => {})).toThrow(/envelope/);
  });

  it("seq 非法（负数/非整数）时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    const bad = Buffer.from(JSON.stringify({ seq: -1, type: "event", event: "x" }), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`, "ascii"), bad]);
    expect(() => decoder.push(frame, () => {})).toThrow(/seq/);
  });

  it("end() 在半个帧中间被调用时抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    decoder.push(Buffer.from("Content-Length: 10\r\n\r\n", "ascii"), () => {});
    // header 已消耗但 body 还未填满
    decoder.push(Buffer.from("abc"), () => {});
    expect(() => decoder.end()).toThrow(/during a DAP frame/);
  });

  it("end() 在头部读到一半时也抛 ProtocolError", () => {
    const decoder = new MessageDecoder();
    decoder.push(Buffer.from("Content-Length: 10", "ascii"), () => {});
    expect(() => decoder.end()).toThrow(ProtocolError);
  });

  it("构造函数拒绝非法的容量限制", () => {
    expect(() => new MessageDecoder({ maxHeaderBytes: 0 })).toThrow(RangeError);
    expect(() => new MessageDecoder({ maxMessageBytes: -1 })).toThrow(RangeError);
    expect(() => new MessageDecoder({ maxMessageBytes: 3.14 })).toThrow(RangeError);
  });
});
