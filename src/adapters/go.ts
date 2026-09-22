import { createServer } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { SocketDebugAdapter, SpawnedServerDebugAdapter } from "../dap";
import type { DebugAdapterProvider } from "./index.js";

const goConfigurationSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("go"),
    request: z.enum(["launch", "attach"]),
    program: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(), // 指定 debuggee 的工作目录
    mode: z.string().optional(),
    processId: z.number().int().positive().optional(),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).optional(),
    debugAdapter: z.literal("dlv-dap").optional(),
    console: z.literal("internalConsole").optional(),
    stopOnEntry: z.boolean().default(true),
  })
  .loose();

/** Delve DAP provider for Go programs, tests, binaries and existing processes. */
export const goProvider: DebugAdapterProvider = {
  types: ["go"],
  async resolve(configuration, workspaceFolder) {
    const config = goConfigurationSchema.parse(configuration);
    const mode = config.mode ?? (config.request === "launch" ? "debug" : "local");

    if (config.request === "launch") {
      if (!isGoLaunchMode(mode)) throw new Error(`Unsupported Go launch mode '${mode}'.`);
      if (!config.program) throw new Error("Go launch requires program.");
    } else {
      if (!isGoAttachMode(mode)) throw new Error(`Unsupported Go attach mode '${mode}'.`);
      if (mode === "local" && !config.processId) throw new Error("Go local attach requires a numeric processId.");
      if (mode === "remote" && !config.port)
        throw new Error("Go remote attach requires host/port of a Delve headless server.");
    }

    if (config.port !== undefined) {
      return {
        adapter: new SocketDebugAdapter({ host: config.host, port: config.port }),
        configuration: config,
      };
    }
    if (config.host !== "127.0.0.1") throw new Error("Go host requires port of an existing Delve server.");

    const cwd = resolve(workspaceFolder, config.cwd ?? ".");
    const port = await pickFreePort();
    return {
      adapter: new SpawnedServerDebugAdapter({
        command: "dlv",
        args: ["dap", `--listen=127.0.0.1:${port}`],
        cwd,
        port,
      }),
      configuration: config,
    };
  },
};

function isGoLaunchMode(mode: string): boolean {
  return mode === "debug" || mode === "test" || mode === "exec";
}

function isGoAttachMode(mode: string): boolean {
  return mode === "local" || mode === "remote";
}

/** Find an available port for the Delve server before it starts. */
async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === "string") throw new Error("Failed to allocate a Delve DAP port.");
  return address.port;
}
