import { StringEnum, Type as T } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as format from "./format.js";
import { type DebugConfiguration } from "./launchConfig.js";
import type { DebugSession, SessionManager, SessionState } from "./session/index.js";

export const DEBUG_TOOL_NAME = "debug";

/**
 * Register the single `debug` tool. The whole tool logic — translating one call
 * into L5 method calls and formatting the outcome — lives inline in `execute`.
 * Invalid usage throws an actionable Error, which Pi surfaces as a failed call.
 */
export function registerDebugTool(pi: ExtensionAPI, manager: SessionManager, configurations: DebugConfiguration[] = []): void {
  const configurationNames = configurations.map((c) => c.name);

  pi.registerTool({
    name: DEBUG_TOOL_NAME,
    label: "Debug",
    description: [
      "Drive an interactive debugger over the Debug Adapter Protocol (DAP) to launch a program, set breakpoints, step through code, and read live state.",
      "One call performs one `action`; results use simple `name=value` fields and print the `sessionId`, `threadId`, `frameId`, and `ref` handles needed by later calls.",
      "Launches come from configurations declared in `.vscode/launch.json` or `.pi/launch.json`; use action `start` with a configuration `name` to run one.",
      "Breakpoints come in three kinds: `set_breakpoints` (by file+line, supports conditions and logpoints), `set_function_breakpoints` (by function name), `set_exception_breakpoints` (by adapter-defined filter); `list_breakpoints` shows all of them and the available exception filters.",
      "Typical loop: `start` → `set_breakpoints` → `continue` → inspect with `stack_trace` / `scopes` / `variables` / `evaluate` → `step_over` / `step_in` / `step_out` / `continue` → `stop`.",
      "Inspection actions (`stack_trace`, `scopes`, `variables`, `evaluate`, stepping, `pause`) require the session to be stopped; check the `action` enum for per-action rules.",
    ].join("\n"),
    promptSnippet: "Debug a program interactively via DAP: launch, breakpoints, stepping, and reading live variables and expressions at a stop.",
    promptGuidelines: [
      "Use `debug` to diagnose runtime behaviour (crashes, wrong output, hangs, unclear control flow) by observing real values at a breakpoint, instead of guessing from source or adding print statements.",
      "Prefer `debug` over running the program with `bash` whenever you need to pause execution, inspect variables, or step through logic; keep `bash` for pure build, test, or run-and-read-output tasks.",
      'To observe a value at a spot that is hit repeatedly (loops, callbacks), prefer a logpoint (`set_breakpoints` with `logMessage`, e.g. "n={n}") plus a single `continue`, then read `output` — this avoids many `step`/`continue` round-trips since logpoints log without stopping.',
      "Do not modify program code through `debug` — its `evaluate` and `variables` actions are for reading live state; use `edit` or `write` to change source, then re-run `debug` to verify the fix.",
      "After each `debug` result, reuse the printed `frameId=N` and `ref=N` handles for follow-up `scopes` / `variables` / `evaluate` calls; do not invent numeric ids.",
      "Always end a `debug` investigation with action `stop` (or terminate/disconnect) so the debuggee and adapter process are cleaned up.",
    ],
    parameters: T.Object({
      action: StringEnum(
        [
          "start",
          "set_breakpoints",
          "set_function_breakpoints",
          "set_exception_breakpoints",
          "list_breakpoints",
          "continue",
          "step_over",
          "step_in",
          "step_out",
          "pause",
          "threads",
          "stack_trace",
          "scopes",
          "variables",
          "evaluate",
          "output",
          "list_sessions",
          "switch_session",
          "stop",
        ] as const,
        {
          description:
            "The debug operation to perform. Lifecycle: 'start' launches a program from a launch configuration; 'stop' ends a session. Breakpoints (may be set any time): 'set_breakpoints' sets source line breakpoints (with optional condition/hitCondition/logMessage), 'set_function_breakpoints' breaks on function entry by name, 'set_exception_breakpoints' enables adapter-defined exception filters, 'list_breakpoints' shows all breakpoints and the available exception filters. Execution (only while stopped): 'continue' resumes, 'step_over'/'step_in'/'step_out' step one line, 'pause' interrupts a running program; each returns where and why it stopped next. Inspection (only while stopped): 'threads' lists threads, 'stack_trace' lists call frames, 'scopes' lists a frame's scopes, 'variables' expands a variable container, 'evaluate' evaluates an expression, 'output' returns recent program output. Sessions: 'list_sessions' lists all debug sessions, 'switch_session' switches the active session.",
        },
      ),
      sessionId: T.Optional(
        T.String({
          description:
            "Which debug session to act on. Omit to use the active session (the one most recently started or selected). Obtain ids from action 'list_sessions'. Only needed when juggling more than one session at once.",
        }),
      ),
      name: StringEnum(configurationNames, {
        description:
          "For 'start': the name of the launch configuration to run, as defined in .vscode/launch.json or .pi/launch.json. Omit to use the first configuration found.",
      }),
      path: T.Optional(
        T.String({
          description: "For 'set_breakpoints': the source file to put breakpoints in, as a workspace-relative or absolute path.",
        }),
      ),
      breakpoints: T.Optional(
        T.Array(
          T.Object({
            line: T.Integer({ minimum: 1, description: "The 1-based line number to break on." }),
            condition: T.Optional(
              T.String({ description: "Break only when this expression (in the program's language) is truthy. Adapter must support conditional breakpoints." }),
            ),
            hitCondition: T.Optional(
              T.String({ description: "Break only after this many hits, e.g. '5' or '>=3'. Adapter must support hit-count breakpoints." }),
            ),
            logMessage: T.Optional(
              T.String({
                description:
                  "Turn this breakpoint into a logpoint: instead of stopping, log this message (interpolate expressions in {curly braces}, e.g. 'n={n}'). Read the logged lines with action 'output'. Adapter must support logpoints.",
              }),
            ),
          }),
          {
            description:
              "For 'set_breakpoints': the breakpoints to place in the file given by 'path'. This replaces ALL breakpoints previously set in that file; pass an empty array to clear them.",
          },
        ),
      ),
      functions: T.Optional(
        T.Array(
          T.Object({
            name: T.String({ description: "The function name to break on when it is entered." }),
            condition: T.Optional(T.String({ description: "Break only when this expression is truthy. Adapter must support conditional breakpoints." })),
            hitCondition: T.Optional(T.String({ description: "Break only after this many hits. Adapter must support hit-count breakpoints." })),
          }),
          {
            description:
              "For 'set_function_breakpoints': the functions to break on. This replaces ALL function breakpoints; pass an empty array to clear them.",
          },
        ),
      ),
      filters: T.Optional(
        T.Array(T.String(), {
          description:
            "For 'set_exception_breakpoints': the exception filter ids to enable (e.g. 'uncaught', 'raised'). Filters are defined by the adapter — run action 'list_breakpoints' to see the available ones. This replaces ALL exception settings; pass an empty array to disable them.",
        }),
      ),
      filterOptions: T.Optional(
        T.Array(
          T.Object({
            filterId: T.String({ description: "An exception filter id (from 'list_breakpoints')." }),
            condition: T.String({ description: "Break on this exception only when this expression is truthy." }),
          }),
          {
            description: "For 'set_exception_breakpoints': conditional exception filters. Adapter must support exception filter options.",
          },
        ),
      ),
      threadId: T.Optional(
        T.Integer({
          description:
            "For 'continue'/'step_over'/'step_in'/'step_out'/'pause': the thread to act on. Omit to use the thread that last stopped (the common case). Obtain thread ids from action 'threads'.",
        }),
      ),
      frameId: T.Optional(
        T.Integer({
          description:
            "For 'scopes' (required) and 'evaluate' (optional): the stack frame to inspect or evaluate in. Use a `frameId=N` value from a previous 'stack_trace' or stop result. For 'evaluate', omit to use the top frame.",
        }),
      ),
      levels: T.Optional(
        T.Integer({
          minimum: 1,
          description: "For 'stack_trace': the maximum number of call frames to return, counting from the top of the stack. Omit for the default limit.",
        }),
      ),
      variablesReference: T.Optional(
        T.Integer({
          description:
            "For 'variables': the container to expand. Use a `ref=N` value from 'scopes' or an expandable value from 'variables'/'evaluate'.",
        }),
      ),
      expression: T.Optional(
        T.String({
          description:
            "For 'evaluate': the expression to evaluate, written in the language of the program being debugged. It is evaluated in the frame given by frameId, or the top frame if none is given.",
        }),
      ),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, args, _signal) {
      const ok = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });

      switch (args.action) {
        case "start": {
          const config = pickConfiguration(configurations, args.name);
          const session = await manager.createSession(config);
          await session.configureAndStart();
          return ok(format.formatSessionSummary(session), summarize(session));
        }

        case "set_breakpoints": {
          const session = activeSession(manager, args.sessionId);
          const path = required(args.path, "path", args.action);
          const requested = required(args.breakpoints, "breakpoints", args.action);
          const verified = await session.setBreakpoints({ path, breakpoints: requested });
          const statuses = requested.map((bp, index) => ({ requested: bp, verified: verified[index] }));
          return ok(format.formatBreakpoints(path, statuses, session), verified);
        }

        case "set_function_breakpoints": {
          const session = activeSession(manager, args.sessionId);
          const requested = required(args.functions, "functions", args.action);
          const verified = await session.setFunctionBreakpoints(requested);
          const statuses = requested.map((bp, index) => ({ requested: bp, verified: verified[index] }));
          return ok(format.formatFunctionBreakpoints(statuses, session), verified);
        }

        case "set_exception_breakpoints": {
          const session = activeSession(manager, args.sessionId);
          const filters = required(args.filters, "filters", args.action);
          await session.setExceptionBreakpoints(filters, args.filterOptions);
          const { exception } = session.getBreakpointsSnapshot();
          return ok(format.formatExceptionBreakpoints(exception, session), exception);
        }

        case "list_breakpoints": {
          const session = activeSession(manager, args.sessionId);
          const snapshot = session.getBreakpointsSnapshot();
          return ok(format.formatBreakpointsSnapshot(snapshot, session), snapshot);
        }

        case "continue": {
          const session = activeSession(manager, args.sessionId);
          const outcome = await session.continueAndWait(args.threadId);
          return ok(format.formatResume(outcome, session.id), outcome);
        }

        case "step_over":
        case "step_in":
        case "step_out": {
          const session = activeSession(manager, args.sessionId);
          const threadId = required(args.threadId ?? session.getStopState()?.threadId, "threadId", args.action);
          const method = ({ step_over: "stepOver", step_in: "stepIn", step_out: "stepOut" } as const)[args.action];
          const outcome = await session[method](threadId);
          return ok(format.formatResume(outcome, session.id), outcome);
        }

        case "pause": {
          const session = activeSession(manager, args.sessionId);
          const threadId = required(args.threadId ?? session.getStopState()?.threadId, "threadId", args.action);
          const snapshot = await session.pause(threadId);
          return ok(format.formatStop(snapshot, session.id), snapshot);
        }

        case "threads": {
          const session = activeSession(manager, args.sessionId);
          const threads = await session.listThreads();
          return ok(format.formatThreads(threads, session), threads);
        }

        case "stack_trace": {
          const session = activeSession(manager, args.sessionId);
          const threadId = required(args.threadId ?? session.getStopState()?.threadId, "threadId", args.action);
          const frames = await session.getStackTrace(threadId, args.levels ? { levels: args.levels } : {});
          return ok(format.formatStack(frames, session), frames);
        }

        case "scopes": {
          const session = activeSession(manager, args.sessionId);
          const frameId = required(args.frameId, "frameId", args.action);
          const scopes = await session.getScopes(frameId);
          return ok(format.formatScopes(scopes, session), scopes);
        }

        case "variables": {
          const session = activeSession(manager, args.sessionId);
          const ref = required(args.variablesReference, "variablesReference", args.action);
          const variables = await session.getVariables(ref);
          return ok(format.formatVariables(variables, session), variables);
        }

        case "evaluate": {
          const session = activeSession(manager, args.sessionId);
          const expression = required(args.expression, "expression", args.action);
          const body = await session.evaluate(expression, args.frameId);
          return ok(format.formatEvaluate(body, session), body);
        }

        case "output": {
          const session = activeSession(manager, args.sessionId);
          const events = session.getRecentOutput();
          return ok(format.formatOutput(events, session), events);
        }

        case "list_sessions":
          return ok(format.formatSessions(manager.list(), manager.active?.id), manager.list().map(summarize));

        case "switch_session": {
          const id = required(args.sessionId, "sessionId", args.action);
          manager.setActive(id);
          const session = activeSession(manager, id);
          return ok(format.formatSessionSummary(session), summarize(session));
        }

        case "stop": {
          const session = activeSession(manager, args.sessionId);
          await session.terminate();
          return ok(format.formatStopRequest(session.id, session.state), summarize(session));
        }
      }
    },
  });
}

