import type { DebugProtocol } from "../dap/index.js";
import { DapConnection, DebugClient, Emitter, type Disposable, type EventSource } from "../dap/index.js";
import type { DebugConfiguration } from "../launchConfig.js";
import { DebugSession } from "./session.js";
import type { DebugAdapterFactory, DebugSessionContext, SessionManagerOptions } from "./types.js";

/**
 * Layer 5 — the registry and factory for debug sessions.
 *
 * Owns the adapter registry (`type` → how to build a transport), assembles the
 * transport→connection→client→session stack, tracks sessions by id with an
 * "active" pointer, spawns child sessions for `startDebugging`, and reaps dead
 * sessions. It is the single place that calls `new DapConnection` / `new
 * DebugClient`, closing the assembly gap left by Layers 1–4.
 */
export class SessionManager {
  private readonly adapters = new Map<string, DebugAdapterFactory>();
  private readonly sessions = new Map<string, DebugSession>();
  private activeId?: string;
  private seq = 0;

  private readonly _onSessionCreated = new Emitter<DebugSession>();
  private readonly _onSessionTerminated = new Emitter<{ id: string; exitCode?: number }>();
  private readonly _onSessionOutput = new Emitter<{ id: string; output: DebugProtocol.OutputEvent }>();

  readonly onSessionCreated: EventSource<DebugSession> = this._onSessionCreated.event;
  readonly onSessionTerminated: EventSource<{ id: string; exitCode?: number }> = this._onSessionTerminated.event;
  readonly onSessionOutput: EventSource<{ id: string; output: DebugProtocol.OutputEvent }> = this._onSessionOutput.event;

  constructor(private readonly options: SessionManagerOptions = {}) {}

  /** Register how to build a transport for a given debug `type`. */
  registerAdapter(type: string, factory: DebugAdapterFactory): Disposable {
    this.adapters.set(type, factory);
    return {
      dispose: () => {
        if (this.adapters.get(type) === factory) {
          this.adapters.delete(type);
        }
      },
    };
  }

  /** Create (but do not start) a session from a resolved configuration. */
  createSession(configuration: DebugConfiguration): Promise<DebugSession> {
    return this.spawn(configuration, undefined);
  }

  /** Create a child session in response to a `startDebugging` reverse request. */
  createChildSession(parentId: string, configuration: unknown, request = "launch"): Promise<DebugSession> {
    const config = { ...(configuration as Record<string, unknown>), request } as DebugConfiguration;
    return this.spawn(config, parentId);
  }

  get(id: string): DebugSession | undefined {
    return this.sessions.get(id);
  }

  list(): ReadonlyArray<DebugSession> {
    return [...this.sessions.values()];
  }

  get active(): DebugSession | undefined {
    return this.activeId ? this.sessions.get(this.activeId) : undefined;
  }

  setActive(id: string): void {
    if (!this.sessions.has(id)) {
      throw new Error(`unknown session '${id}'`);
    }
    this.activeId = id;
  }

  async terminate(id: string): Promise<void> {
    await this.sessions.get(id)?.terminate();
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeId = undefined;
    await Promise.all(sessions.map((session) => session.dispose()));
  }

  private async spawn(configuration: DebugConfiguration, parentId?: string): Promise<DebugSession> {
    if (this.options.maxSessions !== undefined && this.sessions.size >= this.options.maxSessions) {
      throw new Error(`session limit reached (${this.options.maxSessions})`);
    }
    const factory = this.adapters.get(configuration.type);
    if (!factory) {
      throw new Error(`no adapter registered for type '${configuration.type}'`);
    }

    const transport = await factory(configuration);
    const connection = new DapConnection(transport, {
      tracer: this.options.tracer,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
    });
    const client = new DebugClient(connection);

    const id = `session-${++this.seq}`;
    const ctx: DebugSessionContext = {
      id,
      parentId,
      configuration,
      runInTerminal: this.options.runInTerminal,
      onStartDebugging: (childConfig, request) => this.createChildSession(id, childConfig, request).then((child) => child.configureAndStart()),
      defaultWaitTimeoutMs: this.options.defaultWaitTimeoutMs,
    };

    const session = new DebugSession(client, connection, transport, ctx);
    this.sessions.set(id, session);
    if (!this.activeId) {
      this.activeId = id;
    }

    session.onTerminated(({ exitCode }) => this.reap(id, exitCode));
    session.onOutput((output) => this._onSessionOutput.fire({ id, output }));

    this._onSessionCreated.fire(session);
    return session;
  }

  private reap(id: string, exitCode?: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.delete(id);
    if (this.activeId === id) {
      this.activeId = this.sessions.keys().next().value;
    }
    this._onSessionTerminated.fire({ id, exitCode });
    void session.dispose();
  }
}
