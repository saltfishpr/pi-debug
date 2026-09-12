import type { DebugProtocol } from "@vscode/debugprotocol";
import { afterEach, describe, expect, it } from "vitest";
import { DapClient } from "../../src/dap/client.ts";
import { encodeMessage, type Message } from "../../src/dap/codec.ts";
import {
  ConnectionClosedError,
  DapResponseError,
  ProtocolError,
  RequestAbortedError,
  RequestTimeoutError,
} from "../../src/dap/errors.ts";
import type { DapTransport, TransportHandlers } from "../../src/dap/transport.ts";

/** 简化调用，避免写 test 时不断重复转换。 */
function encode(message: Message): Buffer {
  return encodeMessage(message as DebugProtocol.ProtocolMessage);
}

/**
 * 手工可控的 fake transport。测试通过 `inject` 把服务端发来的字节喂给 client，
 * 通过 `written` 观察 client 发出的原始帧。
 */
class FakeTransport implements DapTransport {
  private handlers: TransportHandlers | undefined;
  readonly written: Buffer[] = [];
  writeError: Error | undefined;
  openError: Error | undefined;
  openDelayMs = 0;
  closed = false;

  async open(handlers: TransportHandlers): Promise<void> {
    if (this.openDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.openDelayMs));
    if (this.openError) throw this.openError;
    this.handlers = handlers;
  }

  async write(data: Buffer): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.written.push(Buffer.from(data));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** 模拟服务端发送字节到 client。 */
  inject(data: Buffer): void {
    this.handlers?.onData(data);
  }

  /** 模拟 transport 层关闭。 */
  simulateClose(error?: Error): void {
    this.handlers?.onClose(error);
  }

  emitStderr(chunk: Buffer): void {
    this.handlers?.onStderr(chunk);
  }
  emitStdout(chunk: Buffer): void {
    this.handlers?.onStdout?.(chunk);
  }

  /** 把已发出的帧解析回消息对象。 */
  outgoingMessages(): DebugProtocol.ProtocolMessage[] {
    const combined = Buffer.concat(this.written);
    const messages: DebugProtocol.ProtocolMessage[] = [];
    let offset = 0;
    while (offset < combined.length) {
      const separator = combined.indexOf("\r\n\r\n", offset);
      if (separator === -1) break;
      const header = combined.subarray(offset, separator).toString("latin1");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("invalid frame in test");
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      const body = combined.subarray(bodyStart, bodyStart + length).toString("utf8");
      messages.push(JSON.parse(body));
      offset = bodyStart + length;
    }
    return messages;
  }
}

/** 等待一小段微/宏任务，让 client 内部的 incoming 队列消化完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 构造响应帧的便捷函数。 */
function responseFrame(
  requestSeq: number,
  command: string,
  overrides: Partial<DebugProtocol.Response> = {},
): Buffer {
  return encode({
    seq: 100 + requestSeq,
    type: "response",
    request_seq: requestSeq,
    command,
    success: true,
    ...overrides,
  } as Message);
}

describe("DapClient 生命周期", () => {
  let client: DapClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("connect 成功后可以发起请求", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const promise = client.request("threads");
    await flush();
    // client 发出的帧的 seq 应该是 1
    const [outgoing] = transport.outgoingMessages();
    expect(outgoing).toMatchObject({ seq: 1, type: "request", command: "threads" });
    transport.inject(responseFrame(1, "threads", { body: { threads: [] } }));
    const response = await promise;
    expect(response.command).toBe("threads");
    expect(response.success).toBe(true);
  });

  it("重复 connect 抛 ConnectionClosedError", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("connect 超时时抛 RequestTimeoutError 并关闭 transport", async () => {
    const transport = new FakeTransport();
    transport.openDelayMs = 100;
    client = new DapClient(transport, { connectTimeoutMs: 20 });
    await expect(client.connect()).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(transport.closed).toBe(true);
  });

  it("未 connect 就发请求会拒绝", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await expect(client.request("threads")).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("close 是幂等的，并且触发 onClose 事件", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    let received: Error | undefined;
    client.onClose((error) => {
      received = error;
    });
    await client.close();
    await client.close();
    expect(received).toBeInstanceOf(ConnectionClosedError);
    expect(transport.closed).toBe(true);
  });

  it("transport 意外关闭会拒绝所有 pending 请求", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const promise = client.request("threads");
    const boom = new Error("network gone");
    transport.simulateClose(boom);
    await expect(promise).rejects.toBe(boom);
  });

  it("构造时校验参数合法性", () => {
    const transport = new FakeTransport();
    expect(() => new DapClient(transport, { requestTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new DapClient(transport, { maxPendingRequests: -1 })).toThrow(RangeError);
  });
});

describe("DapClient.request", () => {
  let client: DapClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("按 seq 匹配响应并返回", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();

    const p1 = client.request("threads");
    const p2 = client.request("evaluate", { expression: "x" });
    await flush();

    // 乱序响应
    transport.inject(responseFrame(2, "evaluate", { body: { result: "42", variablesReference: 0 } }));
    transport.inject(responseFrame(1, "threads", { body: { threads: [{ id: 1, name: "main" }] } }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.command).toBe("threads");
    expect(r2.command).toBe("evaluate");
    expect((r2.body as { result: string }).result).toBe("42");
  });

  it("success=false 的响应转成 DapResponseError", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const promise = client.request("evaluate", { expression: "x" });
    await flush();
    transport.inject(responseFrame(1, "evaluate", { success: false, message: "not available" }));
    await expect(promise).rejects.toBeInstanceOf(DapResponseError);
    await expect(promise).rejects.toMatchObject({ message: "not available" });
  });

  it("超时时抛 RequestTimeoutError，但不会关闭连接", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport, { requestTimeoutMs: 20 });
    await client.connect();
    await expect(client.request("threads")).rejects.toBeInstanceOf(RequestTimeoutError);
    // 单个请求超时不应关闭连接
    await expect(client.request("threads", undefined, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
    expect(transport.closed).toBe(false);
  });

  it("响应超时后姗姗来迟的 response 不会引发错误", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport, { requestTimeoutMs: 20 });
    await client.connect();
    await expect(client.request("threads")).rejects.toBeInstanceOf(RequestTimeoutError);
    // 迟到的响应，client 应静默忽略
    transport.inject(responseFrame(1, "threads", { body: { threads: [] } }));
    await flush();
    expect(transport.closed).toBe(false);
  });

  it("AbortSignal 触发时抛 RequestAbortedError", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const controller = new AbortController();
    const promise = client.request("threads", undefined, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it("响应 command 与请求不匹配时抛 ProtocolError 并关闭连接", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const promise = client.request("threads");
    await flush();
    // 请求是 threads，服务端却回复 evaluate
    transport.inject(responseFrame(1, "evaluate", { body: {} }));
    await expect(promise).rejects.toBeInstanceOf(ProtocolError);
  });

  it("超过 maxPendingRequests 时立即拒绝", async () => {
    const transport = new FakeTransport();
    // 用足够短的超时，避免 pending 请求把测试挂到默认 30s。
    client = new DapClient(transport, { maxPendingRequests: 2, requestTimeoutMs: 50 });
    await client.connect();
    const p1 = client.request("threads").catch(() => {});
    const p2 = client.request("threads").catch(() => {});
    // 等 pending 表填满（`pending.set` 发生在 microtask 之后）
    await flush();
    await expect(client.request("threads")).rejects.toThrow(/Too many pending/);
    await Promise.all([p1, p2]);
  });
});

