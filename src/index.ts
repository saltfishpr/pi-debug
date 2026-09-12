import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DebugSessionManager } from "./debug/session-manager.js";
import { registerDebugTool } from "./tool/debug-tool.js";

/** Register the debugger tool and clean up its adapter when Pi ends the session. */
export default function (pi: ExtensionAPI): void {
  const manager = new DebugSessionManager();
  registerDebugTool(pi, manager);
  pi.on("session_shutdown", async () => {
    await manager.close();
  });
}
