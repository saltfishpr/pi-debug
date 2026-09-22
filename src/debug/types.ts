import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugConfiguration } from "../config/launch-config.js";

export type SessionState =
  | {
      state: "starting";
    }
  | {
      state: "active";
    }
  | {
      state: "closing";
      reason: SessionEndReason;
    }
  | {
      state: "closed";
      reason: SessionEndReason;
      cleanupError?: string;
    };

export type SessionEndReason = { kind: "requested" } | { kind: "terminated" } | { kind: "error"; message: string };

export interface DebuggeeExit {
  exitCode: number;
}

export interface SessionStatus {
  configuration: Pick<DebugConfiguration, "name" | "type" | "request">;
  capabilities: Pick<DebugProtocol.Capabilities, "supportsSingleThreadExecutionRequests">;
  state: SessionState;
  threads: ThreadSnapshot[];
  debuggeeExit?: DebuggeeExit;
}

export type ThreadState = "unknown" | "running" | "stopped" | "exited";

export interface SourceBreakpoints {
  file: string;
  lines: readonly number[];
}

export interface SessionStartOptions {
  breakpoints: readonly SourceBreakpoints[];
  waitMs: number;
}

export interface ResumeOptions {
  threadId?: number;
  singleThread: boolean;
  waitMs: number;
}

export interface PauseOptions {
  threadId?: number;
  waitMs: number;
}

export interface WaitOptions {
  threadId?: number;
  waitMs: number;
}

export interface PaginationOptions {
  start: number;
  count: number;
}

export interface StackTraceOptions extends PaginationOptions {
  threadId?: number;
}

interface VariablesPageOptions extends PaginationOptions {
  threadId?: number;
}

export type VariablesOptions = VariablesPageOptions &
  (
    | { variablesReference?: undefined; frame: number; scope: string }
    | { variablesReference: number; frame?: never; scope?: never }
  );

export interface EvaluateOptions {
  threadId?: number;
  frame: number;
  expression: string;
}

export interface InspectOptions {
  threadId?: number;
  frame: number;
  scope?: string;
}

export interface OutputOptions extends PaginationOptions {
  category?: string;
}

/** A stack frame at its zero-based position in one stopped thread's call stack. */
export interface Frame {
  index: number;
  data: DebugProtocol.StackFrame;
}

/** A stopped event and the stack frame session could resolve for it. */
export interface Stop {
  event: DebugProtocol.StoppedEvent["body"];
  topFrame?: Frame;
}

/** One debuggee thread and the execution state tracked by this session. */
export interface ThreadSnapshot {
  id: number;
  name?: string;
  state: ThreadState;
  stop?: Stop;
}

/** A DAP scope. */
export type Scope = DebugProtocol.Scope;

/** A DAP variable. */
export type Variable = DebugProtocol.Variable;

/** A DAP breakpoint associated with one source. */
export type Breakpoint = DebugProtocol.Breakpoint;

/** One buffered DAP output event. */
export type Output = DebugProtocol.OutputEvent["body"];

/** A page of a resource collection. `total` is present only when known exactly. */
export interface Page<T> {
  start: number;
  items: T[];
  nextStart?: number;
  total?: number;
}

/** Local source text read by the session as inspection context. */
export interface SourceContext {
  path: string;
  lines: {
    line: number;
    content: string;
  }[];
}

export type ExecutionOutcome =
  | {
      kind: "stopped";
      thread: ThreadSnapshot;
    }
  | {
      kind: "threadExited";
      threadId: number;
    }
  | {
      kind: "timeout";
      status: SessionStatus;
    }
  | {
      kind: "closed";
      status: SessionStatus;
    };

export interface BreakpointSet {
  source: DebugProtocol.Source;
  breakpoints: Breakpoint[];
}

export interface StartResult {
  execution: ExecutionOutcome;
  breakpoints: BreakpointSet[];
}

export interface SetBreakpointsResult {
  breakpoints: BreakpointSet;
}

export interface StackTrace {
  threadId: number;
  stack: Page<Frame>;
}

export type VariableContainer =
  | { kind: "scope"; frameIndex: number; scope: Scope }
  | { kind: "variable"; variablesReference: number };

export interface Variables {
  threadId: number;
  container: VariableContainer;
  variables: Page<Variable>;
}

export interface Evaluation {
  threadId: number;
  frameIndex: number;
  data: DebugProtocol.EvaluateResponse["body"];
}

export interface Inspection {
  thread: ThreadSnapshot;
  stack: Page<Frame>;
  selection: {
    frame: Frame;
    scopes: Scope[];
    variables?: Variables;
    sourceContext?: SourceContext;
  };
}
