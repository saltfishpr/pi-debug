import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DebugError, throwIfAborted } from "../debug/errors.js";
import type { DebugSessionManager } from "../debug/session-manager.js";
import type { VariablesSelection } from "../debug/types.js";
import { parameters } from "./schema.js";
import {
  errorText,
  formatCloseSessionResult,
  formatEvaluateResult,
  formatExecutionOutcome,
  formatListBreakpointsResult,
  formatListConfigurationsResult,
  formatOutputResult,
  formatSessionSnapshot,
  formatSessionSummaries,
  formatSetBreakpointsResult,
  formatSetFunctionBreakpointsResult,
  formatStackTraceResult,
  formatStartResult,
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
      "Manage multiple independently addressed program debugging sessions; `start` returns the `sessionId` required by later session-specific actions.",
      "Discovery and lifecycle: `list_configurations` finds saved launch settings; `list_sessions` returns local summaries, including parent IDs for adapter-created child sessions; `start` creates a session from a saved name or inline launch/attach configuration; `status` returns one session snapshot; `close_session` requests cleanup and may return while cleanup is still in progress and may terminate a launched program and its child sessions.",
      "Breakpoints: `set_breakpoints` replaces one file's breakpoints; `set_function_breakpoints` replaces the selected session's function-name breakpoint list; `list_breakpoints` returns every breakpoint currently installed in that session (source, function, and exception).",
      "Execution: `continue` resumes, `next` steps over, `step_in` enters, `step_out` returns, and `pause` interrupts; `wait` observes stops or exits without controlling execution.",
      "Inspection: `threads` refreshes the thread list; `stack_trace` lists frames; `variables` reads a scope or expands a value; `evaluate` evaluates one or more expressions in order; `output` reads buffered events.",
    ].join(" "),
    promptSnippet:
      "Debug programs by controlling execution and inspecting runtime evidence when static analysis is insufficient.",
    promptGuidelines: [
      "Use debug to test a concrete runtime hypothesis: stop where the evidence can distinguish possible causes, inspect the state, revise the hypothesis and repeat until the behavior is explained, then stop the session.",
      "Use debug `list_sessions` to discover session IDs, and keep each thread ID, revision, and variable reference with the `sessionId` that returned it.",
      "Use debug `status` or `threads` when session state or thread selection is unclear.",
      "Use debug `wait` or `status` after an observation timeout rather than assuming execution stopped; avoid debug `evaluate` expressions with side effects unless necessary.",
      "Use debug `wait` with a `threadId` and no `revision` to retrieve that thread's current stop (revision and stop body) without waiting for a new event.",
      "Use debug `close_session` when finished; `pause` only suspends execution and keeps the session open.",
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
          case "list_configurations": {
            const result = await manager.listConfigurations(ctx.cwd, signal);
            return done(resultText(formatListConfigurationsResult(result)));
          }
          case "list_sessions":
            return done(resultText(formatSessionSummaries(manager.listSessions())));
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
          case "close_session": {
            const result = await manager.closeSession(requireSessionId(args));
            return done(resultText(formatCloseSessionResult(result)));
          }
          case "status":
            return done(resultText(formatSessionSnapshot(manager.status(requireSessionId(args)))));
          case "wait": {
            const sessionId = requireSessionId(args);
            const result = await manager
              .get(sessionId)
              .wait({ threadId: args.threadId, revision: args.revision, waitMs: args.waitMs ?? 1_000 }, signal);
            return done(resultText(formatExecutionOutcome(result)));
          }
          case "continue":
          case "next":
          case "step_in":
          case "step_out":
          case "pause": {
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).execute(
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
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).setBreakpoints(args.breakpoints, signal);
            return done(resultText(formatSetBreakpointsResult(result)));
          }
          case "set_function_breakpoints": {
            if (args.functionBreakpoints === undefined) {
              throw new DebugError(
                "INVALID_ARGUMENT",
                "`set_function_breakpoints` requires `functionBreakpoints`; pass [] to clear.",
              );
            }
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).setFunctionBreakpoints(args.functionBreakpoints, signal);
            return done(resultText(formatSetFunctionBreakpointsResult(result)));
          }
          case "list_breakpoints": {
            const sessionId = requireSessionId(args);
            return done(resultText(formatListBreakpointsResult(manager.get(sessionId).listBreakpoints())));
          }
          case "threads": {
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).threads(pageOptions(args), signal);
            return done(resultText(formatThreadSnapshots(result)));
          }
          case "stack_trace": {
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).stackTrace(args, pageOptions(args, 20), signal);
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
            const sessionId = requireSessionId(args);
            const result = await manager.get(sessionId).variables(target, pageOptions(args), signal);
            return done(resultText(formatVariablesResult(result)));
          }
          case "evaluate": {
            if (!args.expressions || args.expressions.length === 0) {
              throw new DebugError("INVALID_ARGUMENT", "`evaluate` requires a non-empty `expressions` array.");
            }
            const sessionId = requireSessionId(args);
            const result = await manager
              .get(sessionId)
              .evaluate(
                { threadId: args.threadId, revision: args.revision, frameIndex: args.frameIndex ?? 0 },
                args.expressions,
                signal,
              );
            return done(resultText(formatEvaluateResult(result)));
          }
          case "output": {
            const sessionId = requireSessionId(args);
            return done(
              formatOutputResult(manager.get(sessionId).output({ ...pageOptions(args), category: args.category })),
            );
          }
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

function requireSessionId(args: { sessionId?: string }): string {
  if (!args.sessionId) {
    throw new DebugError("INVALID_ARGUMENT", "This action requires `sessionId`.");
  }
  return args.sessionId;
}

function pageOptions(args: { start?: number; count?: number }, defaultCount = 50) {
  return { start: args.start ?? 0, count: args.count ?? defaultCount };
}