function pickConfiguration(configurations: DebugConfiguration[], name?: string): DebugConfiguration {
  if (configurations.length === 0) {
    throw new Error("No debug configurations found in .vscode/launch.json or .pi/launch.json");
  }
  if (name === undefined) {
    return configurations[0]!;
  }
  const match = configurations.find((config) => config.name === name);
  if (!match) {
    const names = configurations.map((config) => config.name ?? "(unnamed)").join(", ");
    throw new Error(`No debug configuration named "${name}". Available: ${names}`);
  }
  return match;
}

/** Resolve the target session: an explicit id, or the active session. */
function activeSession(manager: SessionManager, sessionId?: string): DebugSession {
  if (sessionId !== undefined) {
    const session = manager.get(sessionId);
    if (!session) {
      throw new Error(`No session "${sessionId}". Use action "list_sessions" to list them.`);
    }
    return session;
  }
  const session = manager.active;
  if (!session) {
    throw new Error('No active debug session. Use action "start" first.');
  }
  return session;
}

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) {
    throw new Error(`action "${action}" requires "${name}"`);
  }
  return value;
}

interface DebugSessionSummary {
  id: string;
  state: SessionState;
  parentId?: string;
  configuration: DebugConfiguration;
}

function summarize(session: DebugSession): DebugSessionSummary {
  return { id: session.id, state: session.state, parentId: session.parentId, configuration: session.configuration };
}
