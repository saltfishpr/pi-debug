import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugConfiguration } from "../config/launch-config.js";

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

/** Execution state justified by the events and responses received so far. */
export type ThreadState = "unknown" | "running" | "stopped" | "exited";

/** One thread; stop and revision are available only while it remains stopped. */
export interface ThreadSnapshot {
  id: number;
  name?: string;
  state: ThreadState;
  stop?: DebugProtocol.StoppedEvent["body"];
  revision?: number;
}

/** A current stopped thread with a usable inspection revision. */
export type StoppedThread = ThreadSnapshot & {
  state: "stopped";
  revision: number;
  stop: DebugProtocol.StoppedEvent["body"];
};

/** A detached snapshot of locally observed session state. */
export interface SessionSnapshot {
  configuration: Pick<DebugConfiguration, "name" | "type" | "request">;
  capabilities: Pick<DebugProtocol.Capabilities, "supportsSingleThreadExecutionRequests">;
  state: SessionState;
  revision: number;
  threads: ThreadSnapshot[];
  debuggeeExit?: DebuggeeExit;
}

/** Stop waits at most five seconds per call and may leave cleanup in progress. */
export type StopResult =
  | { kind: "noSession" }
  | { kind: "closing"; snapshot: SessionSnapshot }
  | { kind: "closed"; snapshot: SessionSnapshot };

/** Source breakpoint replacement, with one-based line numbers. */
export interface SourceBreakpoints {
  file: string;
  lines: number[];
}

export interface StartOptions {
  breakpoints: SourceBreakpoints[];
  waitMs: number;
  /** Absolute deadline shared with configuration and adapter creation. */
  deadline: number;
}

/** Original breakpoint response associated with its requested source. */
export interface BreakpointsResult {
  source: DebugProtocol.Source;
  body: DebugProtocol.SetBreakpointsResponse["body"];
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

/** Normal outcomes of execution or observation, including an exhausted wait budget. */
export type ExecutionOutcome =
  | { kind: "stopped"; thread: StoppedThread }
  | { kind: "stopped"; revision: number; stop: DebugProtocol.StoppedEvent["body"] }
  | { kind: "threadExited"; threadId: number }
  | { kind: "timeout"; status: SessionSnapshot }
  | { kind: "closed"; status: SessionSnapshot };

/** Zero-based pagination of one selected list. */
export interface PageOptions {
  start: number;
  count: number;
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

/** Select a zero-based stack position, not an adapter frame identifier. */
export interface FrameSelection extends ThreadSelection {
  frameIndex: number;
}

/** Select a scope or expand a reference from the same session and thread stop. */
export type VariablesSelection =
  | (FrameSelection & { scope: string; variablesReference?: never })
  | { threadId?: number; revision: number; variablesReference: number; frameIndex?: never; scope?: never };

/** Stop credentials captured and checked throughout an inspection. */
export interface StopContext {
  threadId: number;
  revision: number;
}

/** An original response body tied to the locally validated stop. */
export type Inspection<T> = StopContext & { body: T };

/** A stack response containing only the selected page of complete frames. */
export type StackResult = Inspection<DebugProtocol.StackTraceResponse["body"]> & { page: PageInfo };

/** A variables response containing only the selected page of complete variables. */
export type VariablesResult = Inspection<DebugProtocol.VariablesResponse["body"]> & { page: PageInfo };
