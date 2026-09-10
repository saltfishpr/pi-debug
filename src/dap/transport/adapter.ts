import type { DebugConfiguration } from "../session/types";
import type { Logger } from "../util/logger";
import { ServerExecutableTransport } from "./serverExecutableTransport";
import { StdioTransport } from "./stdioTransport";
import { TcpTransport } from "./tcpTransport";
import type { Transport } from "./transport";

/**
 * A debug adapter launched as a child process communicating over stdio.
 * Equivalent to nvim-dap's `executable` adapter.
 */
export interface ExecutableAdapter {
  type: "executable";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A debug adapter reachable over TCP. Equivalent to nvim-dap's `server`
 * adapter. If `executable` is provided, the client spawns that process first
 * and then connects (a "server-executable"); `port` may be the literal
 * `'${port}'` to auto-allocate a free port and inject it into the args.
 */
export interface ServerAdapter {
  type: "server";
  host?: string;
  port: number | "${port}";
  executable?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  /** Connection tuning for the direct-server (no executable) case. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Milliseconds to wait for a spawned server to accept connections. */
  connectTimeoutMs?: number;
}

/** Union of all supported adapter definitions. */
export type AdapterDefinition = ExecutableAdapter | ServerAdapter;

/**
 * A factory that resolves an {@link AdapterDefinition} lazily, given the debug
 * configuration. Useful when the adapter location depends on the configuration
 * (e.g. picking a port or binary per request/attach).
 */
export type AdapterFactory = (config: DebugConfiguration) => AdapterDefinition | Promise<AdapterDefinition>;

/** Either a static adapter definition or a factory that produces one. */
export type AdapterProvider = AdapterDefinition | AdapterFactory;

export async function resolveAdapter(provider: AdapterProvider, config: DebugConfiguration): Promise<AdapterDefinition> {
  return typeof provider === "function" ? provider(config) : provider;
}

/** Build the appropriate {@link Transport} for an adapter definition. */
export function createTransport(adapter: AdapterDefinition, logger?: Logger): Transport {
  switch (adapter.type) {
    case "executable":
      return new StdioTransport({
        command: adapter.command,
        args: adapter.args,
        cwd: adapter.cwd,
        env: adapter.env,
        logger,
      });
    case "server":
      if (adapter.executable) {
        return new ServerExecutableTransport({
          command: adapter.executable.command,
          args: adapter.executable.args,
          cwd: adapter.executable.cwd,
          env: adapter.executable.env,
          host: adapter.host,
          port: adapter.port,
          connectTimeoutMs: adapter.connectTimeoutMs,
          logger,
        });
      }
      if (adapter.port === "${port}") {
        throw new Error("Adapter port '${port}' requires an 'executable' to launch the server");
      }
      return new TcpTransport({
        host: adapter.host,
        port: adapter.port,
        maxAttempts: adapter.maxRetries,
        retryDelayMs: adapter.retryDelayMs,
        logger,
      });
    default: {
      const exhaustive: never = adapter;
      throw new Error(`Unknown adapter type: ${JSON.stringify(exhaustive)}`);
    }
  }
}
