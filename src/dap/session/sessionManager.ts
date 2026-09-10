import type { DebugProtocol } from "@vscode/debugprotocol";
import { EventEmitter } from "node:events";
import { DapClient } from "../client/dapClient";
import { type AdapterDefinition, type AdapterProvider, createTransport, resolveAdapter } from "../transport/adapter";
import type { Transport } from "../transport/transport";
import type { Logger } from "../util/logger";
import { noopLogger } from "../util/logger";
import { Session } from "./session";
import type { DebugConfiguration, SessionStartOptions } from "./types";

/** Handler invoked when an adapter sends a `runInTerminal` reverse request. */
export type RunInTerminalHandler = (
  args: DebugProtocol.RunInTerminalRequestArguments,
  session: Session,
) => DebugProtocol.RunInTerminalResponse["body"] | Promise<DebugProtocol.RunInTerminalResponse["body"]>;

export interface SessionManagerOptions {
  logger?: Logger;
  /** Default per-request timeout applied to every session's client. */
  requestTimeoutMs?: number;
  /** Handles `runInTerminal`; if omitted the request is rejected. */
  runInTerminal?: RunInTerminalHandler;
  /**
   * Switch the active session to whichever one most recently stopped.
   * Defaults to `true`, mirroring nvim-dap's focus behaviour.
   */
  focusStoppedSession?: boolean;
  /**
   * Override how a {@link Transport} is built from an adapter definition.
   * Useful for tests (inject an in-process fake) or custom transports.
   */
  transportFactory?: (adapter: AdapterDefinition, logger: Logger) => Transport;
}

export interface StartSessionOptions {
  /** Override the registered adapter for this run. */
  adapter?: AdapterProvider;
  /** Options controlling the created session's startup behaviour. */
  startOptions?: SessionStartOptions;
}

export type SessionManagerEvents = {
  /** A session has been created and started. */
  sessionStarted: [Session];
  /** A session has ended (terminated/disconnected/closed). */
  sessionEnded: [Session];
  /** The active/focused session changed. */
  activeSessionChanged: [Session | undefined];
  /** A session failed and closed. */
  sessionError: [Session, Error];
};

interface SessionRecord {
  session: Session;
  transport: Transport;
  adapter: AdapterDefinition;
}

