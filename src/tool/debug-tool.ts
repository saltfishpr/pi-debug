import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugSessionManager } from "../debug/session-manager.js";
import { debugParameters, type DebugArguments } from "./schema.js";

export function registerDebugTool(pi: ExtensionAPI, manager: DebugSessionManager): void {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description: [
      "Drive a debug session against the target program: install breakpoints, control execution, and inspect stopped state.",
    ].join(" "),
    promptSnippet: "Inspect runtime state and trace execution to diagnose application behavior",
    parameters: debugParameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await executeDebugAction(manager, args, ctx.cwd, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: undefined, // TODO
      };
    },
  });
}

async function executeDebugAction(
  manager: DebugSessionManager,
  args: DebugArguments,
  cwd: string,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (args.action) {
    case "configurations":
      return manager.configurations(cwd);
    case "start":
      return manager.start(
        requireArgument(args.configuration, "configuration", args.action),
        { breakpoints: args.breakpoints ?? [], waitMs: args.waitMs ?? 1_000 },
        cwd,
        signal,
      );
    case "stop":
      return manager.stop();
  }

  const session = manager.getSession();
  switch (args.action) {
    case "status":
      return session.status();
    case "set_breakpoints":
      return session.setBreakpoints(
        requireArgument(args.file, "file", args.action),
        requireArgument(args.lines, "lines", args.action),
        signal,
      );
    case "continue":
      return session.continue(executionOptions(args), signal);
    case "next":
      return session.next(executionOptions(args), signal);
    case "step_in":
      return session.stepIn(executionOptions(args), signal);
    case "step_out":
      return session.stepOut(executionOptions(args), signal);
    case "pause":
      return session.pause({ threadId: args.threadId, waitMs: args.waitMs ?? 1_000 }, signal);
    case "wait":
      return session.wait({ threadId: args.threadId, waitMs: args.waitMs ?? 1_000 }, signal);
    case "threads":
      return session.threads({ start: args.start ?? 0, count: args.count ?? 50 }, signal);
    case "stack_trace":
      return session.stackTrace({ threadId: args.threadId, start: args.start ?? 0, count: args.count ?? 20 }, signal);
    case "variables":
      return session.variables(variablesOptions(args), signal);
    case "evaluate":
      return session.evaluate(
        {
          threadId: args.threadId,
          frame: args.frame ?? 0,
          expression: requireArgument(args.expression, "expression", args.action),
        },
        signal,
      );
    case "inspect":
      return session.inspect({ ...variablesOptions(args), stackStart: 0, stackCount: 20 }, signal);
  }
}

function executionOptions(args: DebugArguments): {
  threadId?: number;
  singleThread: boolean;
  waitMs: number;
} {
  return { threadId: args.threadId, singleThread: args.singleThread ?? false, waitMs: args.waitMs ?? 1_000 };
}

function variablesOptions(args: DebugArguments): {
  threadId?: number;
  frame: number;
  scope: string;
  depth: number;
  maxChildren: number;
} {
  return {
    threadId: args.threadId,
    frame: args.frame ?? 0,
    scope: args.scope ?? "locals",
    depth: args.depth ?? 2,
    maxChildren: args.maxChildren ?? 50,
  };
}

function requireArgument<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new Error(`Argument '${name}' is required for debug action '${action}'.`);
  return value;
}
