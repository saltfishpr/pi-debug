/**
 * DAP（Debug Adapter Protocol）模块公开入口。
 *
 * - `DapClient` + transports：建立并管理一条 DAP 连接；
 * - `MessageDecoder` / `encodeMessage`：底层帧编解码，通常无需直接使用；
 * - `DapError` 系列：统一错误类型，供 `instanceof` 分类；
 * - `types`：协议 schema 与请求控制参数。
 */

export type { DebugProtocol } from "@vscode/debugprotocol";

// 客户端
export { DapClient, type DapClientOptions } from "./client.js";

// 编解码
export { MessageDecoder as DapDecoder, encodeMessage, type CodecOptions, type Message as DapMessage } from "./codec.js";

// 错误类型
export {
  ConnectionClosedError,
  DapError,
  DapResponseError,
  ProtocolError,
  RequestAbortedError,
  RequestTimeoutError,
} from "./errors.js";

// Transport 实现与配置
export { SpawnedServerTransport, StdioTransport, StreamTransport, TcpTransport } from "./transport.js";
export type { DapTransport, ProcessOptions, ServerOptions, TransportHandlers } from "./transport.js";

// 协议 schema 与控制参数
export type { DapRequests, RequestOptions, ReverseRequestHandler } from "./types.js";
