// Layer 5 — session facade for the Pi Agent: SessionManager → DebugSession.
export { commandAdapter, pipeAdapter, serverAdapter, spawnServerAdapter } from "./adapters.js";
export { SessionManager } from "./manager.js";
export { DebugSession } from "./session.js";
export type {
  BreakpointsSnapshot,
  BreakpointStatus,
  DebugAdapterFactory,
  DebugSessionContext,
  ResumeOutcome,
  SessionManagerOptions,
  SessionState,
  SourceBreakpointSpec,
  StopSnapshot,
} from "./types.js";
