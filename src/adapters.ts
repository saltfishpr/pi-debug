import { spawn } from "node:child_process";
import type { AdapterConfig } from "./config.js";
import type { ReverseRequestHandler } from "./dap/index.js";
import { SocketTransport, StdioTransport } from "./dap/transport/node/index.js";
import type { DebugConfiguration } from "./launchConfig.js";
import type { DebugAdapterFactory } from "./session/index.js";

interface RunInTerminalArgs {
  cwd?: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Fulfil the adapter's `runInTerminal` reverse request by spawning the process
 * directly. Core never touches the terminal; this host-side handler does.
 */
export const nodeRunInTerminal: ReverseRequestHandler = (raw) => {
  const args = raw as RunInTerminalArgs;
  const [command, ...rest] = args.args;
  if (!command) {
    throw new Error("runInTerminal requested with an empty command");
  }
  const child = spawn(command, rest, {
    cwd: args.cwd,
    env: { ...process.env, ...args.env },
    stdio: "inherit",
  });
  return { processId: child.pid };
};

interface GoRemoteAttachConfiguration extends DebugConfiguration {
  mode?: string;
  host?: string;
  port?: number;
}

/**
 * Build a factory for Go debug sessions. Remote-attach configurations connect
 * to an already-running `dlv --headless` over TCP; everything else spawns
 * `dlv dap` locally. Adapter-invocation knobs come from `.pi/debug.json`;
 * program-level fields (cwd/env/args/port/host) belong to the launch config.
 */
export function createGoAdapterFactory(config?: AdapterConfig): DebugAdapterFactory {
  const command = config?.command ?? "dlv";
  const args = config?.args ?? ["dap"];

  return (configuration) => {
    const go = configuration as GoRemoteAttachConfiguration;
    if (go.request === "attach" && go.mode === "remote") {
      if (typeof go.port !== "number") {
        throw new Error(`Go remote attach requires 'port' in launch configuration '${go.name}'`);
      }
      return new SocketTransport({ port: go.port, host: go.host ?? "127.0.0.1" });
    }
    return new StdioTransport({ command, args });
  };
}

interface NodeAttachConfiguration extends DebugConfiguration {
  host?: string;
  port?: number;
}

/**
 * Build a factory for Node.js debug sessions. Attach configurations that carry
 * an explicit `port` connect to a running DAP server; everything else spawns
 * `js-debug-dap` locally (from `vscode-js-debug`).
 */
export function createNodeAdapterFactory(config?: AdapterConfig): DebugAdapterFactory {
  const command = config?.command ?? "js-debug-dap";
  const args = config?.args ?? [];

  return (configuration) => {
    const node = configuration as NodeAttachConfiguration;
    if (node.request === "attach" && typeof node.port === "number") {
      return new SocketTransport({ port: node.port, host: node.host ?? "127.0.0.1" });
    }
    return new StdioTransport({ command, args });
  };
}

interface PythonAttachConfiguration extends DebugConfiguration {
  connect?: { host?: string; port?: number };
  host?: string;
  port?: number;
}

/**
 * Build a factory for Python debug sessions. Attach configurations that specify
 * a connect target (either `connect: { host, port }` per debugpy convention, or
 * a top-level `port`) connect to the running debugpy server; everything else
 * spawns `python -m debugpy.adapter` locally.
 */
export function createPythonAdapterFactory(config?: AdapterConfig): DebugAdapterFactory {
  const command = config?.command ?? "python";
  const args = config?.args ?? ["-m", "debugpy.adapter"];

  return (configuration) => {
    const py = configuration as PythonAttachConfiguration;
    if (py.request === "attach") {
      const port = py.connect?.port ?? py.port;
      const host = py.connect?.host ?? py.host ?? "127.0.0.1";
      if (typeof port === "number") {
        return new SocketTransport({ port, host });
      }
    }
    return new StdioTransport({ command, args });
  };
}
