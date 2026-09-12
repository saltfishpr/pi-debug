import { createServer } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { SpawnedServerTransport, TcpTransport } from "../dap/index.js";
import type { DebugAdapterProvider } from "./provider.js";

const goConfigurationSchema = z
  .object({
    type: z.literal("go"),
    request: z.enum(["launch", "attach"]),
    program: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(), // cwd 指定 debuggee 的工作目录
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
    const mode = config.mode ?? (configuration.request === "launch" ? "debug" : "local");
    if (configuration.request === "launch") {
      if (!["debug", "test", "exec"].includes(mode)) throw new Error(`Unsupported Go launch mode '${mode}'.`);
      if (!config.program) throw new Error("Go launch requires program.");
    } else {
      if (!["local", "remote"].includes(mode)) throw new Error(`Unsupported Go attach mode '${mode}'.`);
      if (mode === "local" && !config.processId) throw new Error("Go local attach requires a numeric processId.");
      if (mode === "remote" && !config.port)
        throw new Error("Go remote attach requires host/port of a Delve headless server.");
    }
    const { cwd: configuredCwd, host, port, ...dap } = config;
    if (port !== undefined) {
      // Paths belong to the external server and must not be resolved against the local workspace.
      return { adapterID: "go", transport: new TcpTransport({ host, port }), configuration: { ...dap, mode } };
    }
    if (host !== "127.0.0.1") throw new Error("Go host requires port of an existing Delve server.");
    // launch.json 的 cwd 支持相对路径，此时以传入的 workspaceFolder 为基准解析
    const cwd = resolve(workspaceFolder, configuredCwd ?? ".");
    const localPort = await pickFreePort();
    return {
      adapterID: "go",
      transport: new SpawnedServerTransport({
        command: "dlv",
        args: ["dap", `--listen=127.0.0.1:${localPort}`],
        cwd,
        host,
        port: localPort,
      }),
      configuration: {
        ...dap,
        mode,
        cwd,
        ...(config.program ? { program: resolve(cwd, config.program) } : {}),
      },
    };
  },
};

// SpawnedServerTransport needs a concrete port before it starts Delve.
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
