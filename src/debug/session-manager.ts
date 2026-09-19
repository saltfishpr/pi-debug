import { getDebugAdapterProvider } from "../adapters/index.js";
import { loadDebugConfigurations, type DebugConfiguration } from "../config/launch-config.js";
import { resolveVariables } from "../config/variables.js";
import { DebugSession, type SessionStartOptions, type ExecutionResult, type SessionSnapshot } from "./session.js";

/** Owns the single debug session associated with one Pi extension session. */
export class DebugSessionManager {
  private disposed = false;
  private readonly lifetime = new AbortController();

  private session: DebugSession | undefined;
  private startupAbort: AbortController | undefined;

  private transitionTail: Promise<void> = Promise.resolve();

  /** Return the current session, including an ended session whose final status can still be inspected. */
  getSession(): DebugSession {
    if (!this.session) throw new Error('No debug session exists. Call debug with action "start" first.');
    return this.session;
  }

  /** List saved launch and attach configurations for a project without exposing adapter-specific secrets. */
  async configurations(cwd: string): Promise<{
    configurations: Array<Pick<DebugConfiguration, "name" | "type" | "request">>;
  }> {
    this.assertNotDisposed();
    const configurations = await loadDebugConfigurations(cwd);
    return {
      configurations: configurations.map(({ name, type, request }) => ({ name, type, request })),
    };
  }

  /** Resolve a configuration, create its adapter and start a new session. */
  async start(
    requested: string | DebugConfiguration,
    options: SessionStartOptions,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    return this.withTransition(async () => {
      this.assertNotDisposed();
      if (this.session && !this.session.isEnded) {
        throw new Error('A debug session is already running. Call debug with action "stop" before starting another.');
      }
      this.session = undefined;

      const startupAbort = new AbortController();
      this.startupAbort = startupAbort;
      let session: DebugSession | undefined;
      try {
        const configuration = await this.resolveConfiguration(requested, cwd);
        const provider = getDebugAdapterProvider(configuration.type);
        const resolved = await provider.resolve(configuration, cwd);
        session = new DebugSession(resolved.adapter, resolved.configuration, cwd);
        this.session = session;
        return await session.start(options, anySignals(this.lifetime.signal, startupAbort.signal, signal));
      } catch (error) {
        if (session && this.session === session) this.session = undefined;
        if (session) await session.close("startFailed");
        throw error;
      } finally {
        if (this.startupAbort === startupAbort) this.startupAbort = undefined;
      }
    });
  }

  /** Stop and forget the current session. */
  async stop(): Promise<{ stopped: true; session?: SessionSnapshot }> {
    const interruptedStartup = this.startupAbort;
    interruptedStartup?.abort(new Error("Debug session startup stopped by user."));
    return this.withTransition(async () => {
      const session = this.session;
      if (!session) {
        if (interruptedStartup) return { stopped: true };
        throw new Error('No debug session exists. Call debug with action "start" first.');
      }
      await session.close("user");
      const status = session.status();
      if (this.session === session) this.session = undefined;
      return { stopped: true, session: status };
    });
  }

  /** Abort startup and release the current adapter. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new Error("Debug session manager disposed."));
    await this.withTransition(async () => {
      const session = this.session;
      this.session = undefined;
      if (session) await session.close("shutdown");
    });
  }

  private async resolveConfiguration(requested: string | DebugConfiguration, cwd: string): Promise<DebugConfiguration> {
    if (typeof requested !== "string") return resolveVariables(requested, cwd);
    const configurations = await loadDebugConfigurations(cwd);
    const configuration = configurations.find((candidate) => candidate.name === requested);
    if (!configuration) {
      const available = configurations.map((candidate) => candidate.name).join(", ");
      throw new Error(`Unknown debug configuration '${requested}'. Available configurations: ${available || "none"}.`);
    }
    return configuration;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Debug session manager has been disposed.");
  }

  private async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release!: () => void;
    this.transitionTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function anySignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}
