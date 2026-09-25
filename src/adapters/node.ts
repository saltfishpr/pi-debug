import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { pickFreePort } from "../common/port.js";
import type { DebugConfiguration } from "../config/launch-config.js";
import { SocketDebugAdapter, SpawnedServerDebugAdapter } from "../dap";
import type { DebugAdapterProvider, ResolvedDebugAdapter } from "./index.js";

const nodeConfigurationSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["node", "pwa-node"]),
    request: z.enum(["launch", "attach"]),
    program: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    processId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    /** Connect to an already running js-debug DAP server instead of spawning one. */
    debugServer: z.number().int().min(1).max(65535).optional(),
    /** Path to an alternative `dapDebugServer.js`; resolved against the workspace folder. */
    debugAdapterExecutable: z.string().min(1).optional(),
  })
  .loose();

/** vscode-js-debug provider for Node.js. Spawns `dapDebugServer.js` unless `debugServer` is set. */
export const nodeProvider: DebugAdapterProvider = {
  types: ["node", "pwa-node"],
  async resolve(configuration, workspaceFolder) {
    const config = nodeConfigurationSchema.parse(configuration);

    if (config.request === "launch") {
      if (!config.program) throw new Error("Node launch requires 'program'.");
    } else if (config.port === undefined && config.processId === undefined) {
      throw new Error("Node attach requires 'port' or 'processId'.");
    }

    if (config.debugServer !== undefined) {
      return socketResolution(config, config.debugServer);
    }

    const cwd = resolve(workspaceFolder, config.cwd ?? ".");
    const port = await pickFreePort();
    const dapServer = await locateDapDebugServer(config.debugAdapterExecutable, workspaceFolder);
    return {
      adapter: new SpawnedServerDebugAdapter({
        command: process.execPath,
        args: [dapServer, String(port), "127.0.0.1"],
        cwd,
        port,
      }),
      configuration: config,
      resolveChild: (configuration) => resolveChild(configuration, port),
    };
  },
};

function resolveChild(configuration: DebugConfiguration, port: number): Promise<ResolvedDebugAdapter> {
  const config = nodeConfigurationSchema.parse(configuration);
  return Promise.resolve(socketResolution(config, port));
}

function socketResolution(configuration: DebugConfiguration, port: number): ResolvedDebugAdapter {
  return {
    adapter: new SocketDebugAdapter({ port }),
    configuration,
    resolveChild: (child) => resolveChild(child, port),
  };
}

/** Locate the `dapDebugServer.js` shipped by vscode-js-debug. */
async function locateDapDebugServer(override: string | undefined, workspaceFolder: string): Promise<string> {
  if (override) return resolve(workspaceFolder, override);
  const envPath = process.env.JS_DEBUG_DAP_SERVER;
  if (envPath) return resolve(workspaceFolder, envPath);

  const candidates = [
    resolve(workspaceFolder, "node_modules", "@vscode", "js-debug", "src", "dapDebugServer.js"),
    resolve(workspaceFolder, "node_modules", "js-debug", "src", "dapDebugServer.js"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error(
    "Cannot locate vscode-js-debug 'dapDebugServer.js'. Set 'debugAdapterExecutable' in the configuration, " +
      "install '@vscode/js-debug' in the workspace, or set the JS_DEBUG_DAP_SERVER environment variable.",
  );
}
