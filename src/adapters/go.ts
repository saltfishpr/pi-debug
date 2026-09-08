import type { AdapterConfig } from "../config";
import type { DebugConfiguration } from "../dap";
import type { AdapterDefinition } from "../dap/transport";
import { getString } from "./util";

/** Create the DAP adapter for a Go debug configuration. */
export function createGoAdapter(config: DebugConfiguration, adapterConfig?: AdapterConfig): AdapterDefinition {
  if (config.mode === "remote") {
    return {
      type: "server",
      host: requireString(config, "host"),
      port: requirePort(config, "port"),
    };
  }

  return {
    type: "executable",
    command: getString(adapterConfig, "dlv") ?? "dlv",
    args: adapterConfig?.args ?? ["dap"],
  };
}

function requireString(config: DebugConfiguration, field: string): string {
  const value = config[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Go remote configuration requires a non-empty '${field}' field.`);
  }
  return value;
}

function requirePort(config: DebugConfiguration, field: string): number {
  const value = config[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Go remote configuration requires '${field}' to be an integer between 1 and 65535.`);
  }
  return value;
}
