import type { DebugProtocol } from "@vscode/debugprotocol";
import { describe, expect, it } from "vitest";
import {
  asError,
  ConnectionClosedError,
  DapError,
  DapResponseError,
  ProtocolError,
  RequestAbortedError,
  RequestTimeoutError,
  UnsupportedCapabilityError,
} from "../../src/dap/errors.ts";

describe("DapError 子类", () => {
  it("每个子类都继承自 DapError，并且 name 与类名一致", () => {
    const cases: Array<[new (message: string) => DapError, string]> = [
      [ConnectionClosedError, "ConnectionClosedError"],
      [ProtocolError, "ProtocolError"],
      [RequestTimeoutError, "RequestTimeoutError"],
      [RequestAbortedError, "RequestAbortedError"],
      [UnsupportedCapabilityError, "UnsupportedCapabilityError"],
    ];
    for (const [Ctor, name] of cases) {
      const error = new Ctor("boom");
      expect(error).toBeInstanceOf(DapError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.message).toBe("boom");
    }
  });

  it("通过 options.cause 传递底层错误", () => {
    const cause = new Error("root");
    const error = new ProtocolError("wrapped", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("DapResponseError", () => {
  it("优先使用 response.message 作为错误信息，同时保留原响应", () => {
    const response: DebugProtocol.Response = {
      seq: 3,
      type: "response",
      request_seq: 2,
      command: "evaluate",
      success: false,
      message: "cannot evaluate",
    };
    const error = new DapResponseError(response);
    expect(error).toBeInstanceOf(DapError);
    expect(error.message).toBe("cannot evaluate");
    expect(error.response).toBe(response);
  });

  it("当 response.message 缺失时回退到通用描述", () => {
    const response: DebugProtocol.Response = {
      seq: 3,
      type: "response",
      request_seq: 2,
      command: "threads",
      success: false,
    };
    const error = new DapResponseError(response);
    expect(error.message).toBe("DAP request 'threads' failed");
  });
});

describe("asError", () => {
  it("原样返回 Error 实例", () => {
    const original = new TypeError("bad");
    expect(asError(original)).toBe(original);
  });

  it("把非 Error 值包装成 Error", () => {
    const cases: Array<[unknown, string]> = [
      ["string reason", "string reason"],
      [42, "42"],
      [null, "null"],
      [undefined, "undefined"],
      [{ toString: () => "obj" }, "obj"],
    ];
    for (const [value, expected] of cases) {
      const wrapped = asError(value);
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped.message).toBe(expected);
    }
  });
});
