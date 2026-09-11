import { formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import type { DebugProtocol } from "./dap/index.js";
import type { DebugConfiguration } from "./launchConfig.js";
import type { BreakpointsSnapshot, BreakpointStatus, DebugSession, ResumeOutcome, SessionState, StopSnapshot } from "./session/index.js";

const MAX_FRAMES = 10;
const MAX_VARS = 30;
const MAX_VALUE_CHARS = 200;

function compact(value: string, max = MAX_VALUE_CHARS): string {
  const oneLine = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function frameLocation(frame: DebugProtocol.StackFrame): string {
  const source = frame.source?.path ?? frame.source?.name ?? "<unknown>";
  return `${source}:${frame.line}`;
}

function configurationFields(config: DebugConfiguration): string {
  return `config=${JSON.stringify(config.name ?? "<unnamed>")} type=${config.type} request=${config.request}`;
}

function sessionLine(session: DebugSession): string {
  return sessionStateLine(session.id, session.state, session.getStopState()?.threadId);
}

function sessionStateLine(sessionId: string, state: SessionState, threadId?: number): string {
  const fields = [`sessionId=${sessionId}`, `state=${state}`];
  if (state === "stopped" && threadId !== undefined) fields.push(`threadId=${threadId}`);
  return fields.join(" ");
}

function stopLines(snapshot: StopSnapshot): string[] {
  const detail = snapshot.description ?? snapshot.text;
  const breakpoints = snapshot.hitBreakpointIds?.length ? ` breakpoints=${snapshot.hitBreakpointIds.join(",")}` : "";
  const lines = [`stopped: ${snapshot.reason}${detail ? `; ${compact(detail)}` : ""}${breakpoints}`, ...frameLines(snapshot.frames)];
  return lines;
}

function frameLines(frames: DebugProtocol.StackFrame[]): string[] {
  if (frames.length === 0) return ["stack: none"];

  const shown = frames.slice(0, MAX_FRAMES);
  const lines = [
    "stack:",
    ...shown.map((frame, index) => `  ${index === 0 ? "*" : " "} #${index} ${frame.name} at ${frameLocation(frame)} frameId=${frame.id}`),
  ];
  if (shown.length < frames.length) lines.push(`  ... ${frames.length - shown.length} more frames; use stack_trace with a larger levels value`);
  return lines;
}

export function formatSessionSummary(session: DebugSession): string {
  const lines = [sessionLine(session), configurationFields(session.configuration)];
  const stop = session.getStopState();
  if (stop) lines.push(...stopLines(stop));
  return lines.join("\n");
}

function breakpointStatus(verified?: DebugProtocol.Breakpoint): string {
  if (!verified) return "pending";
  if (verified.verified) return "verified";
  return `unverified${verified.message ? ` message=${JSON.stringify(compact(verified.message))}` : ""}`;
}

function breakpointOptions(requested: { condition?: string; hitCondition?: string; logMessage?: string }): string {
  const fields: string[] = [];
  if (requested.condition) fields.push(`condition=${JSON.stringify(requested.condition)}`);
  if (requested.hitCondition) fields.push(`hitCondition=${JSON.stringify(requested.hitCondition)}`);
  if (requested.logMessage) fields.push(`logMessage=${JSON.stringify(requested.logMessage)}`);
  return fields.length === 0 ? "" : ` ${fields.join(" ")}`;
}

function breakpointId(verified?: DebugProtocol.Breakpoint): string {
  return verified?.id === undefined ? "" : ` id=${verified.id}`;
}

function sourceBreakpointLines(path: string, statuses: BreakpointStatus<DebugProtocol.SourceBreakpoint>[]): string[] {
  return statuses.map(({ requested, verified }) => {
    const actualLine = verified?.line !== undefined && verified.line !== requested.line ? ` actualLine=${verified.line}` : "";
    return `  ${path}:${requested.line} ${breakpointStatus(verified)}${actualLine}${breakpointId(verified)}${breakpointOptions(requested)}`;
  });
}

function functionBreakpointLines(statuses: BreakpointStatus<DebugProtocol.FunctionBreakpoint>[]): string[] {
  return statuses.map(({ requested, verified }) => `  ${requested.name} ${breakpointStatus(verified)}${breakpointId(verified)}${breakpointOptions(requested)}`);
}

function exceptionBreakpointLines(exception: BreakpointsSnapshot["exception"]): string[] {
  const { filters, filterOptions, available } = exception;
  if (available.length === 0) return ["exception breakpoints: unsupported"];

  const enabled = new Set([...filters, ...filterOptions.map((option) => option.filterId)]);
  const conditionById = new Map(filterOptions.map((option) => [option.filterId, option.condition]));
  return [
    "exception breakpoints:",
    ...available.map((filter) => {
      const fields = [enabled.has(filter.filter) ? "enabled" : "disabled", `label=${JSON.stringify(filter.label)}`];
      if (filter.default) fields.push("default");
      if (filter.supportsCondition) fields.push("supportsCondition=true");
      const condition = conditionById.get(filter.filter);
      if (condition) fields.push(`condition=${JSON.stringify(condition)}`);
      return `  ${filter.filter} ${fields.join(" ")}`;
    }),
  ];
}

export function formatBreakpoints(path: string, statuses: BreakpointStatus<DebugProtocol.SourceBreakpoint>[], session: DebugSession): string {
  const body = statuses.length === 0 ? [`source breakpoints: none for ${path}`] : ["source breakpoints:", ...sourceBreakpointLines(path, statuses)];
  return [sessionLine(session), ...body].join("\n");
}

export function formatFunctionBreakpoints(statuses: BreakpointStatus<DebugProtocol.FunctionBreakpoint>[], session: DebugSession): string {
  const body = statuses.length === 0 ? ["function breakpoints: none"] : ["function breakpoints:", ...functionBreakpointLines(statuses)];
  return [sessionLine(session), ...body].join("\n");
}

export function formatExceptionBreakpoints(exception: BreakpointsSnapshot["exception"], session: DebugSession): string {
  return [sessionLine(session), ...exceptionBreakpointLines(exception)].join("\n");
}

export function formatBreakpointsSnapshot(snapshot: BreakpointsSnapshot, session: DebugSession): string {
  const sourceLines = snapshot.source.flatMap(({ path, breakpoints }) => sourceBreakpointLines(path, breakpoints));
  const functionLines = functionBreakpointLines(snapshot.function);
  return [
    sessionLine(session),
    ...(sourceLines.length === 0 ? ["source breakpoints: none"] : ["source breakpoints:", ...sourceLines]),
    ...(functionLines.length === 0 ? ["function breakpoints: none"] : ["function breakpoints:", ...functionLines]),
    ...exceptionBreakpointLines(snapshot.exception),
  ].join("\n");
}

export function formatResume(outcome: ResumeOutcome, sessionId: string): string {
  switch (outcome.outcome) {
    case "stopped":
      return formatStop(outcome.snapshot, sessionId);
    case "terminated": {
      const exitCode = outcome.exitCode === undefined ? "" : ` exitCode=${outcome.exitCode}`;
      return `sessionId=${sessionId} state=terminated${exitCode}`;
    }
    case "timeout":
      return `sessionId=${sessionId} state=running\ntimeout: program is still running`;
  }
}

export function formatStop(snapshot: StopSnapshot, sessionId: string): string {
  return [sessionStateLine(sessionId, "stopped", snapshot.threadId), ...stopLines(snapshot)].join("\n");
}

export function formatThreads(threads: DebugProtocol.Thread[], session: DebugSession): string {
  const currentThreadId = session.getStopState()?.threadId;
  const body =
    threads.length === 0
      ? ["threads: none"]
      : ["threads:", ...threads.map((thread) => `  ${thread.id === currentThreadId ? "*" : " "} threadId=${thread.id} name=${JSON.stringify(thread.name)}`)];
  return [sessionLine(session), ...body].join("\n");
}

export function formatStack(frames: DebugProtocol.StackFrame[], session: DebugSession): string {
  return [sessionLine(session), ...frameLines(frames)].join("\n");
}

export function formatScopes(scopes: DebugProtocol.Scope[], session: DebugSession): string {
  const body = scopes.length === 0 ? ["scopes: none"] : ["scopes:", ...scopes.map((scope) => `  ${scope.name} ref=${scope.variablesReference}`)];
  return [sessionLine(session), ...body].join("\n");
}

export function formatVariables(variables: DebugProtocol.Variable[], session: DebugSession): string {
  if (variables.length === 0) return `${sessionLine(session)}\nvariables: none`;

  const shown = variables.slice(0, MAX_VARS);
  const lines = shown.map((variable) => {
    const type = variable.type ? ` type=${JSON.stringify(variable.type)}` : "";
    const ref = variable.variablesReference > 0 ? ` ref=${variable.variablesReference}` : "";
    return `  ${variable.name} = ${compact(variable.value)}${type}${ref}`;
  });
  if (shown.length < variables.length) lines.push(`  ... ${variables.length - shown.length} more variables`);
  return [sessionLine(session), "variables:", ...lines].join("\n");
}

export function formatEvaluate(body: DebugProtocol.EvaluateResponse["body"] | undefined, session: DebugSession): string {
  if (!body) return `${sessionLine(session)}\nresult: none`;

  const type = body.type ? ` type=${JSON.stringify(body.type)}` : "";
  const ref = body.variablesReference > 0 ? ` ref=${body.variablesReference}` : "";
  return `${sessionLine(session)}\nresult: ${compact(body.result)}${type}${ref}`;
}

export function formatOutput(events: readonly DebugProtocol.OutputEvent[], session: DebugSession): string {
  const truncation = truncateTail(events.map((event) => event.body.output).join(""));
  const notice = truncation.truncated
    ? `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
    : "";
  return `${sessionLine(session)}\n\n${truncation.content}${notice}`;
}

export function formatSessions(sessions: readonly DebugSession[], activeId?: string): string {
  if (sessions.length === 0) return "sessions: none";

  const lines = sessions.map((session) => {
    const fields = [sessionLine(session)];
    if (session.id === activeId) fields.push("active=true");
    if (session.parentId) fields.push(`parent=${session.parentId}`);
    fields.push(configurationFields(session.configuration));
    return `  ${fields.join(" ")}`;
  });
  return ["sessions:", ...lines].join("\n");
}

export function formatStopRequest(sessionId: string, state: SessionState): string {
  return `${sessionStateLine(sessionId, state)}\nstop: requested`;
}
