import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DapRequestMap, DebugAdapter } from "../dap/index.js";
import { DebugError } from "./errors.js";

/** Per-request timeout, independent of caller cancellation and event waiting. */
export interface CallOptions {
  timeoutMs: number;
}

/** Converts the supported DAP requests into typed Promise-based operations. */
export class DapClient {
  private readonly pending = new Set<(error: unknown) => void>();

  constructor(private readonly adapter: DebugAdapter) {}

  /** Send a typed request and settle it on response, adapter timeout, or failPending. */
  request<C extends keyof DapRequestMap>(
    command: C,
    args: DapRequestMap[C][0],
    options: CallOptions,
  ): Promise<DapRequestMap[C][1]> {
    const timeoutMs = Math.max(0, Math.ceil(options.timeoutMs));
    const timeoutErr = new DebugError("REQUEST_TIMEOUT", `Debug request '${command}' timed out.`, { timeoutMs });
    if (timeoutMs === 0) return Promise.reject(timeoutErr);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        this.pending.delete(fail);
        return true;
      };
      const fail = (error: unknown): void => {
        if (finish()) reject(error);
      };
      this.pending.add(fail);
      try {
        this.adapter.sendRequest(
          command,
          args,
          (response) => {
            if (settled) return;
            if (!response.success) {
              if (response.command === "timeout") return fail(timeoutErr);
              // ? 是否要判断: command 是否为 dap 层返回的哨兵值 "canceled"
              return fail(
                new DebugError("REQUEST_REJECTED", formatResponseError(response), undefined, { cause: response }),
              );
            }
            if (finish()) resolve(response as DapRequestMap[C][1]);
          },
          timeoutMs,
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  /** Settle local requests before transport disposal, which does not invoke callbacks. */
  failPending(error: unknown): void {
    for (const fail of this.pending) fail(error);
  }
}

function formatResponseError(response: DebugProtocol.Response): string {
  const errorResponse = response as DebugProtocol.ErrorResponse;
  const error = errorResponse.body?.error;
  if (!error) return response.message || `Debug adapter rejected '${response.command}'.`;
  return error.format.replace(/{([^{}]+)}/g, (placeholder, name: string) => error.variables?.[name] ?? placeholder);
}
