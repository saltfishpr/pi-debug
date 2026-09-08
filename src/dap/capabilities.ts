import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * Declarative command -> required-capability table.
 *
 * Replaces VS Code's 50+ hand-written `if (caps.supportsX) ... else reject`
 * blocks with a single guarded request path. Commands not listed here are
 * always allowed (they have no capability precondition in the spec).
 */
export const CAPABILITY_BY_COMMAND: Readonly<Record<string, keyof DebugProtocol.Capabilities>> = {
  configurationDone: "supportsConfigurationDoneRequest",
  restart: "supportsRestartRequest",
  terminate: "supportsTerminateRequest",
  terminateThreads: "supportsTerminateThreadsRequest",
  setVariable: "supportsSetVariable",
  setExpression: "supportsSetExpression",
  restartFrame: "supportsRestartFrame",
  stepInTargets: "supportsStepInTargetsRequest",
  gotoTargets: "supportsGotoTargetsRequest",
  goto: "supportsGotoTargetsRequest",
  completions: "supportsCompletionsRequest",
  setFunctionBreakpoints: "supportsFunctionBreakpoints",
  dataBreakpointInfo: "supportsDataBreakpoints",
  setDataBreakpoints: "supportsDataBreakpoints",
  breakpointLocations: "supportsBreakpointLocationsRequest",
  setInstructionBreakpoints: "supportsInstructionBreakpoints",
  exceptionInfo: "supportsExceptionInfoRequest",
  loadedSources: "supportsLoadedSourcesRequest",
  stepBack: "supportsStepBack",
  reverseContinue: "supportsStepBack",
  disassemble: "supportsDisassembleRequest",
  readMemory: "supportsReadMemoryRequest",
  writeMemory: "supportsWriteMemoryRequest",
};

/** Merge a capabilities delta into an accumulator (initialize + `capabilities` event). */
export function mergeCapabilities(base: DebugProtocol.Capabilities, delta: DebugProtocol.Capabilities | undefined): DebugProtocol.Capabilities {
  return delta ? { ...base, ...delta } : base;
}
