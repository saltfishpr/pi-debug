import type { DebugProtocol } from "@vscode/debugprotocol";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { platform } from "node:os";
import type { Readable, Writable } from "node:stream";
import { killProcessTree } from "../common/process.js";
import { AbstractDebugAdapter } from "./abstract-debug-adapter.js";

/** DAP adapter process launch configuration. */
export interface ProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
}

/** TCP endpoint for a debug adapter server. */
export interface SocketOptions {
  port: number;
  host?: string;
}

/** Named pipe or Unix domain socket endpoint for a debug adapter server. */
export interface NamedPipeOptions {
  path: string;
}

/** Configuration for a locally spawned TCP debug adapter server. */
export interface SpawnedServerOptions extends ProcessOptions, SocketOptions {
  /** Delay between connect attempts while the server is still starting. */
  retryIntervalMs?: number;
}

export abstract class StreamDebugAdapter extends AbstractDebugAdapter {
  private static readonly headerSeparator = "\r\n\r\n";

  private output: Writable | undefined;
  private rawData = Buffer.alloc(0);
  private contentLength = -1;

  protected connect(input: Readable, output: Writable): void {
    this.output = output;
    this.rawData = Buffer.alloc(0);
    this.contentLength = -1;
    input.on("data", (data: Buffer) => this.handleData(data));
  }

  protected disconnect(output: Writable): void {
    if (this.output !== output) return;
    this.output = undefined;
    this.rawData = Buffer.alloc(0);
    this.contentLength = -1;
  }

  sendMessage(message: DebugProtocol.ProtocolMessage): void {
    if (!this.output) return;
    const content = JSON.stringify(message);
    this.output.write(`Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n${content}`, "utf8");
  }

  private handleData(data: Buffer): void {
    this.rawData = Buffer.concat([this.rawData, data]);

    while (true) {
      if (this.contentLength >= 0) {
        if (this.rawData.length < this.contentLength) return;
        const content = this.rawData.toString("utf8", 0, this.contentLength);
        this.rawData = this.rawData.subarray(this.contentLength);
        this.contentLength = -1;
        if (!content) continue;
        try {
          this.acceptMessage(JSON.parse(content) as DebugProtocol.ProtocolMessage);
        } catch (error) {
          this._onError.fire(new Error(`${error instanceof Error ? error.message : String(error)}\n${content}`));
        }
        continue;
      }

      const headerEnd = this.rawData.indexOf(StreamDebugAdapter.headerSeparator);
      if (headerEnd < 0) return;
      const header = this.rawData.toString("utf8", 0, headerEnd);
      this.rawData = this.rawData.subarray(headerEnd + StreamDebugAdapter.headerSeparator.length);
      const value = header
        .split(/\r?\n/)
        .map((line) => line.match(/^Content-Length\s*:\s*(.+)$/i)?.[1])
        .find((length): length is string => length !== undefined);
      const length = value === undefined ? NaN : Number(value);
      if (!Number.isSafeInteger(length) || length < 0) {
        this._onError.fire(new Error(`Invalid DAP Content-Length header: ${header}`));
        continue;
      }
      this.contentLength = length;
    }
  }
}

/** A debug adapter launched as a child process and driven over stdin/stdout. */
export class ExecutableDebugAdapter extends StreamDebugAdapter {
  private process: ChildProcess | undefined;
  private processOutput: Writable | undefined;

  constructor(private readonly options: ProcessOptions) {
    super();
  }

  async startSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const child = launchProcess(this.options);
    this.process = child;
    try {
      const streams = getAdapterStreams(child);
      await waitForSpawn(child, signal);
      signal?.throwIfAborted();
      child.on("error", (error) => this._onError.fire(error));
      child.on("exit", (code) => this._onExit.fire(code));
      for (const stream of [streams.input, streams.output, streams.error])
        stream.on("error", (error) => this._onError.fire(error));
      streams.error.resume();
      this.processOutput = streams.output;
      this.connect(streams.input, streams.output);
    } catch (error) {
      this.process = undefined;
      this.processOutput = undefined;
      await stopProcess(child, this.options.shutdownTimeoutMs);
      throw error;
    }
  }

  async stopSession(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    const output = this.processOutput;
    this.processOutput = undefined;
    await this.cancelPendingRequests();
    if (output) this.disconnect(output);
    await stopProcess(child, this.options.shutdownTimeoutMs);
  }
}

/** Base for adapters reached over a socket rather than a child process's stdio. */
export abstract class NetworkDebugAdapter extends StreamDebugAdapter {
  private socket: Socket | undefined;

  /** Opens the socket used for DAP traffic. The 'connect' event is handled here. */
  protected abstract createConnection(): Socket;

  startSession(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const socket = this.createConnection();
      this.socket = socket;
      let connected = false;

      const onAbort = (): void => {
        cleanup();
        if (this.socket === socket) this.socket = undefined;
        socket.destroy();
        reject(signal?.reason);
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });

      socket.on("connect", () => {
        if (this.socket !== socket) return;
        cleanup();
        this.connect(socket, socket);
        connected = true;
        resolve();
      });

      socket.on("error", (error: Error) => {
        if (this.socket !== socket) return;
        cleanup();
        if (connected) {
          this._onError.fire(error);
        } else {
          this.socket = undefined;
          socket.destroy();
          reject(error);
        }
      });

      socket.on("close", () => {
        if (this.socket !== socket) return;
        cleanup();
        this.socket = undefined;
        if (connected) this._onError.fire(new Error("Debug adapter connection closed."));
        else reject(new Error("Debug adapter connection closed before it was established."));
      });
    });
  }

  async stopSession(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    await this.cancelPendingRequests();
    this.disconnect(socket);
    socket.end();
  }
}

