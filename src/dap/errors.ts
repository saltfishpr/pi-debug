import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * DAP 模块所有自定义错误的基类。子类只用于区分错误来源，不携带额外字段。
 * 统一继承 `DapError` 便于调用方用 `instanceof` 做粗粒度分类。
 */
export class DapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 连接已关闭：transport 已断开或 client 已终止，后续读写都会失败。 */
export class ConnectionClosedError extends DapError {}

/** 协议错误：收到不符合 DAP 规范的字节流、帧头或消息结构，连接不可恢复。 */
export class ProtocolError extends DapError {}

/** 请求超时：等待响应或建立连接时超过了配置的超时时间。 */
export class RequestTimeoutError extends DapError {}

/** 请求被取消：调用方通过 AbortSignal 主动放弃了等待。 */
export class RequestAbortedError extends DapError {}

/** 使用了 Adapter 未通过 initialize 声明支持的能力。 */
export class UnsupportedCapabilityError extends DapError {}

/**
 * DAP 请求成功送达但 Adapter 返回 `success=false` 时抛出。
 * `response` 保留原始响应，供调用方读取 `body` / `message` 等诊断信息。
 */
export class DapResponseError extends DapError {
  constructor(readonly response: DebugProtocol.Response) {
    super(response.message ?? `DAP request '${response.command}' failed`);
  }
}

/** 把任意 thrown value 归一化成 `Error`，用于统一错误传播路径。 */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
