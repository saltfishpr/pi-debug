import type { AdapterConfig } from "../config";
import type { DebugConfiguration } from "../dap";

/** Returns a string-valued adapter configuration field, if present. */
export function getString(config: DebugConfiguration, field: string): string | undefined;
export function getString(config: AdapterConfig | undefined, field: string): string | undefined;
export function getString(config: AdapterConfig | DebugConfiguration | undefined, field: string): string | undefined {
  const value = config?.[field];
  return typeof value === "string" ? value : undefined;
}
