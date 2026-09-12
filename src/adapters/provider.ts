import type { DebugConfiguration } from "../config/launch-config.js";
import type { DapTransport } from "../dap/index.js";

/** Provider output consumed by the language-independent session manager. */
export interface ResolvedDebugLaunch {
  adapterID: string;
  transport: DapTransport;
  configuration: Record<string, unknown>; // adapter-specific configuration
}

/** Resolve one debugger's configuration without starting its processes. */
export interface DebugAdapterProvider {
  types: readonly string[];
  resolve(configuration: DebugConfiguration, workspaceFolder: string): Promise<ResolvedDebugLaunch>;
}
