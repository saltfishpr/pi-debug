import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugSessionManager } from "../debug/session-manager";
import { debugParameters } from "./schema";

export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Debug applications with breakpoints, stepping, and runtime inspection.",
      "`configurations` lists project debug configurations; `start` launches or attaches using a configuration name or inline configuration.",
      "Launch pauses on entry by default.",
      "`set_breakpoints` replaces all breakpoints in a file; an empty lines array clears them.",
      "`inspect` returns the call stack and variables for the selected frame.",
      "Runtime inspection requires a stopped program.",
      "Execution actions may return while the program is still running; use `wait` to await a stop or `status` to check current state.",
      "`stop` terminates launched programs and detaches from attached programs.",
      "Only one debug session can exist at a time; call `stop` before starting another, even after the program exits.",
      "Debug sessions do not survive reloads or Pi session changes.",
    ].join(" "),
    promptSnippet: "Inspect runtime state and trace execution to diagnose application behavior",
    promptGuidelines: [
      "Use debug when runtime evidence is needed to test a hypothesis about application behavior. Read the relevant source first and choose breakpoints that distinguish likely causes; include initial breakpoints in `start`.",
      "When debug reports a stop, use `inspect` to orient yourself, then request only the frames, variables, or expressions needed to test the hypothesis. Prefer targeted breakpoints over repeated stepping through loops.",
      "Treat debug `evaluate` as code execution: expressions may call functions or mutate program state. Prefer read-only expressions unless side effects are intentional.",
      "Call debug `stop` when the investigation is complete to release the session and its resources.",
    ],
    parameters: debugParameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await manager.execute(args, ctx.cwd, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
