import type { AdapterConfig } from "../config";
import type { AdapterDefinition } from "../dap/transport";
import { getString } from "./util";

/** Create the DAP adapter for a Node.js debug configuration. */
export function createNodeAdapter(adapterConfig: AdapterConfig | undefined): AdapterDefinition {
  return {
    type: "executable",
    command: getString(adapterConfig, "node") ?? "js-debug-adapter",
    args: adapterConfig?.args ?? [],
  };
}
