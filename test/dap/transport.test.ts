import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionClosedError } from "../../src/dap/errors.ts";
import {
  StdioTransport,
  StreamTransport,
  TcpTransport,
  type TransportHandlers,
} from "../../src/dap/transport.ts";

/**
 * 检测当前环境能否监听本地 TCP 端口。sandbox / CI 权限受限时，
 * 相关集成用例会直接跳过，而不是报错。
 * `listen` 的错误通过 async 'error' 事件上报，因此需要等一个 tick。
 */
async function canListenTcp(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(0, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}

/** 同样探测一下当前环境能否 spawn 子进程并回收 stdio。 */
function canSpawnChild(): boolean {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

const tcpAvailable = await canListenTcp();
const spawnAvailable = canSpawnChild();

/**
 * 构造一个统一收集回调的 TransportHandlers。
 * `data` / `stderr` / `stdout` 记录到数组，`closed` 通过 promise 暴露给测试。
 */
function makeHandlers(): {
  handlers: TransportHandlers;
  data: Buffer[];
  stderr: Buffer[];
  stdout: Buffer[];
  closed: Promise<Error | undefined>;
} {
  const data: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  let resolveClosed!: (error: Error | undefined) => void;
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });
  const handlers: TransportHandlers = {
    onData: (chunk) => data.push(chunk),
    onClose: (error) => resolveClosed(error),
    onStderr: (chunk) => stderr.push(chunk),
    onStdout: (chunk) => stdout.push(chunk),
  };
  return { handlers, data, stderr, stdout, closed };
}

