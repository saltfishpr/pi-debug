/** Debug adapter providers and lookup by launch configuration type. */
import type { DebugConfiguration } from "../config/launch-config.js";
import type { DebugAdapter } from "../dap";
import { goProvider } from "./go.js";
import { nodeProvider } from "./node.js";
import { pythonProvider } from "./python.js";

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
  const providers = [goProvider, pythonProvider, nodeProvider];
  const provider = providers.find((provider) => provider.types.includes(type));
  if (!provider) {
    const supported = providers.flatMap((provider) => provider.types).join(", ");
    throw new Error(`Unsupported debug adapter type '${type}'. Supported types: ${supported}.`);
  }
  return provider;
}
