import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DebugSessionManager } from "../debug/session-manager.js";
import { debugParameters, type DebugArguments } from "./schema.js";
import * as view from "./view.js";

export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Control program execution and inspect runtime state through one debug session that persists across calls; only one session can be active at a time.",
      "Start with a saved configuration name from `configurations` or an inline launch/attach configuration. All other actions require an existing session; `status`, `output`, `wait`, and `stop` also accept a retained closed session.",
      "Execution-control actions return after observing a stop, selected thread exit, or completed session closure, or when their event-wait budget expires. A timeout reports current session state but does not pause the debuggee or cancel the dispatched operation. `wait` observes new thread events, but returns immediately for an already closed session. Program exit alone does not imply session closure; `closing` means cleanup is still in progress, and `cleanupError` in the closed state reports cleanup failure.",
      "Stack, variable, evaluation, and inspection actions require a stopped thread, but other threads and shared state may continue changing. `evaluate` runs code in the debuggee and may have side effects.",
      "`stop` closes and forgets the session. It may terminate a launched program; disconnecting from an attached program leaves that program running.",
    ].join(" "),
    promptSnippet:
      "Debug running programs by controlling execution and inspecting runtime state when static analysis is insufficient.",
    promptGuidelines: [
      "Before using `debug`, state a concrete hypothesis and place breakpoints that can confirm or refute it; prefer targeted stops to repeated single-stepping.",
      "After `debug` reports a stop, use `inspect` for a bounded overview; use `stack_trace`, `variables`, or `evaluate` directly when the required thread, frame, scope, or expression is already known.",
      "Read the execution outcome from `debug` before inspecting or resuming. After a timeout, use `status` to reassess the session and `wait` for another event if needed; do not repeat the execution action merely because its wait budget expired.",
      "Keep `debug` execution-control calls sequential, and finish collecting evidence from a stopped thread before resuming it; other threads may still change shared state.",
      "Use read-only expressions with `debug` action `evaluate` by default; call functions or assign values only when the resulting side effects are intentional.",
      "Call `debug` with `stop` when the investigation is complete to release debugging resources.",
    ],
    parameters: debugParameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await executeDebugAction(manager, args, ctx.cwd, signal);
      return {
        content: [{ type: "text", text: result }],
        details: undefined, // TODO
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = args.action;
      const title = theme.fg("toolTitle", theme.bold("debug "));

      if (!action) {
        text.setText(title + theme.fg("muted", context.argsComplete ? "invalid action" : "preparing action…"));
        return text;
      }

      text.setText(title + theme.fg("accent", action) + theme.fg("dim", describeDebugAction(args)));
      return text;
    },
  });
}

function describeDebugAction(args: DebugArguments): string {
  switch (args.action) {
    case "configurations":
    case "stop":
    case "status":
      return "";
    case "start": {
      const breakpoints = args.breakpoints?.reduce((total, item) => total + item.lines.length, 0) ?? 0;
      return details(
        formatConfiguration(args.configuration),
        breakpoints > 0 && `breakpoints=${breakpoints}`,
        wait(args),
      );
    }
    case "set_breakpoints":
      return details(args.file, `lines=${args.lines?.join(",") || "none"}`);
    case "continue":
    case "next":
    case "step_in":
    case "step_out":
      return details(thread(args), args.singleThread && "single-thread", wait(args));
    case "pause":
      return details(thread(args), wait(args));
    case "wait":
      return details(thread(args), wait(args));
    case "threads":
      return details(`offset=${args.start ?? 0}`, `count=${args.count ?? 50}`);
    case "stack_trace":
      return details(thread(args), `offset=${args.start ?? 0}`, `count=${args.count ?? 20}`);
    case "variables":
      return details(
        thread(args),
        args.variablesReference !== undefined
          ? `reference=${args.variablesReference}`
          : `frame=${args.frame ?? 0} · scope=${args.scope ?? "locals"}`,
        `offset=${args.start ?? 0}`,
        `count=${args.count ?? 50}`,
      );
    case "evaluate":
      return details(quote(args.expression ?? "…"), thread(args), `frame=${args.frame ?? 0}`);
    case "output":
      return details(
        args.category && `category=${args.category}`,
        `offset=${args.start ?? 0}`,
        `count=${args.count ?? 50}`,
      );
    case "inspect":
      return details(thread(args), `frame=${args.frame ?? 0}`, args.scope && `scope=${args.scope}`);
  }
}

function formatConfiguration(configuration: DebugArguments["configuration"]): string | undefined {
  if (typeof configuration === "string") return quote(configuration);
  if (!configuration) return undefined;
  return `${quote(configuration.name)} · ${configuration.type}/${configuration.request}`;
}

function thread(args: DebugArguments): string | false {
  return args.threadId !== undefined && `thread=${args.threadId}`;
}

