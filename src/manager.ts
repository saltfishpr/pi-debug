import type { DebugProtocol } from "@vscode/debugprotocol";
import { spawn, type SpawnOptions } from "node:child_process";
import type { AdapterFactory, DebugConfiguration, Session } from "./dap";
import { SessionManager } from "./dap";
import { loadDebugConfigurations } from "./launchConfig";
import { PiDebugSession } from "./session";

export interface PiDebugSessionManagerOptions {
  /**
   * Produces the {@link AdapterDefinition} used to reach the debug adapter for
   * a given {@link DebugConfiguration}. Called on every `start`.
   */
  adapterFactory: AdapterFactory;
}

/**
 * Extension-facing manager that wraps the DAP {@link SessionManager}.
 *
 * Responsibilities:
 *  - own the loaded {@link DebugConfiguration} list;
 *  - hand the injected {@link AdapterProvider} down to the DAP layer, which
 *    resolves it against each configuration at `start` time;
 *  - wrap every underlying DAP session in a {@link PiDebugSession} so callers
 *    interact with one consistent surface;
 *  - handle `runInTerminal` reverse requests by spawning the debuggee and
 *    piping its output into the owning session's buffer.
 */
export class PiDebugSessionManager {
  private readonly manager: SessionManager;
  private readonly sessions = new Map<string, PiDebugSession>();
  private readonly adapterFactory: AdapterFactory;
  private configurations: DebugConfiguration[] = [];

  constructor(options: PiDebugSessionManagerOptions) {
    this.adapterFactory = options.adapterFactory;
    this.manager = new SessionManager({
      runInTerminal: (args, session) => this.handleRunInTerminal(args, session),
    });

    this.manager.on("sessionStarted", (session) => {
      if (!this.sessions.has(session.id)) {
        this.sessions.set(session.id, new PiDebugSession(session));
      }
    });
    this.manager.on("sessionEnded", (session) => {
      this.sessions.delete(session.id);
    });
  }

  async loadConfigurations(cwd: string): Promise<void> {
    try {
      this.configurations = await loadDebugConfigurations(cwd);
    } catch (err) {
      this.configurations = [];
      throw err;
    }
  }

  get configurationNames(): string[] {
    return this.configurations.map((c) => c.name).filter((n): n is string => typeof n === "string");
  }

  async start(options: { name?: string; configuration?: DebugConfiguration } = {}): Promise<PiDebugSession> {
    const dapSession = await this.manager.start(this.pickConfiguration(options), {
      adapter: this.adapterFactory,
    });
    const session = this.sessions.get(dapSession.id);
    if (!session) {
      throw new Error(`Internal: session ${dapSession.id} was not wrapped`);
    }
    return session;
  }

  private pickConfiguration(options: { name?: string; configuration?: DebugConfiguration }): DebugConfiguration {
    if (options.configuration) return options.configuration;
    if (this.configurations.length === 0) {
      throw new Error("No debug configurations available.");
    }
    if (options.name === undefined) {
      if (this.configurations.length === 1) return this.configurations[0]!;
      const names = this.configurationNames.join(", ");
      throw new Error(`Multiple debug configurations available (${names}); specify one by name.`);
    }
    const found = this.configurations.find((c) => c.name === options.name);
    if (!found) {
      const names = this.configurationNames.join(", ");
      throw new Error(`Debug configuration '${options.name}' not found. Available: ${names}`);
    }
    return found;
  }

  list(): PiDebugSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): PiDebugSession | undefined {
    return this.sessions.get(id);
  }

  resolve(sessionId?: string): PiDebugSession {
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (!found) {
        throw new Error(`No debug session with id '${sessionId}'`);
      }
      return found;
    }
    const active = this.manager.activeSession;
    if (!active) {
      throw new Error("No active debug session. Call `debug start` first.");
    }
    const session = this.sessions.get(active.id);
    if (!session) {
      throw new Error(`Internal: active session ${active.id} was not wrapped`);
    }
    return session;
  }

  activeId(): string | undefined {
    return this.manager.activeSession?.id;
  }

  async disposeAll(): Promise<void> {
    await this.manager.disposeAll();
    this.sessions.clear();
  }

  private handleRunInTerminal(args: DebugProtocol.RunInTerminalRequestArguments, dapSession: Session): DebugProtocol.RunInTerminalResponse["body"] {
    const session = this.sessions.get(dapSession.id);
    const [command, ...rest] = args.args;
    if (!command) {
      throw new Error("runInTerminal: empty command");
    }
    const spawnOptions: SpawnOptions = {
      cwd: args.cwd,
      env: { ...process.env, ...(args.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(command, rest, spawnOptions);
    session?.registerSpawnedDebuggee(child);
    const body: DebugProtocol.RunInTerminalResponse["body"] = {};
    if (typeof child.pid === "number") body.processId = child.pid;
    return body;
  }
}
