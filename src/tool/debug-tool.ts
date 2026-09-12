import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugSessionManager } from "../debug/session-manager";
import { debugParameters } from "./schema";

export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description:
      "Debug Go programs with Delve over DAP; dlv must be on PATH. Python is not implemented. configurations lists project launch.json entries; start accepts a name or inline Go configuration. Include breakpoints in start before execution. Launch pauses on entry by default. set_breakpoints replaces all breakpoints in one file. inspect returns stack and locals. frame is a zero-based index, not a DAP ID. Execution actions wait up to waitMs then return current state; use wait/status if still running. stop terminates launched programs and detaches attached programs. One session at a time; use stop before starting another.",
    promptSnippet: "Debug Go programs using breakpoints, runtime inspection, and stepping",
    promptGuidelines: [
      "Use debug to inspect runtime state instead of guessing; read source and set focused breakpoints before running.",
      "After debug reports a stop, use inspect before stepping. Avoid repeatedly stepping through large loops.",
      "Use debug evaluate only for focused expressions; evaluation can have side effects even in watch context.",
      "Use debug stop when investigation is complete. Debug sessions are not restored after reload or session changes.",
    ],
    parameters: debugParameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await manager.execute(args, ctx.cwd, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
