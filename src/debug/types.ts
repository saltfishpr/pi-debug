import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugConfiguration } from "../config/launch-config.js";

// Session lifecycle

/** Stable manager-assigned identity for one debug session. */
export type DebugSessionId = string;

/** The first reason that initiated session cleanup. */
export type SessionEndReason = { kind: "requested" } | { kind: "terminated" } | { kind: "error"; message: string };

/** Local control lifecycle; closed does not guarantee successful resource release. */
export type SessionState =
  | { state: "starting" }
  | { state: "active" }
  | { state: "closing"; reason: SessionEndReason }
  | { state: "closed"; reason: SessionEndReason; cleanupError?: string };

/** Debuggee exit information, independent of the session lifecycle. */
export interface DebuggeeExit {
  exitCode: number;
}

// Execution control

/** One active thread. A stopped thread's revision is the credential for inspecting its current suspended state. */
export type Thread =
  | { id: number; name?: string; state: "unknown" | "running" }
  | { id: number; name?: string; state: "stopped"; revision: number };

/** One observed stop and, when available, the thread selected for inspection. `event.threadId` identifies the trigger. */
export interface Stop {
  revision: number;
  event: DebugProtocol.StoppedEvent["body"];
  thread?: Extract<Thread, { state: "stopped" }>;
}

/** Select a thread and optionally require its current stop revision. */
export interface ThreadSelection {
  threadId?: number;
  revision?: number;
}

/** Supported execution commands, distinct from passive waiting. */
export type ExecuteAction = "continue" | "next" | "step_in" | "step_out" | "pause";

/** Execution selection and observation budget after the request succeeds. */
export interface ExecuteOptions {
  threadId?: number;
  singleThread?: boolean;
  waitMs: number;
}

/** Passive observation; revision excludes current stops at or below that value. */
export interface WaitOptions extends ThreadSelection {
  waitMs: number;
}

/** Public actions serialized when one session operation blocks another. */
export type SessionOperationAction =
  | ExecuteAction
  | "set_breakpoints"
  | "set_function_breakpoints"
  | "wait"
  | "threads"
  | "stack_trace"
  | "variables"
  | "evaluate";

/** A session operation visible to callers while it is in progress. */
export interface SessionOperation {
  action: SessionOperationAction;
  /** UTC timestamp captured when the operation entered the session's concurrency gate. */
  startedAt: string;
}

// Breakpoints

/** One breakpoint's position and optional conditions, with a one-based line number. */
export interface SourceBreakpointSpec {
  line: number;
  /** Adapter-evaluated expression; break only when it is truthy. */
  condition?: string;
  /** Adapter-evaluated hit-count expression, such as `>=5` or `%3`. */
  hitCondition?: string;
  /** Adapter-interpolated message emitted on hit; the debuggee does not stop. */
  logMessage?: string;
}

/** Source breakpoint replacement: `lines` fully replaces the file's breakpoints. */
export interface SourceBreakpoints {
  file: string;
  lines: SourceBreakpointSpec[];
}

/** One function breakpoint entry addressed by function name. */
export interface FunctionBreakpointSpec {
  name: string;
  /** Adapter-evaluated expression; break only when it is truthy. */
  condition?: string;
  /** Adapter-evaluated hit-count expression, such as `>=5` or `%3`. */
  hitCondition?: string;
}

/** Initial breakpoints installed during session startup, before observing execution. */
export interface InitialBreakpoints {
  source?: SourceBreakpoints[];
  function?: FunctionBreakpointSpec[];
}

/** One file's installed source breakpoints: the requested specs and the DAP status for each, in request order. */
export interface SourceBreakpointsResult {
  source: DebugProtocol.Source;
  specs: SourceBreakpointSpec[];
  breakpoints: DebugProtocol.Breakpoint[];
}

/** The installed function-breakpoint list: the requested specs and the DAP status for each, in request order. */
export interface FunctionBreakpointsResult {
  specs: FunctionBreakpointSpec[];
  breakpoints: DebugProtocol.Breakpoint[];
}

/** The installed exception-breakpoint filters; `breakpoints` is omitted when the adapter returns no per-filter status. */
export interface ExceptionBreakpointsResult {
  filters: string[];
  breakpoints?: DebugProtocol.Breakpoint[];
}

/** Every breakpoint currently installed in the session; returned by `start` and `list_breakpoints`. */
export interface BreakpointsSnapshot {
  source: SourceBreakpointsResult[];
  function?: FunctionBreakpointsResult;
  exception?: ExceptionBreakpointsResult;
}

