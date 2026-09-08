import type { AdapterConfig } from "../config";
import type { AdapterFactory } from "../dap";
import { createGoAdapter } from "./go";
import { createNodeAdapter } from "./node";
import { createPythonAdapter } from "./python";

/** Creates adapters for the built-in Go, Python, and Node.js debug configuration types. */
export class DefaultAdapterFactory {
  private adapterConfigs: Record<string, AdapterConfig> = {};

  readonly create: AdapterFactory = (config) => {
    switch (config.type) {
      case "go":
        return createGoAdapter(config, this.adapterConfigs.go);
      case "python":
        return createPythonAdapter(this.adapterConfigs.python);
      case "node":
        return createNodeAdapter(this.adapterConfigs.node);
      default:
        throw new Error(`Unsupported debug configuration type '${config.type}'. Supported types: go, python, node.`);
    }
  };

  setAdapterConfigs(adapterConfigs: Record<string, AdapterConfig>): void {
    this.adapterConfigs = adapterConfigs;
  }
}
