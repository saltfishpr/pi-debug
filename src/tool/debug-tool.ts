import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugSessionManager } from "../debug/session-manager";
import { debugParameters } from "./schema";

export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Drive a debug session against the target program: install breakpoints, control execution, and inspect stopped state.",
      "Only one session exists at a time; `start` fails while a session is active, so call `stop` first even after the program has exited. Sessions do not survive reloads or Pi session changes.",
      "The session is `stopped` when at least one thread is stopped; other threads may still be running. Inspection, stepping, and `evaluate` require the target thread to be stopped, while `pause` targets a running thread.",
      "Execution actions and `start` return as soon as the request is acknowledged and may leave the program running; use `wait` to await the next stop or exit, and `status` to poll current state without blocking.",
      "`stop` terminates launched programs and detaches from attached ones.",
    ].join(" "),
    promptSnippet: "Inspect runtime state and trace execution to diagnose application behavior",
    promptGuidelines: [
      "Before calling debug, read the relevant source and form a hypothesis; pick breakpoints that will distinguish likely causes and pass them to `start` so the program stops where evidence is useful.",
      "When debug reports a stop, call `inspect` once to orient yourself, then request only the specific frames, variables, or expressions that test the hypothesis. Prefer moving breakpoints over repeatedly stepping through loops.",
      "For concurrent programs, list threads with debug `threads`, pass an explicit threadId to inspection and control actions, and paginate large results with `nextStart`. After a control action, check `waitOutcome` because a timeout does not imply the program stopped.",
      "Treat debug `evaluate` as running code in the target process: expressions can invoke functions and mutate state. Restrict to read-only expressions unless the side effect is intended.",
      "Call debug `stop` when finished so the session and its resources are released and the next `start` can proceed.",
    ],
    parameters: debugParameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await manager.execute(args, ctx.cwd, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
