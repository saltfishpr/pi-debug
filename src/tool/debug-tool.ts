import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DebugError, throwIfAborted } from "../debug/errors.js";
import type { DebugSessionManager } from "../debug/session-manager.js";
import type { VariablesSelection } from "../debug/types.js";
import { parameters } from "./schema.js";
import {
  errorText,
  formatConfigurationsResult,
  formatEvaluateResult,
  formatExecutionOutcome,
  formatListBreakpointsResult,
  formatOutputResult,
  formatSessionSnapshot,
  formatSetBreakpointsResult,
  formatSetFunctionBreakpointsResult,
  formatStackTraceResult,
  formatStartResult,
  formatStopResult,
  formatThreadSnapshots,
  formatVariablesResult,
  resultText,
} from "./view.js";

/** Register the session-backed debug tool and its compact call renderer. */
export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Manage one program debugging session at a time; a new session requires the previous one to be closed before another can start.",
      "Discovery and lifecycle: `configurations` finds saved launch settings; `start` creates a session from a saved name or an inline launch/attach configuration; `status` returns the current session snapshot, including `busy` when another operation is in flight; `stop` requests cleanup and may return while cleanup is still in progress and may terminate a launched program.",
      "Breakpoints: `set_breakpoints` replaces one file's breakpoints; `set_function_breakpoints` replaces the global function-name breakpoint list; `list_breakpoints` returns every breakpoint currently installed in the session (source, function, and exception).",
      "Execution: `continue` resumes, `next` steps over, `step_in` enters, `step_out` returns, and `pause` interrupts; `wait` observes stops or exits without controlling execution.",
      "Inspection: `threads` refreshes the thread list; `stack_trace` lists frames; `variables` reads a scope or expands a value; `evaluate` evaluates one or more expressions in order; `output` reads buffered events.",
    ].join(" "),
    promptSnippet:
      "Debug programs by controlling execution and inspecting runtime evidence when static analysis is insufficient.",
    promptGuidelines: [
      "Use debug to test a concrete runtime hypothesis: stop where the evidence can distinguish possible causes, inspect the state, revise the hypothesis and repeat until the behavior is explained, then stop the session.",
      "Use debug `status` or `threads` when session state or thread selection is unclear.",
      "Use debug `wait` or `status` after an observation timeout rather than assuming execution stopped; avoid debug `evaluate` expressions with side effects unless necessary.",
      "Use debug `wait` with a `threadId` and no `revision` to retrieve that thread's current stop (revision and stop body) without waiting for a new event.",
      "Use debug `stop` when finished; if it reports `closing`, check debug `status` before starting another session.",
    ],
    parameters,

    async execute(_id, args, signal, _onUpdate, ctx) {
      const done = (text: string, details?: unknown) => ({
        content: [{ type: "text" as const, text }],
        details,
      });

      try {
        throwIfAborted(signal);

        switch (args.action) {
          case "configurations": {
            const result = await manager.configurations(ctx.cwd, signal);
            return done(resultText(formatConfigurationsResult(result)));
          }
          case "start": {
            if (args.configuration === undefined) {
              throw new DebugError("INVALID_ARGUMENT", "`start` requires `configuration`.");
            }
            const result = await manager.start(
              ctx.cwd,
              {
                configuration: args.configuration,
                breakpoints: args.initialBreakpoints ?? {},
                waitMs: args.waitMs ?? 1_000,
              },
              signal,
            );
            return done(resultText(formatStartResult(result)));
          }
          case "stop": {
            const result = await manager.stop();
            return done(resultText(formatStopResult(result)));
          }
          case "status":
            return done(resultText(formatSessionSnapshot(manager.get().snapshot())));
          case "wait": {
            const result = await manager
              .get()
              .wait({ threadId: args.threadId, revision: args.revision, waitMs: args.waitMs ?? 1_000 }, signal);
            return done(resultText(formatExecutionOutcome(result)));
          }
          case "continue":
          case "next":
          case "step_in":
          case "step_out":
          case "pause": {
            const result = await manager.get().execute(
              args.action,
              {
                threadId: args.threadId,
                singleThread: "singleThread" in args ? args.singleThread : undefined,
                waitMs: args.waitMs ?? 1_000,
              },
              signal,
            );
            return done(resultText(formatExecutionOutcome(result)));
          }
          case "set_breakpoints": {
            if (args.breakpoints === undefined) {
              throw new DebugError(
                "INVALID_ARGUMENT",
                "`set_breakpoints` requires one source object in `breakpoints`.",
              );
            }
            const result = await manager.get().setBreakpoints(args.breakpoints, signal);
            return done(resultText(formatSetBreakpointsResult(result)));
          }
          case "set_function_breakpoints": {
            if (args.functionBreakpoints === undefined) {
              throw new DebugError(
                "INVALID_ARGUMENT",
                "`set_function_breakpoints` requires `functionBreakpoints`; pass [] to clear.",
              );
            }
            const result = await manager.get().setFunctionBreakpoints(args.functionBreakpoints, signal);
            return done(resultText(formatSetFunctionBreakpointsResult(result)));
          }
          case "list_breakpoints":
            return done(resultText(formatListBreakpointsResult(manager.get().listBreakpoints())));
          case "threads": {
            const result = await manager.get().threads(pageOptions(args), signal);
            return done(resultText(formatThreadSnapshots(result)));
          }
          case "stack_trace": {
            const result = await manager.get().stackTrace(args, pageOptions(args, 20), signal);
            return done(resultText(formatStackTraceResult(result)));
          }
          case "variables": {
            if (args.variablesReference !== undefined) {
              if (args.revision === undefined)
                throw new DebugError("INVALID_ARGUMENT", "variablesReference requires revision.");
              if (args.frameIndex !== undefined || args.scope !== undefined) {
                throw new DebugError(
                  "INVALID_ARGUMENT",
                  "variablesReference cannot be combined with frameIndex or scope.",
                );
              }
            }
            const target: VariablesSelection =
              args.variablesReference !== undefined
                ? {
                    threadId: args.threadId,
                    revision: args.revision!,
                    variablesReference: args.variablesReference,
                  }
                : {
                    threadId: args.threadId,
                    revision: args.revision,
                    frameIndex: args.frameIndex ?? 0,
                    scope: args.scope ?? "locals",
                  };
            const result = await manager.get().variables(target, pageOptions(args), signal);
            return done(resultText(formatVariablesResult(result)));
          }
          case "evaluate": {
            if (!args.expressions || args.expressions.length === 0) {
              throw new DebugError("INVALID_ARGUMENT", "`evaluate` requires a non-empty `expressions` array.");
            }
            const result = await manager
              .get()
              .evaluate(
                { threadId: args.threadId, revision: args.revision, frameIndex: args.frameIndex ?? 0 },
                args.expressions,
                signal,
              );
            return done(resultText(formatEvaluateResult(result)));
          }
          case "output":
            return done(formatOutputResult(manager.get().output({ ...pageOptions(args), category: args.category })));
        }
      } catch (error) {
        // Pi only marks thrown execute errors as failed tool results.
        throw new Error(errorText(error, args.action), { cause: error });
      }
    },

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("debug ")) + theme.fg("muted", args.action ?? ""));
      return text;
    },
  });
}

function pageOptions(args: { start?: number; count?: number }, defaultCount = 50) {
  return { start: args.start ?? 0, count: args.count ?? defaultCount };
}
