import { resolve } from "node:path";
import { getDebugAdapterProvider } from "../adapters/index.js";
import { loadDebugConfigurations, type DebugConfiguration } from "../config/launch-config.js";
import { resolveVariables } from "../config/variables.js";
import { DebugSession } from "./session.js";
import type { SessionStartOptions, SessionStatus, StartResult } from "./types.js";

/** Owns the single debug session associated with one Pi extension session. */
export class DebugSessionManager {
  private disposePromise: Promise<void> | undefined;
  private readonly lifetime = new AbortController();

  private session: DebugSession | undefined;
  private startupAbort: AbortController | undefined;
  private hadSession = false;

  private transitionTail: Promise<void> = Promise.resolve();

  /** Return the current session, including a closed session whose final status can still be inspected. */
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
  ): Promise<StartResult> {
    return this.withTransition(async () => {
      this.assertNotDisposed();
      if (this.session && !this.session.isClosed) {
        throw new Error('A debug session is already running. Call debug with action "stop" before starting another.');
      }
      this.session = undefined;

      const startupAbort = new AbortController();
      this.startupAbort = startupAbort;
      let session: DebugSession | undefined;
      const startupSignal = anySignals(this.lifetime.signal, startupAbort.signal, signal);
      try {
        startupSignal.throwIfAborted();
        const configuration = await this.resolveConfiguration(requested, cwd);
        startupSignal.throwIfAborted();
        const provider = getDebugAdapterProvider(configuration.type);
        const resolved = await provider.resolve(configuration, cwd);
        session = new DebugSession(resolved.adapter, resolved.configuration, cwd);
        this.session = session;
        this.hadSession = true;
        return await session.start(options, startupSignal);
      } catch (error) {
        const state = session?.snapshot().state;
        // Preserve failed cleanup for status inspection without replacing the original startup error.
        if (session && this.session === session && !(state?.state === "closed" && state.cleanupError)) {
          this.session = undefined;
        }
        throw error;
      } finally {
        if (this.startupAbort === startupAbort) this.startupAbort = undefined;
      }
    });
  }

  /** Close and forget the session, returning its final status or noSession if already absent. */
  async stop(): Promise<{ kind: "closed"; status: SessionStatus } | { kind: "noSession" }> {
    const interruptedStartup = this.startupAbort;
    interruptedStartup?.abort(new Error("Debug session startup stopped by user."));
    return this.withTransition(async () => {
      const session = this.session;
      if (!session) {
        if (interruptedStartup || this.hadSession) return { kind: "noSession" };
        throw new Error('No debug session exists. Call debug with action "start" first.');
      }
      await session.close();
      const status = session.snapshot();
      if (this.session === session) this.session = undefined;
      return { kind: "closed", status };
    });
  }

  /** Abort startup and release the current adapter. Safe to call more than once. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.withTransition(async () => {
      const session = this.session;
      this.session = undefined;
      if (!session) return;
      await session.close();
      const state = session.snapshot().state;
      if (state.state === "closed" && state.cleanupError) throw new Error(state.cleanupError);
    });
    this.lifetime.abort(new Error("Debug session manager disposed."));
    return this.disposePromise;
  }

  private async resolveConfiguration(requested: string | DebugConfiguration, cwd: string): Promise<DebugConfiguration> {
    let configuration: DebugConfiguration;
    if (typeof requested !== "string") {
      configuration = resolveVariables(requested, cwd);
    } else {
      const configurations = await loadDebugConfigurations(cwd);
      const saved = configurations.find((candidate) => candidate.name === requested);
      if (!saved) {
        const available = configurations.map((candidate) => candidate.name).join(", ");
        throw new Error(
          `Unknown debug configuration '${requested}'. Available configurations: ${available || "none"}.`,
        );
      }
      configuration = saved;
    }

    return {
      ...configuration,
      ...(typeof configuration.cwd === "string" ? { cwd: resolve(cwd, configuration.cwd) } : {}),
      ...(typeof configuration.program === "string" ? { program: resolve(cwd, configuration.program) } : {}),
    };
  }

  private assertNotDisposed(): void {
    if (this.disposePromise) throw new Error("Debug session manager has been disposed.");
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
