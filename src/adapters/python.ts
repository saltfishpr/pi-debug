import { resolve } from "node:path";
import { z } from "zod";
import { ExecutableDebugAdapter } from "../dap";
import type { DebugAdapterProvider } from "./index.js";

const pythonConfigurationSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["debugpy", "python"]),
    request: z.enum(["launch", "attach"]),
    program: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    processId: z.number().int().positive().optional(),
    connect: z
      .object({ port: z.number().int().min(1).max(65535) })
      .loose()
      .optional(),
    listen: z
      .object({ port: z.number().int().min(1).max(65535) })
      .loose()
      .optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    python: z.string().min(1).optional(),
    pythonArgs: z.array(z.string()).optional(),
  })
  .loose();

/** debugpy provider for CPython. The adapter is `python -m debugpy.adapter` over stdio. */
export const pythonProvider: DebugAdapterProvider = {
  types: ["debugpy", "python"],
  async resolve(configuration, workspaceFolder) {
    const config = pythonConfigurationSchema.parse(configuration);

    if (config.request === "launch") {
      const targets = [config.program, config.module, config.code].filter((value) => value !== undefined).length;
      if (targets !== 1) throw new Error("Python launch requires exactly one of 'program', 'module' or 'code'.");
    } else {
      const hasSocket = config.connect !== undefined || config.listen !== undefined || config.port !== undefined;
      const hasProcess = config.processId !== undefined;
      if (!hasSocket && !hasProcess)
        throw new Error("Python attach requires 'connect', 'listen', 'port' or 'processId'.");
    }

    const command = config.python ?? defaultPythonCommand();
    const args = [...(config.pythonArgs ?? []), "-m", "debugpy.adapter"];
    const cwd = resolve(workspaceFolder, config.cwd ?? ".");
    return {
      adapter: new ExecutableDebugAdapter({ command, args, cwd }),
      configuration: config,
    };
  },
};

function defaultPythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}
