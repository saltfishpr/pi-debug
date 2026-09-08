import type { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Error thrown when a debug adapter returns an unsuccessful response
 * (`success: false`) to a request.
 */
export class DapResponseError extends Error {
  readonly command: string;
  readonly requestSeq: number;
  /** Structured error payload as provided by the adapter, if any. */
  readonly body?: DebugProtocol.ErrorResponse['body'];

  constructor(response: DebugProtocol.Response) {
    super(DapResponseError.format(response));
    this.name = 'DapResponseError';
    this.command = response.command;
    this.requestSeq = response.request_seq;
    this.body = (response as DebugProtocol.ErrorResponse).body;
  }

  private static format(response: DebugProtocol.Response): string {
    const errBody = (response as DebugProtocol.ErrorResponse).body;
    const dapMessage = errBody?.error;
    if (dapMessage?.format) {
      // Interpolate {name} placeholders from the structured message.
      return dapMessage.format.replace(/\{(\w+)\}/g, (match, key: string) => {
        const variables = dapMessage.variables ?? {};
        return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
      });
    }
    return response.message ?? `Request '${response.command}' failed`;
  }
}

/** Error thrown when a request does not receive a response in time. */
export class DapTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`Request '${command}' timed out after ${timeoutMs}ms`);
    this.name = 'DapTimeoutError';
  }
}

/** Error thrown when the underlying transport/connection fails. */
export class DapConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DapConnectionError';
  }
}