// Session results

/** A detached snapshot of locally observed session state. */
export interface SessionSnapshot {
  configuration: Pick<DebugConfiguration, "name" | "type" | "request">;
  capabilities: Pick<
    DebugProtocol.Capabilities,
    | "supportsSingleThreadExecutionRequests"
    | "supportsConditionalBreakpoints"
    | "supportsHitConditionalBreakpoints"
    | "supportsLogPoints"
    | "supportsFunctionBreakpoints"
  >;
  state: SessionState;
  revision: number;
  /** The foreground operation, or a detached execution request when no foreground operation is active. */
  operation?: SessionOperation;
  /** Latest stop; its thread is the trigger when that thread remains inspectable. */
  stop?: Stop;
  /** Bounded counts of active threads already observed locally. */
  threadCounts: {
    total: number;
    byState: Record<Thread["state"], number>;
  };
  debuggeeExit?: DebuggeeExit;
}

/** A lightweight local view used to discover manager-owned sessions. */
export interface DebugSessionSummary {
  sessionId: DebugSessionId;
  /** Present when this session was started by another adapter through `startDebugging`. */
  parentSessionId?: DebugSessionId;
  configuration?: Pick<DebugConfiguration, "name" | "type" | "request">;
  state: SessionState["state"];
  operation?: SessionOperation;
  cleanupError?: string;
}

/** Normal outcomes of execution or observation, including an exhausted wait budget. */
export type ExecutionOutcome =
  | { kind: "stopped"; stop: Stop }
  | { kind: "threadExited"; threadId: number }
  | { kind: "timeout"; snapshot: SessionSnapshot }
  | { kind: "closed"; snapshot: SessionSnapshot };

export interface StartOptions {
  breakpoints: InitialBreakpoints;
  waitMs: number;
  /** Absolute deadline shared with configuration and adapter creation. */
  deadline: number;
}

/** Starting a session returns its manager identity with the initial observations. */
export interface StartSessionResult {
  sessionId: DebugSessionId;
  execution: ExecutionOutcome;
  breakpoints: BreakpointsSnapshot;
}

/** Closing waits at most five seconds and may leave cleanup in progress. */
export type CloseSessionResult =
  | { kind: "closing"; snapshot?: SessionSnapshot }
  | { kind: "closed"; snapshot?: SessionSnapshot };

// Pagination

/** Zero-based pagination of one selected list. */
export interface PageOptions {
  start: number;
  count: number;
}

/** Filters and pagination accepted by the `threads` operation. */
export interface ThreadsOptions extends PageOptions {
  state?: Thread["state"];
  nameContains?: string;
}

/** Metadata for an already selected page; unknown totals are omitted. */
export interface PageInfo extends PageOptions {
  nextStart?: number;
  total?: number;
}

/** Current-page items retain their complete original fields. */
export interface Page<T> extends PageInfo {
  items: T[];
}

export interface OutputOptions extends PageOptions {
  category?: string;
}

// Inspection

/** Select a zero-based stack position, not an adapter frame identifier. */
export interface FrameSelection extends ThreadSelection {
  frameIndex: number;
}

/** Select a scope or expand a reference from the same session and thread stop. */
export type VariablesSelection =
  | (FrameSelection & { scope: string; variablesReference?: never })
  | { threadId?: number; revision: number; variablesReference: number; frameIndex?: never; scope?: never };

/** A thread and suspended-state revision selected for inspection. */
export interface InspectionTarget {
  threadId: number;
  revision: number;
}

/** An original response body tied to the locally validated inspection target. */
export type Inspection<T> = InspectionTarget & { body: T };

/** A stack response containing only the selected page of complete frames. */
export type StackResult = Inspection<DebugProtocol.StackTraceResponse["body"]> & { page: PageInfo };

/** A variables response containing only the selected page of complete variables. */
export type VariablesResult = Inspection<DebugProtocol.VariablesResponse["body"]> & { page: PageInfo };

/** One expression's outcome within an evaluate batch; failures do not abort later expressions. */
export type EvaluateOutcome =
  | { expression: string; ok: true; body: DebugProtocol.EvaluateResponse["body"] }
  | { expression: string; ok: false; error: { code: string; message: string } };

/** Ordered per-expression outcomes sharing the batch's stop context. */
export type EvaluateResult = Inspection<{ results: EvaluateOutcome[] }>;
