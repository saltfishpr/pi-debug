import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugConfiguration } from "../config/launch-config.js";
import { DebugError } from "../debug/errors.js";
import type {
  BreakpointsSnapshot,
  ExecutionOutcome,
  FunctionBreakpointsResult,
  Inspection,
  Page,
  SessionSnapshot,
  SourceBreakpointsResult,
  StackResult,
  StopResult,
  ThreadSnapshot,
  VariablesResult,
} from "../debug/types.js";

export function formatConfigurationsResult(configurations: DebugConfiguration[]) {
  return {
    configurations: configurations.map(({ name, type, request }) => ({ name, type, request })),
  };
}

const MAX_SNAPSHOT_THREADS = 50;

type FormattedSessionSnapshot = SessionSnapshot & {
  totalThreads: number;
  omittedThreads?: number;
};

export function formatSessionSnapshot(snapshot: SessionSnapshot): FormattedSessionSnapshot {
  const sorted = [...snapshot.threads].sort(
    (a, b) => Number(b.state === "stopped") - Number(a.state === "stopped") || a.id - b.id,
  );
  const total = sorted.length;
  const threads = sorted.slice(0, MAX_SNAPSHOT_THREADS);
  const omitted = total - threads.length;
  return {
    ...snapshot,
    threads,
    totalThreads: total,
    ...(omitted > 0 ? { omittedThreads: omitted } : {}),
  };
}

export function formatExecutionOutcome(result: ExecutionOutcome) {
  return "snapshot" in result ? { ...result, snapshot: formatSessionSnapshot(result.snapshot) } : result;
}

function formatBreakpointsSnapshot(snapshot: BreakpointsSnapshot) {
  return {
    source: snapshot.source,
    ...(snapshot.function ? { function: snapshot.function } : {}),
    ...(snapshot.exception ? { exception: snapshot.exception } : {}),
  };
}

export function formatSetBreakpointsResult(result: SourceBreakpointsResult) {
  return { sourceBreakpoints: result };
}

export function formatSetFunctionBreakpointsResult(result: FunctionBreakpointsResult) {
  return { functionBreakpoints: result };
}

export function formatListBreakpointsResult(snapshot: BreakpointsSnapshot) {
  return formatBreakpointsSnapshot(snapshot);
}

export function formatStartResult(result: { execution: ExecutionOutcome; breakpoints: BreakpointsSnapshot }) {
  return {
    execution: formatExecutionOutcome(result.execution),
    breakpoints: formatBreakpointsSnapshot(result.breakpoints),
  };
}

export function formatStopResult(result: StopResult) {
  return result.kind === "noSession" ? result : { ...result, snapshot: formatSessionSnapshot(result.snapshot) };
}

export function formatThreadSnapshots(page: Page<ThreadSnapshot>) {
  const { count: _count, ...result } = page;
  return result;
}

export function formatStackTraceResult(result: StackResult) {
  const { count: _count, ...pagination } = result.page;
  return {
    threadId: result.threadId,
    revision: result.revision,
    stack: {
      ...pagination,
      items: result.body.stackFrames.map((frame, index) => ({
        frameIndex: result.page.start + index,
        name: frame.name,
        source: frame.source,
        line: frame.line,
        column: frame.column,
      })),
    },
  };
}

const MAX_VALUE_LENGTH = 2048;

// Truncate by Unicode code points so multi-unit characters are not split, keeping
// total length within MAX_VALUE_LENGTH including the truncation marker.
function formatValue(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_VALUE_LENGTH) return value;
  // upperSuffix length is an upper bound; suffix is ASCII so length equals code points.
  const upperSuffix = `...[truncated ${chars.length} chars]`;
  const keep = Math.max(0, MAX_VALUE_LENGTH - upperSuffix.length);
  const suffix = `...[truncated ${chars.length - keep} chars]`;
  return chars.slice(0, keep).join("") + suffix;
}

function formatVariable(
  value: Pick<DebugProtocol.Variable, "type" | "variablesReference" | "namedVariables" | "indexedVariables">,
) {
  return {
    type: value.type,
    variablesReference: value.variablesReference > 0 ? value.variablesReference : undefined,
    namedVariables: value.namedVariables,
    indexedVariables: value.indexedVariables,
  };
}

export function formatVariablesResult(result: VariablesResult) {
  const { count: _count, ...pagination } = result.page;
  return {
    threadId: result.threadId,
    revision: result.revision,
    variables: {
      ...pagination,
      items: result.body.variables.map((variable) => ({
        name: variable.name,
        value: formatValue(variable.value),
        ...formatVariable(variable),
      })),
    },
  };
}

export function formatEvaluateResult(result: Inspection<DebugProtocol.EvaluateResponse["body"]>) {
  return {
    threadId: result.threadId,
    revision: result.revision,
    result: {
      value: formatValue(result.body.result),
      ...formatVariable(result.body),
    },
  };
}

function escapeControls(text: string): string {
  return text.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function formatOutputResult(page: Page<DebugProtocol.OutputEvent["body"]>): string {
  let text = page.items
    .map((event) => {
      const category = escapeControls(event.category ?? "output").replaceAll("\n", "\\n");
      const lines = escapeControls(event.output).split("\n");
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      return lines.map((line) => `${category} | ${line}`).join("\n");
    })
    .join("\n");
  if (page.nextStart !== undefined) {
    text += `\n\n[debug: Showing output events ${page.start + 1}-${page.start + page.items.length} of ${page.total}. Use start=${page.nextStart} to continue.]`;
  }
  return text;
}

export function resultText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export function errorText(error: unknown, action: string): string {
  return JSON.stringify({
    error: {
      code: error instanceof DebugError ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      action,
      details: error instanceof DebugError ? error.details : undefined,
    },
  });
}