function wait(args: DebugArguments): string {
  return `wait=${args.waitMs ?? 1_000}ms`;
}

function details(...parts: Array<string | false | undefined>): string {
  const visible = parts.filter((part): part is string => Boolean(part));
  return visible.length > 0 ? ` — ${visible.join(" · ")}` : "";
}

function quote(value: string): string {
  const limit = 100;
  const display = value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  return JSON.stringify(display);
}

async function executeDebugAction(
  manager: DebugSessionManager,
  args: DebugArguments,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  switch (args.action) {
    case "configurations": {
      const result = await manager.configurations(cwd);
      return view.formatConfigurationsResult(result);
    }
    case "start": {
      const result = await manager.start(
        requireArgument(args.configuration, "configuration", args.action),
        { breakpoints: args.breakpoints ?? [], waitMs: args.waitMs ?? 1_000 },
        cwd,
        signal,
      );
      return view.formatStartResult(result);
    }
    case "stop": {
      const result = await manager.stop();
      return view.formatStopResult(result);
    }
  }

  const session = manager.getSession();
  switch (args.action) {
    case "status": {
      const result = session.snapshot();
      return view.formatStatusResult(result);
    }
    case "set_breakpoints": {
      const result = await session.setBreakpoints(
        requireArgument(args.file, "file", args.action),
        requireArgument(args.lines, "lines", args.action),
        signal,
      );
      return view.formatSetBreakpointsResult(result);
    }
    case "continue": {
      const result = await session.continue(resumeOptions(args), signal);
      return view.formatContinueResult(result);
    }
    case "next": {
      const result = await session.next(resumeOptions(args), signal);
      return view.formatNextResult(result);
    }
    case "step_in": {
      const result = await session.stepIn(resumeOptions(args), signal);
      return view.formatStepInResult(result);
    }
    case "step_out": {
      const result = await session.stepOut(resumeOptions(args), signal);
      return view.formatStepOutResult(result);
    }
    case "pause": {
      const result = await session.pause({ threadId: args.threadId, waitMs: args.waitMs ?? 1_000 }, signal);
      return view.formatPauseResult(result);
    }
    case "wait": {
      const result = await session.wait({ threadId: args.threadId, waitMs: args.waitMs ?? 1_000 }, signal);
      return view.formatWaitResult(result);
    }
    case "threads": {
      const result = await session.threads({ start: args.start ?? 0, count: args.count ?? 50 }, signal);
      return view.formatThreadsResult(result);
    }
    case "stack_trace": {
      const result = await session.stackTrace(
        { threadId: args.threadId, start: args.start ?? 0, count: args.count ?? 20 },
        signal,
      );
      return view.formatStackTraceResult(result);
    }
    case "variables": {
      const result = await session.variables(variablesOptions(args), signal);
      return view.formatVariablesResult(result);
    }
    case "evaluate": {
      const result = await session.evaluate(
        {
          threadId: args.threadId,
          frame: args.frame ?? 0,
          expression: requireArgument(args.expression, "expression", args.action),
        },
        signal,
      );
      return view.formatEvaluateResult(result);
    }
    case "output": {
      const result = session.output({
        ...(args.category !== undefined ? { category: args.category } : {}),
        start: args.start ?? 0,
        count: args.count ?? 50,
      });
      return view.formatOutputResult(result);
    }
    case "inspect": {
      const result = await session.inspect(inspectOptions(args), signal);
      return view.formatInspectResult(result);
    }
  }
}

function resumeOptions(args: DebugArguments): {
  threadId?: number;
  singleThread: boolean;
  waitMs: number;
} {
  return {
    threadId: args.threadId,
    singleThread: args.singleThread ?? false,
    waitMs: args.waitMs ?? 1_000,
  };
}

function variablesOptions(args: DebugArguments):
  | {
      threadId?: number;
      variablesReference: number;
      start: number;
      count: number;
    }
  | {
      threadId?: number;
      variablesReference?: undefined;
      frame: number;
      scope: string;
      start: number;
      count: number;
    } {
  if (args.variablesReference !== undefined) {
    if (args.frame !== undefined || args.scope !== undefined) {
      throw new Error("variablesReference cannot be combined with frame or scope.");
    }
    return {
      threadId: args.threadId,
      variablesReference: args.variablesReference,
      start: args.start ?? 0,
      count: args.count ?? 50,
    };
  }
  return {
    threadId: args.threadId,
    frame: args.frame ?? 0,
    scope: args.scope ?? "locals",
    start: args.start ?? 0,
    count: args.count ?? 50,
  };
}

function inspectOptions(args: DebugArguments): {
  threadId?: number;
  frame: number;
  scope?: string;
} {
  return {
    threadId: args.threadId,
    frame: args.frame ?? 0,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  };
}

function requireArgument<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new Error(`Argument '${name}' is required for debug action '${action}'.`);
  return value;
}
