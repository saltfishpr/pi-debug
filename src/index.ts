import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DefaultAdapterFactory } from "./adapters";
import { loadExtensionConfig, type ExtensionConfig } from "./config";
import { PiDebugSessionManager } from "./manager";
import { registerDebugTool } from "./tool";

/**
 * pi-debug — lets the Pi Agent debug programs over the VS Code Debug Adapter
 * Protocol (DAP). Registers a single `debug` tool with action-based dispatch.
 */
export default function (pi: ExtensionAPI): void {
  const adapterFactory = new DefaultAdapterFactory();
  const manager = new PiDebugSessionManager({ adapterFactory: adapterFactory.create });
  registerDebugTool(pi, manager);

  pi.on("session_start", async (_event, ctx) => {
    let config: ExtensionConfig;
    try {
      config = await loadExtensionConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[pi-debug]: ${message}`, "warning");
      return;
    }

    adapterFactory.setAdapterConfigs(config.adapters);

    try {
      await manager.loadConfigurations(ctx.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[pi-debug]: ${message}`, "warning");
    }
    registerDebugTool(pi, manager);

    const activeTools = pi.getActiveTools();
    if (manager.configurationNames.length > 0) {
      if (!activeTools.includes("debug")) {
        pi.setActiveTools([...activeTools, "debug"]);
      }
    } else {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "debug"));
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.disposeAll();
  });
}
