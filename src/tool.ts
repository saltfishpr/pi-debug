import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import {
  formatAddBreakpoints,
  formatAddFunctionBreakpoints,
  formatContinue,
  formatEvaluate,
  formatListBreakpoints,
  formatListSessions,
  formatNext,
  formatOutput,
  formatPause,
  formatRemoveBreakpoints,
  formatRemoveFunctionBreakpoints,
  formatScopes,
  formatSelectFrame,
  formatStackTrace,
  formatStatus,
  formatStepIn,
  formatStepOut,
  formatStopSession,
  formatThreads,
  formatVariables,
} from "./format";
import type { PiDebugSessionManager } from "./manager";
import type { ContinueOptions, NextOptions, StepInOptions, StepOutOptions } from "./session";

const DEFAULT_WAIT_MS = 5000;

const BreakpointSpec = Type.Object({
  line: Type.Number({ description: "1-based line number" }),
  condition: Type.Optional(Type.String({ description: "Expression that must evaluate truthy to break" })),
  hitCondition: Type.Optional(Type.String({ description: "Hit-count condition, e.g. '>= 5'" })),
  logMessage: Type.Optional(Type.String({ description: "Log message instead of pausing (logpoint)" })),
});

const FunctionBreakpointSpec = Type.Object({
  name: Type.String({ description: "Function name to break on entry" }),
  condition: Type.Optional(Type.String({ description: "Expression that must evaluate truthy to break" })),
  hitCondition: Type.Optional(Type.String({ description: "Hit-count condition, e.g. '>= 5'" })),
});

const SessionIdOpt = Type.Optional(Type.String({ description: "Target session id; defaults to the active session" }));
const WaitForStop = Type.Optional(Type.Boolean({ description: "Wait for the next stop event (default true)" }));
const WaitTimeoutMs = Type.Optional(Type.Number({ description: "Milliseconds to wait for a stop (default 5000)" }));
const ThreadIdOpt = Type.Optional(Type.Number({ description: "Thread id; defaults to the currently stopped thread" }));

