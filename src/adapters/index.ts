/** Debug adapter providers and lookup by launch configuration type. */
import { goProvider } from "./go.js";
import type { DebugAdapterProvider } from "./provider.js";
import { pythonProvider } from "./python.js";

export type { DebugAdapterProvider, ResolvedDebugLaunch } from "./provider.js";
export { goProvider, pythonProvider };

/** Return the provider for a supported launch.json type, or reject unsupported debuggers. */
export function getDebugAdapterProvider(type: string): DebugAdapterProvider {
  const provider = [pythonProvider, goProvider].find((provider) => provider.types.includes(type));
  if (!provider) throw new Error(`Unsupported debug adapter type '${type}'. Supported types: debugpy, python, go.`);
  return provider;
}
