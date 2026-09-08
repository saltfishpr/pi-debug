import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoAdapterFactory, createNodeAdapterFactory, createPythonAdapterFactory, nodeRunInTerminal } from "./adapters.js";
import { type AdapterConfig, loadExtensionConfig } from "./config.js";
import type { Disposable } from "./dap/index.js";
import { loadDebugConfigurations } from "./launchConfig.js";
import { type DebugAdapterFactory, SessionManager } from "./session/index.js";
import { DEBUG_TOOL_NAME, registerDebugTool } from "./tool.js";

/** Built-in DAP factory registry keyed by launch-configuration `type`. */
const ADAPTER_FACTORIES: Record<string, (config?: AdapterConfig) => DebugAdapterFactory> = {
  go: createGoAdapterFactory,
  node: createNodeAdapterFactory,
  python: createPythonAdapterFactory,
};

/**
 * pi-debug — lets the Pi Agent debug programs over the VS Code Debug Adapter
 * Protocol (DAP). Registers a single `debug` tool with action-based dispatch.
 */
export default function (pi: ExtensionAPI): void {
  const manager = new SessionManager({
    defaultWaitTimeoutMs: 30_000,
    maxSessions: 8,
    runInTerminal: nodeRunInTerminal,
  });
  registerDebugTool(pi, manager);

  let disposes: Disposable[] = [];

  pi.on("session_start", async (_event, ctx) => {
    const [config, configurations] = await Promise.all([loadExtensionConfig(ctx.cwd), loadDebugConfigurations(ctx.cwd)]);

    for (const d of disposes) d.dispose();
    disposes = Object.entries(ADAPTER_FACTORIES).map(([type, create]) => manager.registerAdapter(type, create(config.adapters[type])));

    registerDebugTool(pi, manager, configurations);

    const activeTools = pi.getActiveTools();
    if (configurations.length > 0) {
      if (!activeTools.includes(DEBUG_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, DEBUG_TOOL_NAME]);
      }
    } else {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== DEBUG_TOOL_NAME));
    }
  });

  pi.on("session_shutdown", () => {
    for (const d of disposes) d.dispose();
    disposes = [];
    void manager.disposeAll();
  });
}
