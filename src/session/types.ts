import type { DapTracer, DapTransport, DebugProtocol, ReverseRequestHandler } from "../dap/index.js";
import type { DebugConfiguration } from "../launchConfig.js";

/**
 * Layer 5 — session-level types.
 *
 * Agent-facing shapes that sit above the 1:1 protocol client (Layer 4). They
 * add the two things a `DebugClient` deliberately omits: an explicit
 * running/stopped distinction and a coherent "where did it stop" snapshot.
 */

/** High-level session lifecycle, richer than L4's `ClientState`. */
export type SessionState = "created" | "initializing" | "configuring" | "running" | "stopped" | "terminated" | "disposed";

/** Result of a resume/step: bridges DAP's async events into one awaited value. */
export type ResumeOutcome = { outcome: "stopped"; snapshot: StopSnapshot } | { outcome: "terminated"; exitCode?: number } | { outcome: "timeout" };

/** A consistent view of one stop. Volatile handles are owned by the session. */
export interface StopSnapshot {
  reason: string;
  threadId: number;
  allThreadsStopped?: boolean;
  description?: string;
  text?: string;
  hitBreakpointIds?: number[];
  /** Top frames only (bounded by `maxStackFrames`) to protect agent context. */
  frames: DebugProtocol.StackFrame[];
}

/** Stable, path-addressed breakpoint request (no volatile ids from the agent). */
export interface SourceBreakpointSpec {
  path: string;
  breakpoints: DebugProtocol.SourceBreakpoint[];
}

/** A requested breakpoint paired with the adapter's verified result (if any). */
export interface BreakpointStatus<Requested> {
  requested: Requested;
  /** Reconciled from the `setBreakpoints` response and `breakpoint` events; absent until sent. */
  verified?: DebugProtocol.Breakpoint;
}

/** A coherent view of every breakpoint the session tracks, for `list_breakpoints`. */
export interface BreakpointsSnapshot {
  source: { path: string; breakpoints: BreakpointStatus<DebugProtocol.SourceBreakpoint>[] }[];
  function: BreakpointStatus<DebugProtocol.FunctionBreakpoint>[];
  exception: {
    filters: string[];
    filterOptions: DebugProtocol.ExceptionFilterOptions[];
    /** Filters the adapter advertised in `initialize` (`exceptionBreakpointFilters`). */
    available: DebugProtocol.ExceptionBreakpointsFilter[];
  };
}

/** Everything a single session needs; assembled and injected by the manager. */
export interface DebugSessionContext {
  id: string;
  parentId?: string;
  configuration: DebugConfiguration;
  /** Override/extend the client capabilities announced in `initialize`. */
  clientCapabilities?: Partial<DebugProtocol.InitializeRequestArguments>;
  /** Delegate `runInTerminal` to the embedder (Pi Agent); core never spawns terminals. */
  runInTerminal?: ReverseRequestHandler;
  /** Delegate `startDebugging` to the manager, which spawns a child session. */
  onStartDebugging?: (configuration: unknown, request: string) => Promise<void>;
  /** Max time a resume/step waits for the next stop before giving up. Default 30_000. */
  defaultWaitTimeoutMs?: number;
  /** Max frames fetched per stop snapshot. Default 20. */
  maxStackFrames?: number;
  /** Max retained output events. Default 1000. */
  maxOutputBuffer?: number;
}

/** Given a resolved configuration, produce a not-yet-started transport. */
export type DebugAdapterFactory = (configuration: DebugConfiguration) => DapTransport | Promise<DapTransport>;

export interface SessionManagerOptions {
  tracer?: DapTracer;
  /** Default per-request timeout (ms) forwarded to every connection. */
  defaultTimeoutMs?: number;
  /** Default resume/step wait timeout (ms) forwarded to every session. */
  defaultWaitTimeoutMs?: number;
  /** Upper bound on concurrently tracked sessions. */
  maxSessions?: number;
  /** Global `runInTerminal` handler, shared by all sessions. */
  runInTerminal?: ReverseRequestHandler;
}