export function registerDebugTool(pi: ExtensionAPI, manager: PiDebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Drive a Debug Adapter Protocol (DAP) session to diagnose bugs at runtime.",
      "Dispatched by `action`; one call performs one DAP operation.",
      "",
      "Session lifecycle:",
      "  - list_sessions: list known debug sessions and the active one.",
      "  - start: attach to a debug adapter using a named configuration.",
      "  - stop: disconnect a session, optionally terminating the debuggee.",
      "",
      "Breakpoints:",
      "  - add_breakpoints / remove_breakpoints / list_breakpoints against an absolute source path.",
      "    Supports conditions, hit-count conditions, and logpoints.",
      "  - add_function_breakpoints / remove_function_breakpoints / list_breakpoints (with `includeFunctions`) manage function breakpoints by name.",
      "    Supports conditions and hit-count conditions; requires adapter capability `supportsFunctionBreakpoints`.",
      "",
      "Execution control (require a stopped thread; each can `waitForStop` for the next stop event):",
      "  - continue, next (step-over), step_in, step_out, pause.",
      "",
      "Inspection (only meaningful while stopped):",
      "  - threads: paginated thread list, with stopped threads first.",
      "  - stack_trace: frames for a thread.",
      "  - select_frame: focus a stack frame as the default for `evaluate`.",
      "  - scopes: scopes for a frame.",
      "  - variables: expand a `variablesReference` from scopes/variables.",
      "  - evaluate: run an expression in `repl`/`watch`/`hover` context, optionally scoped to a frame.",
      "",
      "Runtime output:",
      "  - output: drain and optionally clear the debuggee's stdout/stderr/console buffer.",
      "  - status: snapshot of one session (state, threads, focused frame).",
      "",
      "`sessionId` is optional on every action and defaults to the active session.",
    ].join("\n"),
    promptSnippet: "Drive a DAP debug session: manage breakpoints, step through code, inspect stacks/variables, and evaluate expressions.",
    promptGuidelines: ["Use `debug` when diagnosing a bug requires runtime evidence such as breakpoint hits, call stacks, or variable values."],
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("list_sessions"),
      }),
      Type.Object({
        action: Type.Literal("start"),
        name: Type.Optional(
          StringEnum(manager.configurationNames, {
            description: "Launch configuration name; can omit when exactly one configuration exists",
          }),
        ),
      }),
      Type.Object({
        action: Type.Literal("stop"),
        terminateDebuggee: Type.Optional(
          Type.Boolean({
            description:
              "If true, ask the adapter to terminate the debuggee process on disconnect; if false, detach and leave it running. Omit to use the adapter default.",
          }),
        ),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("add_breakpoints"),
        source: Type.String({ description: "Absolute source file path to set breakpoints in" }),
        breakpoints: Type.Array(BreakpointSpec, {
          description:
            "Breakpoints to add or update in this source. Entries matching an existing line replace it; other existing breakpoints in the file are preserved.",
        }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("remove_breakpoints"),
        source: Type.String({ description: "Absolute source file path to remove breakpoints from" }),
        lines: Type.Optional(
          Type.Array(Type.Number(), {
            description: "Lines to remove; omit or empty to clear all breakpoints in this source",
          }),
        ),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("add_function_breakpoints"),
        breakpoints: Type.Array(FunctionBreakpointSpec, {
          description:
            "Function breakpoints to add or update by name. Entries matching an existing name replace it; other function breakpoints are preserved. Requires adapter capability `supportsFunctionBreakpoints`.",
        }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("remove_function_breakpoints"),
        names: Type.Optional(
          Type.Array(Type.String(), {
            description: "Function breakpoint names to remove; omit or empty to clear all function breakpoints",
          }),
        ),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("list_breakpoints"),
        source: Type.Optional(Type.String({ description: "Absolute source file path to filter source breakpoints by; omit to list all sources" })),
        includeFunctions: Type.Optional(Type.Boolean({ description: "Include function breakpoints in the result (default true)" })),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("continue"),
        threadId: ThreadIdOpt,
        waitForStop: WaitForStop,
        waitTimeoutMs: WaitTimeoutMs,
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("next"),
        threadId: ThreadIdOpt,
        waitForStop: WaitForStop,
        waitTimeoutMs: WaitTimeoutMs,
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("step_in"),
        threadId: ThreadIdOpt,
        targetId: Type.Optional(
          Type.Number({
            description: "Optional step-in target id from `stepInTargets`; omit to step into the default (usually first) callee",
          }),
        ),
        waitForStop: WaitForStop,
        waitTimeoutMs: WaitTimeoutMs,
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("step_out"),
        threadId: ThreadIdOpt,
        waitForStop: WaitForStop,
        waitTimeoutMs: WaitTimeoutMs,
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("pause"),
        threadId: Type.Number({ description: "Thread id to pause; obtain from `status` or a previous stop result" }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("threads"),
        start: Type.Optional(Type.Number({ description: "Zero-based index of the first thread to return (default 0)" })),
        levels: Type.Optional(Type.Number({ description: "Maximum number of threads to return; omit to return all remaining threads" })),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("stack_trace"),
        threadId: ThreadIdOpt,
        startFrame: Type.Optional(Type.Number({ description: "Zero-based index of the first frame to return (default 0)" })),
        levels: Type.Optional(Type.Number({ description: "Maximum number of frames to return; omit for the adapter default" })),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("select_frame"),
        frameId: Type.Number({ description: "Frame id (from `stack_trace`) to focus as the default for `evaluate`" }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("scopes"),
        frameId: Type.Number({ description: "Frame id returned by `stack_trace`" }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("variables"),
        variablesReference: Type.Number({
          description: "`variablesReference` returned by `scopes` or a parent `variables` entry; identifies the container to expand",
        }),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("evaluate"),
        expression: Type.String({ description: "Expression to evaluate in the debuggee, in the target language's syntax" }),
        frameId: Type.Optional(Type.Number({ description: "Frame id to evaluate in; omit for a global-scope evaluation" })),
        context: Type.Optional(
          StringEnum(["repl", "watch", "hover"] as const, {
            description:
              "Evaluation context hint for the adapter (default `repl`): `repl` for interactive commands, `watch` for watch expressions, `hover` for lightweight lookups",
          }),
        ),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("output"),
        clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading (default true)" })),
        sessionId: SessionIdOpt,
      }),
      Type.Object({
        action: Type.Literal("status"),
        sessionId: SessionIdOpt,
      }),
    ]),
    executionMode: "sequential",

    async execute(_toolCallId, params, signal) {
      const done = (text: string, details: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details,
      });

      switch (params.action) {
        case "list_sessions": {
          const activeId = manager.activeId();
          const sessions = manager.list().map((s) => s.snapshot());
          return done(formatListSessions(activeId, sessions), { activeId, sessions });
        }
        case "start": {
          const session = await manager.start(params.name !== undefined ? { name: params.name } : {});
          const snapshot = session.snapshot();
          return done(formatStatus(snapshot, Date.now()), { session: snapshot });
        }
        case "stop": {
          const session = manager.resolve(params.sessionId);
          await session.stop(params.terminateDebuggee);
          const state = session.state;
          return done(formatStopSession(session.id, state), { sessionId: session.id, state });
        }
        case "add_breakpoints": {
          const session = manager.resolve(params.sessionId);
          const breakpoints = await session.addBreakpoints(params.source, params.breakpoints);
          return done(formatAddBreakpoints(session.id, params.source, breakpoints), { source: params.source, breakpoints });
        }
        case "remove_breakpoints": {
          const session = manager.resolve(params.sessionId);
          const breakpoints = await session.removeBreakpoints(params.source, params.lines);
          return done(formatRemoveBreakpoints(session.id, params.source, breakpoints), { source: params.source, breakpoints });
        }
        case "add_function_breakpoints": {
          const session = manager.resolve(params.sessionId);
          const functionBreakpoints = await session.addFunctionBreakpoints(params.breakpoints);
          return done(formatAddFunctionBreakpoints(session.id, functionBreakpoints), { functionBreakpoints });
        }
        case "remove_function_breakpoints": {
          const session = manager.resolve(params.sessionId);
          const functionBreakpoints = await session.removeFunctionBreakpoints(params.names);
          return done(formatRemoveFunctionBreakpoints(session.id, functionBreakpoints), { functionBreakpoints });
        }
        case "list_breakpoints": {
          const session = manager.resolve(params.sessionId);
          const breakpoints = session.listBreakpoints(params.source);
          const includeFunctions = params.includeFunctions ?? true;
          const functionBreakpoints = includeFunctions ? session.listFunctionBreakpoints() : [];
          return done(formatListBreakpoints(session.id, breakpoints, functionBreakpoints, { source: params.source, includeFunctions }), {
            breakpoints,
            functionBreakpoints,
          });
        }
        case "continue": {
          const session = manager.resolve(params.sessionId);
          const opts: ContinueOptions = {
            waitForStop: params.waitForStop ?? true,
            waitTimeoutMs: params.waitTimeoutMs ?? DEFAULT_WAIT_MS,
          };
          if (params.threadId !== undefined) opts.threadId = params.threadId;
          if (signal) opts.signal = signal;
          const result = await session.continueAndWait(opts);
          return done(formatContinue(session.id, result), { ...result });
        }
        case "next": {
          const session = manager.resolve(params.sessionId);
          const opts: NextOptions = {
            waitForStop: params.waitForStop ?? true,
            waitTimeoutMs: params.waitTimeoutMs ?? DEFAULT_WAIT_MS,
          };
          if (params.threadId !== undefined) opts.threadId = params.threadId;
          if (signal) opts.signal = signal;
          const result = await session.next(opts);
          return done(formatNext(session.id, result), { ...result });
        }
        case "step_in": {
          const session = manager.resolve(params.sessionId);
          const opts: StepInOptions = {
            waitForStop: params.waitForStop ?? true,
            waitTimeoutMs: params.waitTimeoutMs ?? DEFAULT_WAIT_MS,
          };
          if (params.threadId !== undefined) opts.threadId = params.threadId;
          if (params.targetId !== undefined) opts.targetId = params.targetId;
          if (signal) opts.signal = signal;
          const result = await session.stepIn(opts);
          return done(formatStepIn(session.id, result), { ...result });
        }
        case "step_out": {
          const session = manager.resolve(params.sessionId);
          const opts: StepOutOptions = {
            waitForStop: params.waitForStop ?? true,
            waitTimeoutMs: params.waitTimeoutMs ?? DEFAULT_WAIT_MS,
          };
          if (params.threadId !== undefined) opts.threadId = params.threadId;
          if (signal) opts.signal = signal;
          const result = await session.stepOut(opts);
          return done(formatStepOut(session.id, result), { ...result });
        }
        case "pause": {
          const session = manager.resolve(params.sessionId);
          await session.pause(params.threadId);
          const state = session.state;
          return done(formatPause(session.id, params.threadId, state), { state });
        }
        case "threads": {
          const session = manager.resolve(params.sessionId);
          const start = params.start ?? 0;
          const threads = (await session.threads()).sort((a, b) => Number(b.stopped) - Number(a.stopped));
          const page = threads.slice(start, params.levels === undefined ? undefined : start + params.levels);
          return done(formatThreads(session.id, page, start, threads.length, params.levels), { threads: page, total: threads.length });
        }
        case "stack_trace": {
          const session = manager.resolve(params.sessionId);
          const frames = await session.stackTrace(params.threadId, params.startFrame, params.levels);
          return done(formatStackTrace(session.id, params.threadId ?? session.stoppedThreadId, frames, params.startFrame), { frames });
        }
        case "select_frame": {
          const session = manager.resolve(params.sessionId);
          session.selectFrame(params.frameId);
          const snapshot = session.snapshot();
          return done(formatSelectFrame(session.id, snapshot, params.frameId), { session: snapshot });
        }
        case "scopes": {
          const session = manager.resolve(params.sessionId);
          const scopes = await session.scopes(params.frameId);
          return done(formatScopes(session.id, params.frameId, scopes), { scopes });
        }
        case "variables": {
          const session = manager.resolve(params.sessionId);
          const variables = await session.variables(params.variablesReference);
          return done(formatVariables(session.id, params.variablesReference, variables), { variables });
        }
        case "evaluate": {
          const session = manager.resolve(params.sessionId);
          const result = await session.evaluate(params.expression, params.frameId, params.context ?? "repl");
          return done(formatEvaluate(session.id, params.expression, params.frameId, result), { result });
        }
        case "output": {
          const session = manager.resolve(params.sessionId);
          const chunks = session.drainOutput(params.clear ?? true);
          return done(formatOutput(session.id, chunks, params.clear ?? true), { chunks });
        }
        case "status": {
          const session = manager.resolve(params.sessionId);
          const snapshot = session.snapshot();
          return done(formatStatus(snapshot, Date.now()), { session: snapshot });
        }
      }
    },

    renderCall(args, theme, context) {
      if (!context.argsComplete) return new Text(theme.fg("toolTitle", theme.bold("debug")) + theme.fg("dim", " preparing..."), 0, 0);

      const MAX_INLINE_ITEMS = 3;
      const MAX_EXPRESSION_LENGTH = 80;

      function displayPath(source: string, cwd: string): string {
        const path = relative(cwd, source); // TODO remote 情况下 cwd 需要为 debuggee 工作目录
        return path === "" ? "." : path.startsWith("..") ? source : path;
      }

      function summarize<T>(items: readonly T[], render: (item: T) => string): string {
        const displayed = items.slice(0, MAX_INLINE_ITEMS).map(render);
        return items.length > MAX_INLINE_ITEMS ? `${displayed.join(", ")} +${items.length - MAX_INLINE_ITEMS}` : displayed.join(", ");
      }

      function summarizeExpression(expression: string): string {
        const singleLine = expression.replace(/\s+/g, " ");
        const text = singleLine.length > MAX_EXPRESSION_LENGTH ? `${singleLine.slice(0, MAX_EXPRESSION_LENGTH - 1)}...` : singleLine;
        return JSON.stringify(text);
      }

      let target: string | undefined;
      const modifiers: string[] = [];
      const session = !("sessionId" in args) || args.sessionId === undefined ? "active session" : `session ${args.sessionId}`;

      switch (args.action) {
        case "list_sessions":
          target = "sessions";
          break;
        case "start":
          target = args.name === undefined ? "default configuration" : JSON.stringify(args.name);
          break;
        case "stop":
          target = session;
          if (args.terminateDebuggee === true) modifiers.push("terminate");
          if (args.terminateDebuggee === false) modifiers.push("detach");
          break;
        case "add_breakpoints": {
          const conditions = args.breakpoints.filter((breakpoint) => breakpoint.condition !== undefined).length;
          const logpoints = args.breakpoints.filter((breakpoint) => breakpoint.logMessage !== undefined).length;
          target = `${displayPath(args.source, context.cwd)}:${summarize(args.breakpoints, (breakpoint) => String(breakpoint.line))}`;
          if (conditions > 0) modifiers.push(`${conditions} conditional`);
          if (logpoints > 0) modifiers.push(`${logpoints} logpoint${logpoints === 1 ? "" : "s"}`);
          modifiers.push(session);
          break;
        }
        case "remove_breakpoints":
          target = args.lines?.length
            ? `${displayPath(args.source, context.cwd)}:${summarize(args.lines, String)}`
            : `clear ${displayPath(args.source, context.cwd)}`;
          modifiers.push(session);
          break;
        case "add_function_breakpoints":
          target = summarize(args.breakpoints, (breakpoint) => JSON.stringify(breakpoint.name));
          modifiers.push(session);
          break;
        case "remove_function_breakpoints":
          target = args.names?.length ? summarize(args.names, JSON.stringify) : "clear all";
          modifiers.push(session);
          break;
        case "list_breakpoints":
          target = args.source === undefined ? "all sources" : displayPath(args.source, context.cwd);
          if (args.includeFunctions === false) modifiers.push("source only");
          modifiers.push(session);
          break;
        case "continue":
        case "next":
        case "step_out":
          target = args.threadId === undefined ? "current thread" : `thread #${args.threadId}`;
          if (args.waitForStop ?? true) modifiers.push(`wait ≤ ${args.waitTimeoutMs ?? DEFAULT_WAIT_MS}ms`);
          modifiers.push(session);
          break;
        case "step_in":
          target = args.threadId === undefined ? "current thread" : `thread #${args.threadId}`;
          if (args.targetId !== undefined) modifiers.push(`target #${args.targetId}`);
          if (args.waitForStop ?? true) modifiers.push(`wait ≤ ${args.waitTimeoutMs ?? DEFAULT_WAIT_MS}ms`);
          modifiers.push(session);
          break;
        case "pause":
          target = `thread #${args.threadId}`;
          modifiers.push(session);
          break;
        case "threads":
          if (args.start !== undefined && args.start !== 0) modifiers.push(`start ${args.start}`);
          if (args.levels !== undefined) modifiers.push(`levels ${args.levels}`);
          modifiers.push(session);
          break;
        case "stack_trace":
          target = args.threadId === undefined ? "current thread" : `thread #${args.threadId}`;
          if (args.startFrame !== undefined && args.startFrame !== 0) modifiers.push(`frame ${args.startFrame}`);
          if (args.levels !== undefined) modifiers.push(`levels ${args.levels}`);
          modifiers.push(session);
          break;
        case "select_frame":
          target = `frame #${args.frameId}`;
          modifiers.push(session);
          break;
        case "scopes":
          target = `frame #${args.frameId}`;
          modifiers.push(session);
          break;
        case "variables":
          target = `reference #${args.variablesReference}`;
          modifiers.push(session);
          break;
        case "evaluate":
          target = summarizeExpression(args.expression);
          modifiers.push(args.frameId === undefined ? "selected frame" : `frame #${args.frameId}`, args.context ?? "repl", session);
          break;
        case "output":
          target = (args.clear ?? true) ? "clear" : "retain";
          modifiers.push(session);
          break;
        case "status":
          target = session;
          break;
      }

      let text = theme.fg("toolTitle", theme.bold("debug")) + theme.fg("muted", ` ${args.action}`);
      if (target !== undefined) text += ` ${theme.fg("text", target)}`;
      if (modifiers.length > 0) text += theme.fg("dim", ` · ${modifiers.join(" · ")}`);
      if (context.executionStarted && context.isPartial) text += theme.fg("dim", " · running...");
      return new Text(text, 0, 0);
    },
  });
}
