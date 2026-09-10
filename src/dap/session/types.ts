import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * A launch/attach configuration. The `type`/`request`/`name` fields are
 * conventional; every other property is adapter-specific and forwarded
 * verbatim as the `launch`/`attach` request arguments.
 */
export interface DebugConfiguration {
  /** Adapter type, e.g. `node`, `python`, `lldb`. */
  type: string;
  /** Whether to `launch` a new debuggee or `attach` to a running one. */
  request: "launch" | "attach";
  /** Human-readable name for the configuration. */
  name?: string;
  [key: string]: unknown;
}

/** The lifecycle state of a {@link Session}. */
export enum SessionState {
  /** Created but `start()` has not completed. */
  Initializing = "initializing",
  /** Configured and running (debuggee executing, not paused). */
  Running = "running",
  /** Paused at a breakpoint/step/exception. */
  Stopped = "stopped",
  /** Terminated or disconnected; no longer usable. */
  Terminated = "terminated",
}

/** Cached per-thread state maintained by a {@link Session}. */
export interface ThreadInfo {
  id: number;
  name: string;
  /** Whether this thread is currently paused. */
  stopped: boolean;
  /** Stack frames, populated lazily after a stop and cached until resumed. */
  frames?: DebugProtocol.StackFrame[];
}

/** Options controlling {@link Session} behaviour. */
export interface SessionStartOptions {
  /** Arguments merged onto the default `initialize` request arguments. */
  initializeArgs?: Partial<DebugProtocol.InitializeRequestArguments>;
  /** Source breakpoints to install during configuration, keyed by source path. */
  breakpoints?: Record<string, DebugProtocol.SourceBreakpoint[]>;
  /** Function breakpoints to install during configuration. */
  functionBreakpoints?: DebugProtocol.FunctionBreakpoint[];
  /**
   * Exception breakpoint filter ids to enable during configuration, or
   * `'default'` to enable every filter the adapter marks as default.
   */
  exceptionFilters?: string[] | "default";
  /**
   * Fetch the stopped thread's stack trace automatically on a `stopped` event
   * and cache it. Defaults to `true`.
   */
  autoFetchStackTraceOnStop?: boolean;
  /**
   * Milliseconds to wait for the adapter's `initialized` event before giving
   * up on configuration and proceeding. Defaults to `8000`.
   */
  configureTimeoutMs?: number;
}