describe("DapClient 事件与订阅", () => {
  let client: DapClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("event 帧派发到 onEvent 订阅者", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const events: DebugProtocol.Event[] = [];
    const unsub = client.onEvent((event) => events.push(event));
    transport.inject(encode({ seq: 1, type: "event", event: "stopped", body: { reason: "step" } }));
    transport.inject(encode({ seq: 2, type: "event", event: "continued" }));
    await flush();
    expect(events.map((e) => e.event)).toEqual(["stopped", "continued"]);
    unsub();
    transport.inject(encode({ seq: 3, type: "event", event: "terminated" }));
    await flush();
    expect(events).toHaveLength(2);
  });

  it("onOutput 转发 stderr/stdout 字节", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    client.onOutput("stderr", (chunk) => stderr.push(chunk));
    client.onOutput("stdout", (chunk) => stdout.push(chunk));
    transport.emitStderr(Buffer.from("err-1"));
    transport.emitStdout(Buffer.from("out-1"));
    expect(Buffer.concat(stderr).toString()).toBe("err-1");
    expect(Buffer.concat(stdout).toString()).toBe("out-1");
  });
});

describe("DapClient 反向请求", () => {
  let client: DapClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("成功的 handler 会以 success=true 响应，body 为返回值", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    client.onReverseRequest("runInTerminal", async (request) => {
      expect(request.command).toBe("runInTerminal");
      return { processId: 42 };
    });
    transport.inject(
      encode({
        seq: 1,
        type: "request",
        command: "runInTerminal",
        arguments: { kind: "integrated", cwd: "", args: [] },
      } as Message),
    );
    await flush();
    const messages = transport.outgoingMessages();
    expect(messages).toHaveLength(1);
    const response = messages[0] as DebugProtocol.Response;
    expect(response.type).toBe("response");
    expect(response.request_seq).toBe(1);
    expect(response.command).toBe("runInTerminal");
    expect(response.success).toBe(true);
    expect(response.body).toEqual({ processId: 42 });
  });

  it("handler 抛错时响应 success=false 且携带 message", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    client.onReverseRequest("runInTerminal", () => {
      throw new Error("terminal denied");
    });
    transport.inject(encode({ seq: 1, type: "request", command: "runInTerminal" } as Message));
    await flush();
    const [response] = transport.outgoingMessages() as [DebugProtocol.Response];
    expect(response.success).toBe(false);
    expect(response.message).toBe("terminal denied");
  });

  it("未注册的反向请求响应 success=false", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    transport.inject(encode({ seq: 1, type: "request", command: "unknown" } as Message));
    await flush();
    const [response] = transport.outgoingMessages() as [DebugProtocol.Response];
    expect(response.success).toBe(false);
    expect(response.message).toMatch(/Unsupported reverse request/);
  });

  it("同一 command 不允许重复注册 handler", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    client.onReverseRequest("runInTerminal", () => ({}));
    expect(() => client!.onReverseRequest("runInTerminal", () => ({}))).toThrow(/already registered/);
  });

  it("反注册后同名 command 可以重新绑定", async () => {
    const transport = new FakeTransport();
    client = new DapClient(transport);
    await client.connect();
    const unsub = client.onReverseRequest("runInTerminal", () => ({ a: 1 }));
    unsub();
    // 重复反注册应无副作用
    unsub();
    client.onReverseRequest("runInTerminal", () => ({ a: 2 }));
    transport.inject(encode({ seq: 1, type: "request", command: "runInTerminal" } as Message));
    await flush();
    const [response] = transport.outgoingMessages() as [DebugProtocol.Response];
    expect(response.body).toEqual({ a: 2 });
  });
});