describe("StreamTransport", () => {
  it("将 readable 流的数据转发到 onData，并把 end 事件转成 onClose", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = new StreamTransport(readable, writable);
    const { handlers, data, closed } = makeHandlers();
    await transport.open(handlers);

    readable.write(Buffer.from("hello"));
    readable.write(Buffer.from(" world"));
    readable.end();

    const error = await closed;
    expect(error).toBeUndefined();
    expect(Buffer.concat(data).toString()).toBe("hello world");
    await transport.close();
  });

  it("write 把数据写入 writable 流；close 后再 write 立即拒绝", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = new StreamTransport(readable, writable);
    const { handlers } = makeHandlers();
    await transport.open(handlers);

    const received: Buffer[] = [];
    writable.on("data", (chunk: Buffer) => received.push(chunk));
    await transport.write(Buffer.from("frame-1"));
    await transport.write(Buffer.from("frame-2"));
    expect(Buffer.concat(received).toString()).toBe("frame-1frame-2");

    await transport.close();
    await expect(transport.write(Buffer.from("frame-3"))).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("重复 open 抛 ConnectionClosedError", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = new StreamTransport(readable, writable);
    const { handlers } = makeHandlers();
    await transport.open(handlers);
    await expect(transport.open(handlers)).rejects.toBeInstanceOf(ConnectionClosedError);
    await transport.close();
  });

  it("open 前调用 write 立即拒绝", async () => {
    const transport = new StreamTransport(new PassThrough(), new PassThrough());
    await expect(transport.write(Buffer.from("x"))).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("close() 是幂等的", async () => {
    const transport = new StreamTransport(new PassThrough(), new PassThrough());
    const { handlers } = makeHandlers();
    await transport.open(handlers);
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("拒绝已被销毁的流", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    readable.destroy();
    const transport = new StreamTransport(readable, writable);
    const { handlers } = makeHandlers();
    await expect(transport.open(handlers)).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("拒绝设置了字符编码的 readable 流（会破坏字节长度）", async () => {
    const readable = new PassThrough();
    readable.setEncoding("utf8");
    const transport = new StreamTransport(readable, new PassThrough());
    const { handlers } = makeHandlers();
    await expect(transport.open(handlers)).rejects.toBeInstanceOf(TypeError);
  });

  it("readable 上的 error 事件通过 onClose 上报", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = new StreamTransport(readable, writable);
    const { handlers, closed } = makeHandlers();
    await transport.open(handlers);

    const boom = new Error("boom");
    readable.emit("error", boom);
    const reported = await closed;
    expect(reported).toBe(boom);
    await transport.close();
  });

  it("ownsStreams=true 时 close 会 destroy 底层流", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = new StreamTransport(readable, writable, true);
    const { handlers } = makeHandlers();
    await transport.open(handlers);
    await transport.close();
    expect(readable.destroyed).toBe(true);
    expect(writable.destroyed).toBe(true);
  });
});

describe("TcpTransport", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startServer(): Promise<{ server: Server; port: number }> {
    const server = createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return { server, port: address.port };
  }

  it("构造时校验端口范围", () => {
    expect(() => new TcpTransport({ port: 0 })).toThrow(RangeError);
    expect(() => new TcpTransport({ port: 70000 })).toThrow(RangeError);
    expect(() => new TcpTransport({ port: 3.14 })).toThrow(RangeError);
  });

  it.skipIf(!tcpAvailable)("连上真实 TCP server 后可以双向传输数据", async () => {
    const { server, port } = await startServer();
    const serverSocket = once(server, "connection");
    const transport = new TcpTransport({ port });
    const { handlers, data, closed } = makeHandlers();
    await transport.open(handlers);
    const [socket] = (await serverSocket) as [import("node:net").Socket];

    // Client -> Server
    await transport.write(Buffer.from("ping"));
    const [serverReceived] = (await once(socket, "data")) as [Buffer];
    expect(serverReceived.toString()).toBe("ping");

    // Server -> Client
    socket.write(Buffer.from("pong"));
    // 等待数据回调；PassThrough 之类的直接 push 是同步的，socket 则要一个 tick。
    while (data.length === 0) await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(data).toString()).toBe("pong");

    socket.end();
    await closed;
    await transport.close();
  });

  it("目标端口未监听时 open 抛错", async () => {
    // 挑一个大概率没监听的端口
    const transport = new TcpTransport({ port: 1, host: "127.0.0.1" });
    await expect(transport.open(makeHandlers().handlers)).rejects.toBeInstanceOf(Error);
    await transport.close();
  }, 10_000);

  it("close 后 write 立即拒绝", async () => {
    const transport = new TcpTransport({ port: 65535 });
    await transport.close();
    await expect(transport.write(Buffer.from("x"))).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});

describe("StdioTransport", () => {
  it.skipIf(!spawnAvailable)("通过子进程 stdio 收发数据，进程 stderr 转到 onStderr", async () => {
    // 用一个极小的 Node 脚本作为 fake adapter：把 stdin 原样回显到 stdout，
    // 并把一段固定字符串写到 stderr。用 --no-warnings 避免 Node 自己往 stderr 写入无关警告。
    const script = `
      process.stdin.on('data', (chunk) => process.stdout.write(chunk));
      process.stderr.write('diag');
      process.stdin.on('end', () => process.exit(0));
    `;
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["--no-warnings", "-e", script],
    });
    const { handlers, data, stderr, closed } = makeHandlers();
    await transport.open(handlers);

    await transport.write(Buffer.from("echo-me"));
    // 等待 echo 回来
    while (Buffer.concat(data).toString() !== "echo-me") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // 等待 stderr 也刷完
    while (!Buffer.concat(stderr).toString().includes("diag")) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await transport.close();
    await closed;
  }, 10_000);

  it.skipIf(!spawnAvailable)("重复 open 抛 ConnectionClosedError", async () => {
    const transport = new StdioTransport({ command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"] });
    const { handlers } = makeHandlers();
    await transport.open(handlers);
    await expect(transport.open(handlers)).rejects.toBeInstanceOf(ConnectionClosedError);
    await transport.close();
  }, 10_000);

  it.skipIf(!spawnAvailable)("命令不存在时 open 拒绝", async () => {
    const transport = new StdioTransport({ command: "/definitely/not/an/executable/path/xxx" });
    await expect(transport.open(makeHandlers().handlers)).rejects.toBeInstanceOf(Error);
    await transport.close();
  });
});
