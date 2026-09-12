import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * DAP 请求命令到 [参数, 响应] 类型的映射表。
 *
 * 只是"协议 schema 的类型来源"，不由 `DapClient.request` 直接使用；上层封装
 * （如具名方法）可以从这里取每个命令的参数与响应类型。列出的都是最初 attach /
 * launch 阶段必用的标准命令，自定义命令仍可以直接通过 `request(command, args)` 发出。
 */
export interface DapRequests {
  initialize: [DebugProtocol.InitializeRequestArguments, DebugProtocol.InitializeResponse];
  launch: [DebugProtocol.LaunchRequestArguments & Record<string, unknown>, DebugProtocol.LaunchResponse];
  attach: [DebugProtocol.AttachRequestArguments & Record<string, unknown>, DebugProtocol.AttachResponse];
  configurationDone: [DebugProtocol.ConfigurationDoneArguments | undefined, DebugProtocol.ConfigurationDoneResponse];
  setBreakpoints: [DebugProtocol.SetBreakpointsArguments, DebugProtocol.SetBreakpointsResponse];
  setExceptionBreakpoints: [
    DebugProtocol.SetExceptionBreakpointsArguments,
    DebugProtocol.SetExceptionBreakpointsResponse,
  ];
  threads: [undefined, DebugProtocol.ThreadsResponse];
  stackTrace: [DebugProtocol.StackTraceArguments, DebugProtocol.StackTraceResponse];
  scopes: [DebugProtocol.ScopesArguments, DebugProtocol.ScopesResponse];
  variables: [DebugProtocol.VariablesArguments, DebugProtocol.VariablesResponse];
  evaluate: [DebugProtocol.EvaluateArguments, DebugProtocol.EvaluateResponse];
  continue: [DebugProtocol.ContinueArguments, DebugProtocol.ContinueResponse];
  next: [DebugProtocol.NextArguments, DebugProtocol.NextResponse];
  stepIn: [DebugProtocol.StepInArguments, DebugProtocol.StepInResponse];
  stepOut: [DebugProtocol.StepOutArguments, DebugProtocol.StepOutResponse];
  pause: [DebugProtocol.PauseArguments, DebugProtocol.PauseResponse];
  disconnect: [DebugProtocol.DisconnectArguments | undefined, DebugProtocol.DisconnectResponse];
  terminate: [DebugProtocol.TerminateArguments | undefined, DebugProtocol.TerminateResponse];
}

/** 单次 DAP 请求的调用侧控制参数。 */
export interface RequestOptions {
  /** 本次请求的超时时间（毫秒），覆盖 client 的默认值。 */
  timeoutMs?: number;
  /**
   * 用于取消本地等待。仅影响调用方的 Promise，并不会让 Adapter 侧真的取消操作；
   * 如需通知 Adapter 取消，应额外发送 DAP `cancel` 请求。
   */
  signal?: AbortSignal;
}

/**
 * 反向请求处理器（Adapter → Client 方向）。返回值会作为响应 body；
 * 抛出的错误会以 `success=false` 响应，`message` 取自 `Error.message`。
 * `signal` 在超时或连接关闭时被 abort，用于中止长任务。
 */
export type ReverseRequestHandler = (request: DebugProtocol.Request, signal: AbortSignal) => unknown | Promise<unknown>;
