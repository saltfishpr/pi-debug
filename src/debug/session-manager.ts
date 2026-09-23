import { resolve } from "node:path";
import { ZodError } from "zod";
import type { ResolvedDebugAdapter } from "../adapters/index.js";
import { getDebugAdapterProvider } from "../adapters/index.js";
import { loadDebugConfigurations, type DebugConfiguration } from "../config/launch-config.js";
import { resolveVariables } from "../config/variables.js";
import { finishesWithin, observe } from "./async.js";
import { DebugError, throwIfAborted } from "./errors.js";
import { DebugSession } from "./session.js";
import type { BreakpointsSnapshot, ExecutionOutcome, InitialBreakpoints, StopResult } from "./types.js";

const START_TIMEOUT_MS = 30_000;
const CLEANUP_WAIT_MS = 5_000;

interface PendingStart {
  abort: AbortController;
  done: Promise<void>;
}

/** Own the one debug session associated with this Pi extension session. */
export class DebugSessionManager {
  private current: DebugSession | undefined;
  private starting: PendingStart | undefined;
  private disposePromise: Promise<void> | undefined;

  /** Return complete saved configurations; the tool chooses which fields to display. */
  async configurations(cwd: string, signal?: AbortSignal): Promise<DebugConfiguration[]> {
    this.assertAvailable();
    throwIfAborted(signal);
    const configurations = await observe(loadDebugConfigurations(cwd), signal);
    this.assertAvailable();
    return configurations;
  }

  /** Get the current session without transferring ownership to the caller. */
  get(): DebugSession {
    this.assertAvailable();
    if (!this.current) throw new DebugError("NO_SESSION", "No debug session exists. Call `start` first.");
    return this.current;
  }

  /** Resolve a configuration and start a new session within one setup deadline. */
  async start(
    cwd: string,
    options: {
      configuration: string | DebugConfiguration;
      breakpoints: InitialBreakpoints;
      waitMs: number;
    },
    signal?: AbortSignal,
  ): Promise<{ execution: ExecutionOutcome; breakpoints: BreakpointsSnapshot }> {
    this.assertAvailable();
    throwIfAborted(signal);
    if (this.starting) throw new DebugError("OPERATION_CONFLICT", "A debug session is already starting.");
    if (this.current && !this.current.isClosed) {
      throw new DebugError("INVALID_STATE", "Stop the current debug session before starting another.", {
        state: this.current.snapshot().state.state,
      });
    }

    let finish!: () => void;
    const pending: PendingStart = {
      abort: new AbortController(),
      done: new Promise<void>((resolvePromise) => {
        finish = resolvePromise;
      }),
    };
    this.starting = pending;

    const deadline = Date.now() + START_TIMEOUT_MS;
    const timeout = new AbortController();
    const timeoutError = new DebugError("REQUEST_TIMEOUT", "Debug session startup timed out.", {
      timeoutMs: START_TIMEOUT_MS,
    });
    const timer = setTimeout(() => timeout.abort(timeoutError), START_TIMEOUT_MS);
    const startSignal = signal ? AbortSignal.any([signal, pending.abort.signal]) : pending.abort.signal;
    const setupSignal = AbortSignal.any([startSignal, timeout.signal]);
    let resolving: Promise<ResolvedDebugAdapter> | undefined;
    let resolved: ResolvedDebugAdapter | undefined;
    let session: DebugSession | undefined;

    try {
      const configuration = await this.resolveConfiguration(options.configuration, cwd, setupSignal);
      throwIfAborted(setupSignal);
      if (Date.now() >= deadline) throw timeoutError;
      let provider;
      try {
        provider = getDebugAdapterProvider(configuration.type);
      } catch (error) {
        throw new DebugError("INVALID_ARGUMENT", errorMessage(error), { type: configuration.type }, { cause: error });
      }
      resolving = provider.resolve(configuration, cwd);
      try {
        resolved = await observe(resolving, setupSignal);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new DebugError("INVALID_ARGUMENT", error.message, undefined, { cause: error });
        }
        throw error;
      }
      throwIfAborted(setupSignal);
      if (Date.now() >= deadline) throw timeoutError;

      session = new DebugSession(resolved.adapter, resolved.configuration, cwd);
      this.current = session;
      clearTimeout(timer);
      return await session.start({ breakpoints: options.breakpoints, waitMs: options.waitMs, deadline }, startSignal);
    } catch (error) {
      if (!session) {
        const unused = resolved ? Promise.resolve(resolved) : resolving;
        // Provider resolution cannot be cancelled; a late transport must not survive this start.
        if (unused) void unused.then(({ adapter }) => adapter.dispose()).catch(() => undefined);
      } else if (this.current === session) {
        const state = session.snapshot().state;
        if (state.state === "closed" && !state.cleanupError) this.current = undefined;
        else if (state.state === "closing") {
          const closingSession = session;
          void closingSession.close().then(
            () => {
              const closed = closingSession.snapshot().state;
              if (this.current === closingSession && closed.state === "closed" && !closed.cleanupError) {
                this.current = undefined;
              }
            },
            () => undefined,
          );
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.starting === pending) this.starting = undefined;
      finish();
    }
  }

  /** Interrupt startup and wait up to five seconds for the current session to close. */
  async stop(): Promise<StopResult> {
    const starting = this.starting;
    starting?.abort.abort(new DebugError("CANCELLED", "Debug session startup stopped."));
    const session = this.current;
    if (!session) {
      if (starting) await finishesWithin(starting.done, CLEANUP_WAIT_MS);
      return { kind: "noSession" };
    }

    const cleanup = session.close();
    void cleanup.then(
      () => {
        if (this.current === session) this.current = undefined;
      },
      () => undefined,
    );
    await finishesWithin(cleanup, CLEANUP_WAIT_MS);
    const snapshot = session.snapshot();
    return snapshot.state.state === "closed" ? { kind: "closed", snapshot } : { kind: "closing", snapshot };
  }

  /** Abort startup and give shared cleanup at most five seconds during shutdown. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const starting = this.starting;
    starting?.abort.abort(new DebugError("CANCELLED", "Debug session manager disposed."));
    const session = this.current;
    const cleanup = session?.close();
    if (session && cleanup) {
      void cleanup.then(
        () => {
          if (this.current === session) this.current = undefined;
        },
        () => undefined,
      );
    }
    this.disposePromise = (async () => {
      await finishesWithin(Promise.all([cleanup, starting?.done]), CLEANUP_WAIT_MS);
    })();
    return this.disposePromise;
  }

  private async resolveConfiguration(
    requested: string | DebugConfiguration,
    cwd: string,
    signal: AbortSignal,
  ): Promise<DebugConfiguration> {
    let configuration: DebugConfiguration;
    if (typeof requested === "string") {
      const saved = await observe(loadDebugConfigurations(cwd), signal);
      throwIfAborted(signal);
      const found = saved.find((candidate) => candidate.name === requested);
      if (!found) {
        throw new DebugError("INVALID_ARGUMENT", `Unknown debug configuration '${requested}'.`, {
          availableConfigurations: saved.map((candidate) => candidate.name),
        });
      }
      configuration = found;
    } else {
      configuration = resolveVariables(requested, cwd);
    }
    return {
      ...configuration,
      ...(typeof configuration.cwd === "string" ? { cwd: resolve(cwd, configuration.cwd) } : {}),
      ...(typeof configuration.program === "string" ? { program: resolve(cwd, configuration.program) } : {}),
    };
  }

  private assertAvailable(): void {
    if (this.disposePromise) throw new DebugError("INVALID_STATE", "Debug session manager is disposed.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
