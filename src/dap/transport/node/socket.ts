import net from "node:net";
import { StreamTransport } from "./stream.js";

export interface SocketTransportOptions {
  /** TCP port the adapter server listens on. */
  port: number;
  /** Host to connect to. Defaults to 127.0.0.1. */
  host?: string;
}

export interface PipeTransportOptions {
  /** Named pipe (Windows) or UNIX domain socket path. */
  path: string;
}

/** Connects to a debug adapter running as a TCP server. */
export class SocketTransport extends StreamTransport {
  private socket?: net.Socket;

  constructor(private readonly options: SocketTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    const { port, host = "127.0.0.1" } = this.options;
    this.socket = await connect(
      () => net.createConnection({ port, host }),
      (e) => this.fireClose(e),
    );
    this.attach(this.socket, this.socket);
  }

  protected async teardown(): Promise<void> {
    this.socket?.end();
    this.socket = undefined;
  }
}

/** Connects to a debug adapter over a named pipe / UNIX domain socket. */
export class PipeTransport extends StreamTransport {
  private socket?: net.Socket;

  constructor(private readonly options: PipeTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    this.socket = await connect(
      () => net.createConnection({ path: this.options.path }),
      (e) => this.fireClose(e),
    );
    this.attach(this.socket, this.socket);
  }

  protected async teardown(): Promise<void> {
    this.socket?.end();
    this.socket = undefined;
  }
}

function connect(factory: () => net.Socket, onClose: (event: { requested: boolean }) => void): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = factory();
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      resolve(socket);
    });
    socket.on("close", () => {
      if (connected) {
        onClose({ requested: false });
      }
    });
    socket.once("error", (err) => {
      if (!connected) {
        reject(err);
      }
    });
  });
}
