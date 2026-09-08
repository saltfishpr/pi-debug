import type { DebugProtocol } from "@vscode/debugprotocol";
import type { BreakpointSnapshot, FunctionBreakpointSnapshot, OutputChunk, SessionSnapshot, StopResult, ThreadSnapshot } from "./session";

type Field = [string, unknown];

const quote = (value: string): string => JSON.stringify(value);
const present = <T>(value: T | undefined): value is T => value !== undefined;

/** Serializes a string as a quoted scalar in the response's YAML-like format. */
function scalar(value: string): string {
  return value.includes("\n") || value.includes("\r") ? quote(value) : quote(value);
}

/** Renders a field as either an inline scalar or a literal block, preserving trailing newlines. */
function block(key: string, value: string, indent = ""): string[] {
  if (!value.includes("\n") || /^\s*$/.test(value)) return [`${indent}${key}: ${scalar(value)}`];
  const trailing = value.match(/\n+$/)?.[0].length ?? 0;
  const marker = trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+";
  const content = value.split("\n");
  if (trailing > 0) content.pop();
  return [`${indent}${key}: ${marker}`, ...content.map((line) => `${indent}  ${line}`)];
}

/** Formats a value for the YAML-like response, quoting strings unless their field has a safe bare-value convention. */
function formatValue(value: unknown, key?: string): string {
  if (typeof value === "string") {
    if (["action", "buffer", "outcome", "request", "state"].includes(key ?? "")) return value;
    if (key === "sessionId" && /^[A-Za-z][A-Za-z0-9-]*$/.test(value)) return value;
    return scalar(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return quote(String(value));
}

/** Renders defined fields as one list item containing an inline flow mapping. */
function flow(fields: Field[], indent = "  "): string[] {
  const rendered = fields.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${formatValue(value, key)}`);
  return [`${indent}- { ${rendered.join(", ")} }`];
}

/** Renders defined fields as a list item, expanding long or multiline values into block form. */
function entry(fields: Field[], indent = "  "): string[] {
  const usable = fields.filter(([, value]) => value !== undefined);
  const inline = usable.every(([, value]) => typeof value !== "string" || !value.includes("\n"));
  const oneLine = `{ ${usable.map(([key, value]) => `${key}: ${formatValue(value, key)}`).join(", ")} }`;
  if (inline && [...indent, "- ", oneLine].join("").length <= 120) return [`${indent}- ${oneLine}`];
  const lines: string[] = [];
  for (const [index, [key, value]] of usable.entries()) {
    const prefix = index === 0 ? `${indent}- ` : `${indent}  `;
    if (typeof value === "string" && value.includes("\n")) {
      const nested = block(key, value, prefix);
      lines.push(...nested);
    } else lines.push(`${prefix}${key}: ${formatValue(value, key)}`);
  }
  return lines;
}

function context(sessionId: string, values: { threadId?: number; frameId?: number; variablesReference?: number } = {}): string[] {
  return [
    `sessionId: ${sessionId}`,
    values.threadId !== undefined ? `threadId: ${values.threadId}` : undefined,
    values.frameId !== undefined ? `frameId: ${values.frameId}` : undefined,
    values.variablesReference !== undefined ? `variablesReference: ${values.variablesReference}` : undefined,
  ].filter(present);
}

function location(source: string | undefined, line: number | undefined, column: number | undefined): string {
  if (!source) return "<unknown>";
  return `${source}${line !== undefined && line > 0 ? `:${line}` : ""}${column !== undefined && column > 0 ? `:${column}` : ""}`;
}

function elapsed(observedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1000));
  if (seconds === 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function configuration(snapshot: SessionSnapshot): string[] {
  const fields: Field[] = [
    ["name", snapshot.configuration.name],
    ["type", snapshot.configuration.type],
    ["request", snapshot.configuration.request],
  ];
  const usable = fields.filter(([, value]) => value !== undefined);
  if (usable.length === 0) return [];
  return ["configuration:", ...usable.map(([key, value]) => `  ${key}: ${key === "type" || key === "request" ? value : formatValue(value, key)}`)];
}

function sessionSnapshot(snapshot: SessionSnapshot, now: number): string[] {
  const lines = [`state: ${snapshot.state}`];
  if (snapshot.threads && snapshot.threads.total > 0)
    lines.push(
      "threads:",
      `  stopped: ${snapshot.threads.stopped}`,
      `  total: ${snapshot.threads.total}`,
      `  observed: ${quote(elapsed(snapshot.threads.observedAt, now))}`,
    );
  lines.push(...context(snapshot.id, { threadId: snapshot.stop?.threadId, frameId: snapshot.stop?.focusedFrameId }), ...configuration(snapshot));
  return lines;
}

export function formatListSessions(activeId: string | undefined, sessions: SessionSnapshot[]): string {
  const lines = ["sessions:"];
  if (sessions.length === 0) return "sessions: []";
  for (const session of sessions)
    lines.push(
      ...flow([
        ["sessionId", session.id],
        ["state", session.state],
        ["active", activeId === session.id ? true : undefined],
        ["name", session.configuration.name],
      ]),
    );
  return lines.join("\n");
}

export function formatStatus(snapshot: SessionSnapshot, now: number): string {
  return sessionSnapshot(snapshot, now).join("\n");
}

export function formatStopSession(sessionId: string, state: string): string {
  return [`outcome: disconnected`, `state: ${state}`, ...context(sessionId)].join("\n");
}

function verification(breakpoints: Array<{ verified: boolean }>): string | undefined {
  if (breakpoints.length === 0) return undefined;
  const verified = breakpoints.filter((bp) => bp.verified).length;
  return `verification: { verified: ${verified}, unverified: ${breakpoints.length - verified} }`;
}

function breakpointFields(bp: BreakpointSnapshot): Field[] {
  return [
    ["line", bp.line],
    ["actualLine", bp.actualLine !== bp.line ? bp.actualLine : undefined],
    ["verified", bp.verified],
    ["breakpointId", bp.id],
    ["condition", bp.condition],
    ["hitCondition", bp.hitCondition],
    ["logMessage", bp.logMessage],
    ["message", bp.message],
  ];
}

function functionBreakpointFields(bp: FunctionBreakpointSnapshot): Field[] {
  return [
    ["name", bp.name],
    ["verified", bp.verified],
    ["breakpointId", bp.id],
    ["condition", bp.condition],
    ["hitCondition", bp.hitCondition],
    ["message", bp.message],
  ];
}

function sourceBreakpoints(outcome: string, sessionId: string, source: string, breakpoints: BreakpointSnapshot[]): string {
  const lines = [`outcome: ${outcome}`];
  const summary = verification(breakpoints);
  if (summary) lines.push(summary);
  lines.push(`source: ${quote(source)}`);
  if (breakpoints.length === 0) lines.push("breakpoints: []");
  else lines.push("breakpoints:", ...breakpoints.flatMap((bp) => entry(breakpointFields(bp))));
  lines.push(...context(sessionId));
  return lines.join("\n");
}

export function formatAddBreakpoints(sessionId: string, source: string, breakpoints: BreakpointSnapshot[]): string {
  return sourceBreakpoints("updated", sessionId, source, breakpoints);
}

export function formatRemoveBreakpoints(sessionId: string, source: string, breakpoints: BreakpointSnapshot[]): string {
  return sourceBreakpoints("updated", sessionId, source, breakpoints);
}

function functionBreakpoints(outcome: string, sessionId: string, breakpoints: FunctionBreakpointSnapshot[]): string {
  const lines = [`outcome: ${outcome}`];
  const summary = verification(breakpoints);
  if (summary) lines.push(summary);
  if (breakpoints.length === 0) lines.push("functionBreakpoints: []");
  else lines.push("functionBreakpoints:", ...breakpoints.flatMap((bp) => entry(functionBreakpointFields(bp))));
  lines.push(...context(sessionId));
  return lines.join("\n");
}

export function formatAddFunctionBreakpoints(sessionId: string, breakpoints: FunctionBreakpointSnapshot[]): string {
  return functionBreakpoints("updated", sessionId, breakpoints);
}

export function formatRemoveFunctionBreakpoints(sessionId: string, breakpoints: FunctionBreakpointSnapshot[]): string {
  return functionBreakpoints("updated", sessionId, breakpoints);
}

export function formatListBreakpoints(
  sessionId: string,
  bySource: Record<string, BreakpointSnapshot[]>,
  functionBreakpoints: FunctionBreakpointSnapshot[] | undefined,
  options: { source?: string; includeFunctions: boolean },
): string {
  const lines: string[] = ["sources:"];
  const sources = Object.entries(bySource).filter(([, bps]) => bps.length > 0);
  if (sources.length === 0) lines[0] = "sources: []";
  for (const [source, bps] of sources)
    lines.push(`  - source: ${quote(source)}`, "    breakpoints:", ...bps.flatMap((bp) => entry(breakpointFields(bp), "      ")));
  if (options.includeFunctions) {
    if (!functionBreakpoints?.length) lines.push("functionBreakpoints: []");
    else lines.push("functionBreakpoints:", ...functionBreakpoints.flatMap((bp) => entry(functionBreakpointFields(bp))));
  }
  if (options.includeFunctions === false) lines.push("includeFunctions: false");
  if (options.source !== undefined) lines.push(`filterSource: ${quote(options.source)}`);
  lines.push(...context(sessionId));
  return lines.join("\n");
}

function stopResult(sessionId: string, result: StopResult): string {
  const lines = [`state: ${result.state}`];
  if (result.state === "stopped") {
    if (result.reason !== undefined) lines.push(`reason: ${quote(result.reason)}`);
    if (result.description !== undefined) lines.push(`description: ${quote(result.description)}`);
    if (result.topFrame) {
      lines.push(
        `location: ${quote(location(result.topFrame.source, result.topFrame.line, result.topFrame.column))}`,
        `function: ${quote(result.topFrame.name)}`,
      );
      if (result.topFrame.snippet !== undefined) lines.push(...block("source", result.topFrame.snippet));
    }
  }
  lines.push(...context(sessionId, { threadId: result.threadId, frameId: result.topFrame?.frameId }));
  if (result.hitBreakpointIds?.length) lines.push(`hitBreakpointIds: [${result.hitBreakpointIds.join(", ")}]`);
  if (result.note !== undefined) lines.push("notes:", `  - ${quote(result.note)}`);
  return lines.join("\n");
}

export const formatContinue = (sessionId: string, result: StopResult): string => stopResult(sessionId, result);
export const formatNext = formatContinue;
export const formatStepIn = formatContinue;
export const formatStepOut = formatContinue;

export function formatPause(sessionId: string, threadId: number, state: string): string {
  return [`outcome: requested`, `state: ${state}`, ...context(sessionId, { threadId })].join("\n");
}

export function formatThreads(sessionId: string, threads: ThreadSnapshot[], start: number, total: number, levels?: number): string {
  const lines = threads.length
    ? [
        "threads:",
        ...threads.flatMap((thread) =>
          flow([
            ["threadId", thread.id],
            ["stopped", thread.stopped],
            ["name", thread.name],
          ]),
        ),
      ]
    : ["threads: []"];
  lines.push(`page: { start: ${start}, returned: ${threads.length}, total: ${total} }`, ...context(sessionId));
  if (threads.length > 0 && start + threads.length < total)
    lines.push(
      `more: { action: threads, sessionId: ${sessionId}, start: ${start + threads.length}${levels !== undefined && levels > 0 ? `, levels: ${levels}` : ""} }`,
    );
  return lines.join("\n");
}

export function formatStackTrace(sessionId: string, threadId: number | undefined, frames: DebugProtocol.StackFrame[], startFrame?: number): string {
  const lines = frames.length
    ? [
        "frames:",
        ...frames.flatMap((frame) =>
          flow([
            ["frameId", frame.id],
            ["function", frame.name],
            ["location", location(frame.source?.path, frame.line, frame.column)],
          ]),
        ),
      ]
    : ["frames: []"];
  if (startFrame !== undefined && startFrame !== 0) lines.push(`startFrame: ${startFrame}`);
  lines.push(...context(sessionId, { threadId }));
  return lines.join("\n");
}

export function formatSelectFrame(sessionId: string, snapshot: SessionSnapshot, frameId: number): string {
  return [`outcome: focused`, ...context(sessionId, { threadId: snapshot.stop?.threadId, frameId })].join("\n");
}

export function formatScopes(sessionId: string, frameId: number, scopes: DebugProtocol.Scope[]): string {
  const lines = scopes.length
    ? [
        "scopes:",
        ...scopes.flatMap((scope) =>
          flow([
            ["name", scope.name],
            ["variablesReference", scope.variablesReference > 0 ? scope.variablesReference : undefined],
            ["expensive", scope.expensive ? true : undefined],
          ]),
        ),
      ]
    : ["scopes: []"];
  lines.push(...context(sessionId, { frameId }));
  return lines.join("\n");
}

export function formatVariables(sessionId: string, variablesReference: number, variables: DebugProtocol.Variable[]): string {
  const lines = variables.length
    ? [
        "variables:",
        ...variables.flatMap((variable) =>
          entry([
            ["name", variable.name],
            ["value", variable.value],
            ["type", variable.type],
            ["variablesReference", variable.variablesReference > 0 ? variable.variablesReference : undefined],
          ]),
        ),
      ]
    : ["variables: []"];
  lines.push(...context(sessionId, { variablesReference }));
  return lines.join("\n");
}

export function formatEvaluate(sessionId: string, expression: string, frameId: number | undefined, body: DebugProtocol.EvaluateResponse["body"]): string {
  const lines = block("result", body.result);
  if (body.type !== undefined) lines.push(`type: ${quote(body.type)}`);
  if (body.variablesReference > 0) lines.push(`variablesReference: ${body.variablesReference}`);
  lines.push(`expression: ${quote(expression)}`, ...context(sessionId, { frameId }));
  return lines.join("\n");
}

export function formatOutput(sessionId: string, chunks: OutputChunk[], clear: boolean): string {
  const groups: Array<{ category: string; text: string }> = [];
  for (const chunk of chunks) {
    if (chunk.output.length === 0) continue;
    const last = groups.at(-1);
    if (last?.category === chunk.category) last.text += chunk.output;
    else groups.push({ category: chunk.category, text: chunk.output });
  }
  const lines = groups.length ? ["output:"] : ["output: []"];
  for (const group of groups) {
    if (group.text.includes("\n") && !/^\s*$/.test(group.text)) {
      lines.push(`  - category: ${quote(group.category)}`, ...block("text", group.text, "    "));
    } else
      lines.push(
        ...flow([
          ["category", group.category],
          ["text", group.text],
        ]),
      );
  }
  lines.push(...context(sessionId), `buffer: ${clear ? "cleared" : "retained"}`);
  return lines.join("\n");
}
