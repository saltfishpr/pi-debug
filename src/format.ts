import type { DebugProtocol } from "./dap/index.js";
import type { DebugConfiguration } from "./launchConfig.js";
import type { BreakpointsSnapshot, BreakpointStatus, DebugSession, ResumeOutcome, SessionState, StopSnapshot } from "./session/index.js";

/**
 * Format L5's structured results into compact, self-describing text for the
 * agent that calls the `debug` tool.
 *
 * Two rules drive everything here:
 * 1. Every result answers "where am I / what can I do next" and prints the
 *    handles (frameId, ref, threadId, sessionId) the agent needs for follow-ups.
 * 2. Output is budgeted: lists are capped and truncation is stated explicitly,
 *    so a deep stack or a huge object can never flood the context window.
 */

const MAX_FRAMES = 10;
const MAX_VARS = 30;
const MAX_OUTPUT_LINES = 40;
const MAX_VALUE_CHARS = 200;

function truncate(value: string, max = MAX_VALUE_CHARS): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function frameLocation(frame: DebugProtocol.StackFrame): string {
  const file = frame.source?.name ?? frame.source?.path ?? "<unknown>";
  return `${file}:${frame.line}`;
}

function configLabel(config: DebugConfiguration): string {
  const name = config.name ? ` "${config.name}"` : "";
  return `${config.type} ${config.request}${name}`;
}

export function formatStop(snapshot: StopSnapshot, sessionId: string): string {
  const lines: string[] = [];
  const detail = snapshot.description ?? snapshot.text;
  lines.push(`● stopped: ${snapshot.reason}${detail ? ` — ${detail}` : ""} (thread ${snapshot.threadId})`);

  const shown = snapshot.frames.slice(0, MAX_FRAMES);
  shown.forEach((frame, index) => {
    lines.push(`  #${index} ${frameLocation(frame)}  ${frame.name}  [frameId=${frame.id}]`);
  });
  const hidden = snapshot.frames.length - shown.length;
  if (hidden > 0) {
    lines.push(`  … (+${hidden} more frames — use action "stack")`);
  }
  lines.push(`  session=${sessionId} state=stopped`);
  return lines.join("\n");
}

export function formatResume(outcome: ResumeOutcome, sessionId: string): string {
  switch (outcome.outcome) {
    case "stopped":
      return formatStop(outcome.snapshot, sessionId);
    case "terminated":
      return `■ terminated (exit code ${outcome.exitCode ?? "unknown"})  session=${sessionId}`;
    case "timeout":
      return `⏲ still running after the wait timeout — the program did not stop (possible long task or infinite loop). Use action "pause" to interrupt it, or run the same action again to keep waiting.  session=${sessionId}`;
  }
}

function breakpointMark(verified?: DebugProtocol.Breakpoint): string {
  if (!verified) {
    return "· pending";
  }
  return verified.verified ? "✓ verified" : `✗ unverified${verified.message ? ` (${verified.message})` : ""}`;
}