/** A debug adapter connected to an already listening TCP server. */
export class SocketDebugAdapter extends NetworkDebugAdapter {
  constructor(private readonly options: SocketOptions) {
    super();
  }

  protected createConnection(): Socket {
    return createConnection({ host: this.options.host ?? "127.0.0.1", port: this.options.port });
  }
}

/** A debug adapter connected through a named pipe or Unix domain socket. */
export class NamedPipeDebugAdapter extends NetworkDebugAdapter {
  constructor(private readonly options: NamedPipeOptions) {
    super();
  }

  protected createConnection(): Socket {
    return createConnection(this.options.path);
  }
}

/** A locally spawned TCP adapter server with retrying connection setup. */
export class SpawnedServerDebugAdapter extends NetworkDebugAdapter {
  private process: ChildProcess | undefined;

  constructor(private readonly options: SpawnedServerOptions) {
    super();
  }

  protected createConnection(): Socket {
    return createConnection({ host: this.options.host ?? "127.0.0.1", port: this.options.port });
  }

  async startSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const child = launchProcess(this.options);
    this.process = child;
    try {
      await waitForSpawn(child, signal);
      signal?.throwIfAborted();
      child.on("error", (error) => this._onError.fire(error));
      child.on("exit", (code) => this._onExit.fire(code));
      child.stderr?.on("error", (error) => this._onError.fire(error));
      child.stderr?.resume();
      await this.connectToServer(child, signal);
    } catch (error) {
      this.process = undefined;
      await stopProcess(child, this.options.shutdownTimeoutMs);
      throw error;
    }
  }

  async stopSession(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    await super.stopSession();
    await stopProcess(child, this.options.shutdownTimeoutMs);
  }

  /** Retries until the spawned server accepts a connection, exits or the signal aborts. */
  private async connectToServer(child: ChildProcess, signal?: AbortSignal): Promise<void> {
    const endpoint = `${this.options.host ?? "127.0.0.1"}:${this.options.port}`;
    const interval = this.options.retryIntervalMs ?? 50;

    while (true) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Debug adapter exited before accepting a connection on ${endpoint}.`);
      try {
        await super.startSession(signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ECONNREFUSED") throw error;
      }
      await delay(interval);
    }
  }
}

const windowsBatchUnquotedCharacters = "#$*+-./:?@\\\\_";
const windowsBatchInvalidCharacters = /[\0\r\n]/;
const windowsBatchControlCharacter = /\p{Cc}/u;

/** Builds an injection-safe cmd.exe invocation for a Windows batch adapter. */
export function prepareWindowsBatchCommand(command: string, args: readonly string[]): string[] {
  if (
    command.includes('"') ||
    windowsBatchInvalidCharacters.test(command) ||
    args.some((arg) => windowsBatchInvalidCharacters.test(arg))
  ) {
    throw new Error("Debug adapter commands and arguments contain invalid characters.");
  }
  const shellCommand = [
    escapeWindowsBatchArgument(command, true),
    ...args.map((arg) => escapeWindowsBatchArgument(arg)),
  ].join(" ");
  return ["/e:ON", "/v:OFF", "/d", "/c", `"${shellCommand}"`];
}

function escapeWindowsBatchArgument(argument: string, forceQuotes = false): string {
  const quote = forceQuotes || windowsBatchArgumentNeedsQuotes(argument);
  let result = quote ? '"' : "";
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") backslashes++;
    else {
      if (character === '"') result += "\\".repeat(backslashes);
      else if (character === "%") result += "%%cd:~,";
      backslashes = 0;
    }
    result += character;
  }
  if (quote) result += "\\".repeat(backslashes) + '"';
  return result;
}

function windowsBatchArgumentNeedsQuotes(argument: string): boolean {
  if (!argument || argument.endsWith("\\")) return true;
  for (const character of argument) {
    const codePoint = character.codePointAt(0)!;
    const isAsciiAlphanumeric =
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a);
    if (
      (codePoint <= 0x7f && !isAsciiAlphanumeric && !windowsBatchUnquotedCharacters.includes(character)) ||
      windowsBatchControlCharacter.test(character)
    )
      return true;
  }
  return false;
}

function launchProcess(options: ProcessOptions): ChildProcess {
  if (!options.command) throw new Error("Cannot determine debug adapter executable.");
  const args = options.args ?? [];
  const env = options.env ? { ...process.env, ...options.env } : process.env;

  let command = options.command;
  let spawnArgs = args;
  const spawnOptions: SpawnOptions = { cwd: options.cwd, env };
  if (platform() === "win32" && /\.(bat|cmd)$/i.test(command)) {
    spawnOptions.windowsVerbatimArguments = true;
    spawnArgs = prepareWindowsBatchCommand(command, args);
    command = process.env.ComSpec || "cmd.exe";
  }
  return spawn(command, spawnArgs, spawnOptions);
}

/** Resolves once the child process has spawned, or rejects on spawn failure or abort. */
function waitForSpawn(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getAdapterStreams(child: ChildProcess): { input: Readable; output: Writable; error: Readable } {
  if (!child.stdout || !child.stdin || !child.stderr)
    throw new Error("Debug adapter process does not expose stdio streams.");
  return { input: child.stdout, output: child.stdin, error: child.stderr };
}

async function stopProcess(child: ChildProcess | undefined, timeoutMs = 1_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await killProcessTree(child.pid, "SIGTERM");
  await Promise.race([exited, delay(timeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    await killProcessTree(child.pid, "SIGKILL");
    await exited;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
