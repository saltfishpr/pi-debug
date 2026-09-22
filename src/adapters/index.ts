/** Debug adapter providers and lookup by launch configuration type. */
import type { DebugConfiguration } from "../config/launch-config.js";
import type { DebugAdapter } from "../dap";
import { goProvider } from "./go.js";
import { pythonProvider } from "./python.js";
export { goProvider, pythonProvider };

/** A transport and the normalized configuration to send when starting it. */
export interface ResolvedDebugAdapter {
  adapter: DebugAdapter;
  configuration: DebugConfiguration;
}

/** Resolve one debugger's configuration without starting its processes. */
export interface DebugAdapterProvider {
  types: readonly string[];
  /** Validate and normalize the configuration and create an unstarted transport. */
  resolve(configuration: DebugConfiguration, workspaceFolder: string): Promise<ResolvedDebugAdapter>;
}

/** Return the provider for a supported launch.json type, or reject unsupported debuggers. */
export function getDebugAdapterProvider(type: string): DebugAdapterProvider {
  const provider = [goProvider].find((provider) => provider.types.includes(type));
  if (!provider) throw new Error(`Unsupported debug adapter type '${type}'. Supported types: go.`);
  return provider;
}
