/** Stable failure reasons exposed by the debug tool. */
export type DebugErrorCode =
  | "INVALID_ARGUMENT"
  | "SESSION_NOT_FOUND"
  | "INVALID_STATE"
  | "OPERATION_CONFLICT"
  | "THREAD_NOT_FOUND"
  | "THREAD_SELECTION_REQUIRED"
  | "STALE_REVISION"
  | "REQUEST_REJECTED"
  | "REQUEST_TIMEOUT"
  | "CONNECTION_ERROR"
  | "CANCELLED";

/** A classified debug failure with only the context needed by its caller. */
export class DebugError extends Error {
  constructor(
    public readonly code: DebugErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DebugError";
  }
}

/** Preserve a classified internal abort reason, otherwise report caller cancellation. */
export function abortError(signal: AbortSignal): DebugError {
  return signal.reason instanceof DebugError
    ? signal.reason
    : new DebugError("CANCELLED", "Debug operation cancelled.", undefined, { cause: signal.reason });
}

/** Reject before dispatching work when the caller has already cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
