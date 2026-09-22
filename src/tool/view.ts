import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugSessionManager } from "../debug/session-manager.js";
import type {
  Breakpoint,
  BreakpointSet,
  Evaluation,
  ExecutionOutcome,
  Frame,
  Inspection,
  Output,
  Page,
  Scope,
  SessionStatus,
  SetBreakpointsResult,
  StackTrace,
  StartResult,
  ThreadSnapshot,
  Variable,
  Variables,
} from "../debug/types.js";

const VALUE_LIMIT = 2_048;

function formatValue(value: string) {
  if (value.length <= VALUE_LIMIT) return { value };
  let end = VALUE_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { value: `${value.slice(0, end)}…`, valueTruncated: true };
}

function formatSource(source: DebugProtocol.Source | undefined) {
  return source && { path: source.path, name: source.name };
}

function formatFrame(frame: Frame) {
  return {
    frame: frame.index,
    name: frame.data.name,
    source: formatSource(frame.data.source),
    line: frame.data.line,
    column: frame.data.column,
  };
}

function formatThread(thread: ThreadSnapshot) {
  return {
    id: thread.id,
    name: thread.name,
    state: thread.state,
    ...(thread.stop
      ? {
          stop: {
            reason: thread.stop.event.reason,
            description: thread.stop.event.description,
            text: thread.stop.event.text,
            allThreadsStopped: thread.stop.event.allThreadsStopped,
            topFrame: thread.stop.topFrame && formatFrame(thread.stop.topFrame),
          },
        }
      : {}),
  };
}

function formatVariable(variable: Variable) {
  return {
    name: variable.name,
    ...formatValue(variable.value),
    type: variable.type,
    ...(variable.variablesReference > 0 ? { variablesReference: variable.variablesReference } : {}),
    namedVariables: variable.namedVariables,
    indexedVariables: variable.indexedVariables,
  };
}

function formatScope(scope: Scope) {
  return {
    name: scope.name,
    variablesReference: scope.variablesReference,
    expensive: scope.expensive,
    namedVariables: scope.namedVariables,
    indexedVariables: scope.indexedVariables,
  };
}

function formatBreakpoint(breakpoint: Breakpoint) {
  return {
    verified: breakpoint.verified,
    message: breakpoint.message,
    source: formatSource(breakpoint.source),
    line: breakpoint.line,
    column: breakpoint.column,
  };
}

function formatPage<T, V>(page: Page<T>, format: (item: T) => V) {
  return { ...page, items: page.items.map(format) };
}

function formatStatus(status: SessionStatus) {
  const threads = [...status.threads]
    .sort((left, right) => Number(right.state === "stopped") - Number(left.state === "stopped") || left.id - right.id)
    .slice(0, 50);

  return {
    state: status.state,
    configuration: status.configuration,
    capabilities: status.capabilities,
    threads: threads.map(formatThread),
    debuggeeExit: status.debuggeeExit,
  };
}

function formatExecutionOutcome(result: ExecutionOutcome) {
  switch (result.kind) {
    case "stopped":
      return { kind: result.kind, thread: formatThread(result.thread) };
    case "threadExited":
      return result;
    case "timeout":
    case "closed":
      return { kind: result.kind, status: formatStatus(result.status) };
  }
}

function formatBreakpointSet(set: BreakpointSet) {
  return { source: formatSource(set.source), breakpoints: set.breakpoints.map(formatBreakpoint) };
}

function formatVariables(result: Variables) {
  return {
    threadId: result.threadId,
    container:
      result.container.kind === "scope"
        ? { kind: "scope", frame: result.container.frameIndex, scope: formatScope(result.container.scope) }
        : result.container,
    variables: formatPage(result.variables, formatVariable),
  };
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatConfigurationsResult(result: Awaited<ReturnType<DebugSessionManager["configurations"]>>): string {
  return render(result);
}

export function formatStartResult(result: StartResult): string {
  return render({
    execution: formatExecutionOutcome(result.execution),
    breakpoints: result.breakpoints.map(formatBreakpointSet),
  });
}

export function formatStatusResult(result: SessionStatus): string {
  return render(formatStatus(result));
}

export function formatStopResult(result: Awaited<ReturnType<DebugSessionManager["stop"]>>): string {
  return render(result.kind === "closed" ? { kind: result.kind, status: formatStatus(result.status) } : result);
}

export function formatSetBreakpointsResult(result: SetBreakpointsResult): string {
  return render({ breakpoints: formatBreakpointSet(result.breakpoints) });
}

export function formatContinueResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}
export function formatNextResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}
export function formatStepInResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}
export function formatStepOutResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}
export function formatPauseResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}
export function formatWaitResult(result: ExecutionOutcome): string {
  return render(formatExecutionOutcome(result));
}

export function formatThreadsResult(result: Page<ThreadSnapshot>): string {
  return render(formatPage(result, formatThread));
}

export function formatStackTraceResult(result: StackTrace): string {
  return render({ threadId: result.threadId, stack: formatPage(result.stack, formatFrame) });
}

export function formatVariablesResult(result: Variables): string {
  return render(formatVariables(result));
}

export function formatEvaluateResult(result: Evaluation): string {
  return render({
    threadId: result.threadId,
    frame: result.frameIndex,
    ...formatValue(result.data.result),
    type: result.data.type,
    ...(result.data.variablesReference > 0 ? { variablesReference: result.data.variablesReference } : {}),
    namedVariables: result.data.namedVariables,
    indexedVariables: result.data.indexedVariables,
  });
}

export function formatInspectResult(result: Inspection): string {
  return render({
    thread: formatThread(result.thread),
    stack: formatPage(result.stack, formatFrame),
    selection: {
      frame: formatFrame(result.selection.frame),
      scopes: result.selection.scopes.map(formatScope),
      variables: result.selection.variables && formatVariables(result.selection.variables),
      sourceContext: result.selection.sourceContext,
    },
  });
}

function logText(value: string): string {
  // Escape terminal controls rather than allowing program output to alter the display.
  return value
    .replace(/\r\n/g, "\n")
    .replace(
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

export function formatOutputResult(result: Page<Output>): string {
  const output = result.items
    .map((entry) => {
      const prefix = `${entry.category ?? "output"} | `;
      const text = logText(entry.output);
      const endsWithNewline = text.endsWith("\n");
      const lines = text.split("\n");
      if (endsWithNewline) lines.pop();
      return `${lines.map((line) => `${prefix}${line}`).join("\n")}${endsWithNewline ? "\n" : ""}`;
    })
    .reduce((text, entry) => (text.length > 0 && !text.endsWith("\n") ? `${text}\n${entry}` : `${text}${entry}`), "");

  if (result.nextStart === undefined) return output;
  const start = result.start + 1;
  const end = result.start + result.items.length;
  return `${output}\n\n[debug: Showing output events ${start}-${end} of ${result.total}. Use start=${result.nextStart} to continue.]`;
}
