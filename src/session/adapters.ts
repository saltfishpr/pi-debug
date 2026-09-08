import {
  PipeTransport,
  SocketTransport,
  StdioTransport,
  SubprocessSocketTransport,
  type PipeTransportOptions,
  type SocketTransportOptions,
  type StdioTransportOptions,
  type SubprocessSocketTransportOptions,
} from "../dap/transport/node/index.js";
import type { DebugConfiguration } from "../launchConfig.js";
import type { DebugAdapterFactory } from "./types.js";

/**
 * Node-only convenience factories.
 *
 * Kept trivial on purpose: mapping a `DebugConfiguration` to concrete spawn/
 * connect options is adapter-specific, so the caller supplies that mapping and
 * these helpers only wrap the matching transport. Importing this module pulls in
 * Node built-ins; the manager itself stays transport-agnostic.
 */

/** Spawn the adapter as a child process and speak DAP over its stdio. */
export function commandAdapter(build: (configuration: DebugConfiguration) => StdioTransportOptions): DebugAdapterFactory {
  return (configuration) => new StdioTransport(build(configuration));
}

/** Connect to an adapter listening on a TCP port. */
export function serverAdapter(build: (configuration: DebugConfiguration) => SocketTransportOptions): DebugAdapterFactory {
  return (configuration) => new SocketTransport(build(configuration));
}

/** Connect to an adapter over a named pipe / UNIX domain socket. */
export function pipeAdapter(build: (configuration: DebugConfiguration) => PipeTransportOptions): DebugAdapterFactory {
  return (configuration) => new PipeTransport(build(configuration));
}

/** Spawn an adapter that listens on TCP, wait until it is ready, then connect. */
export function spawnServerAdapter(build: (configuration: DebugConfiguration) => SubprocessSocketTransportOptions): DebugAdapterFactory {
  return (configuration) => new SubprocessSocketTransport(build(configuration));
}