/** Render the condition / hit-count / logpoint annotations of a requested breakpoint. */
function breakpointConditions(requested: { condition?: string; hitCondition?: string; logMessage?: string }): string {
  const parts: string[] = [];
  if (requested.condition) parts.push(`if ${requested.condition}`);
  if (requested.hitCondition) parts.push(`hit ${requested.hitCondition}`);
  if (requested.logMessage) parts.push(`log ${JSON.stringify(requested.logMessage)} (logpoint)`);
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function breakpointId(verified?: DebugProtocol.Breakpoint): string {
  return verified?.id !== undefined ? `  [id=${verified.id}]` : "";
}

export function formatBreakpoints(path: string, statuses: BreakpointStatus<DebugProtocol.SourceBreakpoint>[]): string {
  if (statuses.length === 0) {
    return `breakpoints @ ${path}: none`;
  }
  const lines = statuses.map(({ requested, verified }) => {
    const line = verified?.line ?? requested.line;
    return `  ${line} ${breakpointMark(verified)}${breakpointConditions(requested)}${breakpointId(verified)}`;
  });
  return [`breakpoints @ ${path}`, ...lines].join("\n");
}

export function formatFunctionBreakpoints(statuses: BreakpointStatus<DebugProtocol.FunctionBreakpoint>[]): string {
  if (statuses.length === 0) {
    return "function breakpoints: none";
  }
  const lines = statuses.map(
    ({ requested, verified }) => `  ${requested.name} ${breakpointMark(verified)}${breakpointConditions(requested)}${breakpointId(verified)}`,
  );
  return ["function breakpoints:", ...lines].join("\n");
}

export function formatExceptionBreakpoints(exception: BreakpointsSnapshot["exception"]): string {
  const { filters, filterOptions, available } = exception;
  if (available.length === 0) {
    return "exception breakpoints: not supported by this adapter";
  }
  const enabled = new Set([...filters, ...filterOptions.map((option) => option.filterId)]);
  const conditionById = new Map(filterOptions.map((option) => [option.filterId, option.condition]));
  const lines = available.map((filter) => {
    const box = enabled.has(filter.filter) ? "[x]" : "[ ]";
    const condition = conditionById.get(filter.filter);
    const conditionMark = condition ? `  if ${condition}` : "";
    const flags = [filter.default ? "default" : "", filter.supportsCondition ? "cond" : ""].filter(Boolean).join(",");
    const flagMark = flags ? ` (${flags})` : "";
    return `  ${box} ${filter.filter}${flagMark} — ${filter.label}${conditionMark}`;
  });
  return ["exception breakpoints: ([x] = on)", ...lines].join("\n");
}

export function formatBreakpointsSnapshot(snapshot: BreakpointsSnapshot): string {
  const sections: string[] = [];
  if (snapshot.source.length === 0) {
    sections.push("source breakpoints: none");
  } else {
    for (const { path, breakpoints } of snapshot.source) {
      sections.push(formatBreakpoints(path, breakpoints));
    }
  }
  sections.push(formatFunctionBreakpoints(snapshot.function));
  sections.push(formatExceptionBreakpoints(snapshot.exception));
  return sections.join("\n");
}

export function formatStack(frames: DebugProtocol.StackFrame[]): string {
  if (frames.length === 0) {
    return "stack: empty";
  }
  const shown = frames.slice(0, MAX_FRAMES);
  const lines = shown.map((frame, index) => `  #${index} ${frameLocation(frame)}  ${frame.name}  [frameId=${frame.id}]`);
  const hidden = frames.length - shown.length;
  if (hidden > 0) {
    lines.push(`  … (+${hidden} more — raise "levels" to see more)`);
  }
  return ["stack:", ...lines].join("\n");
}

export function formatScopes(scopes: DebugProtocol.Scope[]): string {
  if (scopes.length === 0) {
    return "scopes: none";
  }
  const lines = scopes.map((scope) => `  ${scope.name}  [ref=${scope.variablesReference}]`);
  return ["scopes:", ...lines].join("\n");
}

export function formatVariables(variables: DebugProtocol.Variable[]): string {
  if (variables.length === 0) {
    return "variables: none";
  }
  const shown = variables.slice(0, MAX_VARS);
  const lines = shown.map((variable) => {
    const type = variable.type ? ` : ${variable.type}` : "";
    const expand = variable.variablesReference > 0 ? `  [ref=${variable.variablesReference}]` : "";
    return `  ${variable.name} = ${truncate(variable.value)}${type}${expand}`;
  });
  const hidden = variables.length - shown.length;
  if (hidden > 0) {
    lines.push(`  … (+${hidden} more — narrow with action "eval")`);
  }
  return ["variables:", ...lines].join("\n");
}

export function formatEvaluate(body: DebugProtocol.EvaluateResponse["body"]): string {
  const type = body.type ? ` : ${body.type}` : "";
  const expand = body.variablesReference > 0 ? `  [ref=${body.variablesReference}]` : "";
  return `=> ${truncate(body.result)}${type}${expand}`;
}

export function formatThreads(threads: DebugProtocol.Thread[], currentThreadId?: number): string {
  if (threads.length === 0) {
    return "threads: none";
  }
  const lines = threads.map((thread) => {
    const marker = thread.id === currentThreadId ? "*" : " ";
    return `  ${marker} ${thread.id}  ${thread.name}`;
  });
  return ["threads: (* = last stopped)", ...lines].join("\n");
}

export function formatOutput(events: readonly DebugProtocol.OutputEvent[]): string {
  if (events.length === 0) {
    return "output: none";
  }
  const shown = events.slice(-MAX_OUTPUT_LINES);
  const lines = shown.map((event) => {
    const category = event.body.category && event.body.category !== "console" ? `[${event.body.category}] ` : "";
    return `  ${category}${event.body.output.replace(/\n$/, "")}`;
  });
  const hidden = events.length - shown.length;
  const header = hidden > 0 ? `output (last ${shown.length} of ${events.length}):` : "output:";
  return [header, ...lines].join("\n");
}

export function formatSessionSummary(session: DebugSession): string {
  const capabilitySummary = summarizeCapabilities(session);
  return `session=${session.id} state=${session.state} config=${configLabel(session.configuration)}${capabilitySummary}`;
}

export function formatSessions(sessions: readonly DebugSession[], activeId?: string): string {
  if (sessions.length === 0) {
    return 'sessions: none (use action "start")';
  }
  const lines = sessions.map((session) => {
    const marker = session.id === activeId ? "*" : " ";
    const parent = session.parentId ? `  (parent ${session.parentId})` : "";
    return `  ${marker} ${session.id}  ${session.state}  ${configLabel(session.configuration)}${parent}`;
  });
  return ["sessions: (* = active)", ...lines].join("\n");
}

export function formatTerminated(sessionId: string, state: SessionState): string {
  return `■ session=${sessionId} state=${state}`;
}

function summarizeCapabilities(session: DebugSession): string {
  const caps = session.capabilities;
  const flags: string[] = [];
  if (caps.supportsConfigurationDoneRequest) flags.push("configurationDone");
  if (caps.supportsConditionalBreakpoints) flags.push("conditionalBreakpoints");
  if (caps.supportsEvaluateForHovers) flags.push("evaluate");
  if (caps.supportsStepBack) flags.push("stepBack");
  return flags.length > 0 ? ` capabilities=${flags.join(",")}` : "";
}
