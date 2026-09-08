import type { AdapterConfig } from "../config";
import type { AdapterDefinition } from "../dap/transport";
import { getString } from "./util";

/** Create the DAP adapter for a Python debug configuration. */
export function createPythonAdapter(adapterConfig: AdapterConfig | undefined): AdapterDefinition {
  return {
    type: "executable",
    command: getString(adapterConfig, "python") ?? "python3",
    args: adapterConfig?.args ?? ["-m", "debugpy.adapter"],
  };
}
