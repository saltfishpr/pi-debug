import type { DebugProtocol } from "@vscode/debugprotocol";

/** Base class for all errors surfaced by the DAP client. */
export class DapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The requested command is not supported by the adapter's capabilities. */
export class DapUnsupportedError extends DapError {
  constructor(
    readonly command: string,
    readonly capability: string,
  ) {
    super(`Command '${command}' is not supported (missing capability '${capability}').`);
  }
}

/** A request did not receive a response within its timeout. */
export class DapTimeoutError extends DapError {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`Timeout after ${timeoutMs}ms waiting for response to '${command}'.`);
  }
}

/** The connection/transport closed before a request could complete. */
export class DapConnectionClosedError extends DapError {
  constructor(readonly command?: string) {
    super(command ? `Connection closed before '${command}' completed.` : "Connection closed.");
  }
}

/** A request was cancelled via its AbortSignal. */
export class DapCancellationError extends DapError {
  constructor(readonly command: string) {
    super(`Request '${command}' was cancelled.`);
  }
}

/** The adapter returned an unsuccessful response (`success: false`). */
export class DapResponseError extends DapError {
  readonly response: DebugProtocol.Response;
  /** Structured error payload, if the adapter provided one (`ErrorResponse.body.error`). */
  readonly body?: DebugProtocol.Message;

  constructor(response: DebugProtocol.Response) {
    const error = (response as DebugProtocol.ErrorResponse).body?.error;
    // Prefer the structured error's interpolated `format`, then the short
    // `message`, then a generic fallback (mirrors VS Code's rawDebugSession).
    const detail = error ? formatMessage(error) : response.message;
    super(detail || `Request '${response.command}' failed.`);
    this.response = response;
    this.body = error;
  }
}

/**
 * Render a DAP `Message` into a human-readable string by substituting its
 * `{name}` placeholders with the matching entries in `variables` (per the DAP
 * spec). Placeholders without a matching variable are left untouched.
 */
function formatMessage(message: DebugProtocol.Message): string {
  return message.format.replace(/\{([^}]+)\}/g, (match, name: string) =>
    message.variables && Object.prototype.hasOwnProperty.call(message.variables, name) ? message.variables[name] : match,
  );
}

/** Malformed data on the wire (framing or JSON parse failure). */
export class DapProtocolError extends DapError {}