/**
 * Owns the registry of adapters and the set of live {@link Session}s.
 *
 * This is the top of the stack, corresponding to nvim-dap's `dap.lua`. It
 * knows how to turn a {@link DebugConfiguration} into a running session, tracks
 * the "active" session for UI/command routing, and spawns child sessions in
 * response to `startDebugging` reverse requests.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly adapters = new Map<string, AdapterProvider>();
  private readonly records = new Map<string, SessionRecord>();
  private _activeSession?: Session;
  private readonly logger: Logger;

  constructor(private readonly options: SessionManagerOptions = {}) {
    super();
    this.logger = options.logger ?? noopLogger;
  }

  // ---- adapter registry ---------------------------------------------------

  /** Register (or replace) the adapter used for a given configuration `type`. */
  registerAdapter(type: string, provider: AdapterProvider): void {
    this.adapters.set(type, provider);
  }

  unregisterAdapter(type: string): void {
    this.adapters.delete(type);
  }

  hasAdapter(type: string): boolean {
    return this.adapters.has(type);
  }

  // ---- sessions -----------------------------------------------------------

  /** Resolve the adapter, build the session, and run its startup handshake. */
  async start(config: DebugConfiguration, options: StartSessionOptions = {}): Promise<Session> {
    const provider = options.adapter ?? this.adapters.get(config.type);
    if (!provider) {
      throw new Error(`No adapter registered for type '${config.type}'`);
    }
    const adapter = await resolveAdapter(provider, config);
    const session = this.createSession(config, adapter, options.startOptions);
    try {
      await session.start();
    } catch (err) {
      session.close();
      throw err;
    }
    return session;
  }

  get sessions(): Session[] {
    return [...this.records.values()].map((record) => record.session);
  }

  getSession(id: string): Session | undefined {
    return this.records.get(id)?.session;
  }

  get activeSession(): Session | undefined {
    return this._activeSession;
  }

  /** Explicitly set the active/focused session. */
  setActiveSession(session: Session | undefined): void {
    if (this._activeSession === session) {
      return;
    }
    this._activeSession = session;
    this.emit("activeSessionChanged", session);
  }

  /** Disconnect and dispose every session. */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.sessions.map((session) => session.disconnect().catch(() => session.close())));
  }

  // ---- internals ----------------------------------------------------------

  private createSession(config: DebugConfiguration, adapter: AdapterDefinition, options?: SessionStartOptions, parent?: Session): Session {
    const transport = this.options.transportFactory ? this.options.transportFactory(adapter, this.logger) : createTransport(adapter, this.logger);
    const client = new DapClient(transport, {
      logger: this.logger,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    const session = new Session(client, config, options, { logger: this.logger });

    if (parent) {
      session.parent = parent;
      parent.children.set(session.id, session);
    }

    this.registerReverseHandlers(client, session, adapter);
    this.trackSession(session, transport, adapter);
    return session;
  }

  private registerReverseHandlers(client: DapClient, session: Session, adapter: AdapterDefinition): void {
    client.setReverseRequestHandler("runInTerminal", async (args) => {
      if (!this.options.runInTerminal) {
        throw new Error("runInTerminal requested but no handler is configured");
      }
      return this.options.runInTerminal(args, session);
    });

    client.setReverseRequestHandler("startDebugging", async (args) => {
      await this.startChildSession(session, adapter, args);
      return undefined;
    });
  }

  private async startChildSession(parent: Session, parentAdapter: AdapterDefinition, args: DebugProtocol.StartDebuggingRequestArguments): Promise<void> {
    const childConfig: DebugConfiguration = {
      ...(args.configuration as Record<string, unknown>),
      type: (args.configuration as { type?: string }).type ?? parent.config.type,
      request: args.request,
    };

    const childAdapter = await this.resolveChildAdapter(parent, parentAdapter, childConfig);
    const child = this.createSession(childConfig, childAdapter, {}, parent);
    await child.start();
  }

  /**
   * Decide which adapter a `startDebugging` child should use.
   *
   * Following nvim-dap: if the parent is a TCP server and the child would spawn
   * its own executable, prefer reconnecting to the already-running parent
   * server instead of launching a second process.
   */
  private async resolveChildAdapter(parent: Session, parentAdapter: AdapterDefinition, childConfig: DebugConfiguration): Promise<AdapterDefinition> {
    const provider = this.adapters.get(childConfig.type);
    let adapter = provider ? await resolveAdapter(provider, childConfig) : parentAdapter;

    if (parentAdapter.type === "server" && adapter.type === "server" && adapter.executable) {
      const endpoint = this.records.get(parent.id)?.transport.getEndpoint();
      if (endpoint) {
        adapter = { type: "server", host: endpoint.host, port: endpoint.port };
      }
    }
    return adapter;
  }

  private trackSession(session: Session, transport: Transport, adapter: AdapterDefinition): void {
    this.records.set(session.id, { session, transport, adapter });
    this.setActiveSession(session);
    this.emit("sessionStarted", session);

    const onStopped = () => {
      if (this.options.focusStoppedSession ?? true) {
        this.setActiveSession(session);
      }
    };
    session.on("stopped", onStopped);
    session.on("sessionError", (error) => this.emit("sessionError", session, error));

    session.once("close", () => {
      session.off("stopped", onStopped);
      this.records.delete(session.id);
      this.emit("sessionEnded", session);
      if (this._activeSession === session) {
        this.setActiveSession(this.sessions[this.sessions.length - 1]);
      }
    });
  }
}
