import type { DebugProtocol } from "@vscode/debugprotocol";
import { resolve } from "node:path";
import { ZodError } from "zod";
import type { ResolvedDebugAdapter } from "../adapters/index.js";
import { getDebugAdapterProvider } from "../adapters/index.js";
import { loadDebugConfigurations, type DebugConfiguration } from "../config/launch-config.js";
import { resolveVariables } from "../config/variables.js";
import { finishesWithin, observe } from "./async.js";
import { DebugError, throwIfAborted } from "./errors.js";
import { DebugSession } from "./session.js";
import type {
  CloseSessionResult,
  DebugSessionId,
  DebugSessionSummary,
  InitialBreakpoints,
  SessionEndReason,
  SessionSnapshot,
  StartSessionResult,
} from "./types.js";

const START_TIMEOUT_MS = 30_000;
const CLEANUP_WAIT_MS = 5_000;

interface SessionRecord {
  id: DebugSessionId;
  cwd: string;
  parentId?: DebugSessionId;
  configuration?: DebugConfiguration;
  resolving?: Promise<ResolvedDebugAdapter>;
  resolveChild?: ResolvedDebugAdapter["resolveChild"];
  session?: DebugSession;
  state: "starting" | "closing" | "closed";
  reason?: SessionEndReason;
  abort: AbortController;
  startDone: Promise<void>;
  finishStart: () => void;
  closePromise?: Promise<void>;
  lateAdapterCleanup?: Promise<void>;
  cleanupError?: string;
}

/** Own multiple independently addressed debug sessions for one Pi extension session. */
export class DebugSessionManager {
  private readonly sessionsById = new Map<DebugSessionId, SessionRecord>();
  private nextSessionId = 1;
  private disposePromise: Promise<void> | undefined;

  /** Return complete saved configurations; the tool chooses which fields to display. */
  async listConfigurations(cwd: string, signal?: AbortSignal): Promise<DebugConfiguration[]> {
    this.assertAvailable();
    throwIfAborted(signal);
    const configurations = await observe(loadDebugConfigurations(cwd), signal);
    this.assertAvailable();
    return configurations;
  }

  /** Return lightweight local state for every manager-owned session. */
  listSessions(): DebugSessionSummary[] {
    this.assertAvailable();
    return [...this.sessionsById.values()].map((record) => this.summary(record));
  }

  /** Return locally observed state for one initialized session without querying its adapter. */
  status(sessionId: DebugSessionId): SessionSnapshot {
    return this.get(sessionId).snapshot();
  }

  /** Get one session without transferring ownership to the caller. */
  get(sessionId: DebugSessionId): DebugSession {
    this.assertAvailable();
    const record = this.requireRecord(sessionId);
    if (!record.session) {
      throw new DebugError("INVALID_STATE", `Debug session '${sessionId}' has not completed startup.`, {
        sessionId,
        state: record.state,
      });
    }
    return record.session;
  }

  /** Resolve a configuration and start a new independently addressed session. */
  start(
    cwd: string,
    options: {
      configuration: string | DebugConfiguration;
      breakpoints: InitialBreakpoints;
      waitMs: number;
    },
    signal?: AbortSignal,
  ): Promise<StartSessionResult> {
    return this.startSession(cwd, options, signal);
  }

  /** Close one session, waiting at most five seconds for startup and resource cleanup. */
  async closeSession(sessionId: DebugSessionId): Promise<CloseSessionResult> {
    this.assertAvailable();
    const record = this.requireRecord(sessionId);
    record.closePromise ??= this.closeRecord(record, { kind: "requested" });

    const closed = await finishesWithin(record.closePromise, CLEANUP_WAIT_MS);
    const snapshot = record.session?.snapshot();
    if (!closed) return { kind: "closing", ...(snapshot ? { snapshot } : {}) };

    if (this.sessionsById.get(sessionId) === record) this.sessionsById.delete(sessionId);
    return { kind: "closed", ...(snapshot ? { snapshot } : {}) };
  }

  /** Abort all startups and give all session cleanup one shared five-second budget. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const records = [...this.sessionsById.values()];
    const cleanups = records.map((record) => {
      record.closePromise ??= this.closeRecord(record, { kind: "requested" });
      return record.closePromise;
    });
    this.disposePromise = (async () => {
      await finishesWithin(Promise.allSettled(cleanups), CLEANUP_WAIT_MS);
      this.sessionsById.clear();
    })();
    return this.disposePromise;
  }

  private async startSession(
    cwd: string,
    options: {
      configuration: string | DebugConfiguration;
      breakpoints: InitialBreakpoints;
      waitMs: number;
    },
    signal?: AbortSignal,
    parent?: SessionRecord,
  ): Promise<StartSessionResult> {
    this.assertAvailable();
    throwIfAborted(signal);

    const record = this.createRecord(cwd, parent?.id);
    this.sessionsById.set(record.id, record);

    const deadline = Date.now() + START_TIMEOUT_MS;
    const timeout = new AbortController();
    const timeoutError = new DebugError("REQUEST_TIMEOUT", "Debug session startup timed out.", {
      timeoutMs: START_TIMEOUT_MS,
    });
    const timer = setTimeout(() => timeout.abort(timeoutError), START_TIMEOUT_MS);
    const startSignal = signal ? AbortSignal.any([signal, record.abort.signal]) : record.abort.signal;
    const setupSignal = AbortSignal.any([startSignal, timeout.signal]);
    let resolved: ResolvedDebugAdapter | undefined;
    let session: DebugSession | undefined;

    try {
      const configuration = await this.resolveConfiguration(options.configuration, cwd, setupSignal);
      record.configuration = configuration;
      throwIfAborted(setupSignal);
      if (Date.now() >= deadline) throw timeoutError;

      record.resolving = this.resolveAdapter(configuration, cwd, parent);
      try {
        resolved = await observe(record.resolving, setupSignal);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new DebugError("INVALID_ARGUMENT", error.message, undefined, { cause: error });
        }
        throw error;
      }
      throwIfAborted(setupSignal);
      if (Date.now() >= deadline) throw timeoutError;

      record.resolveChild = resolved.resolveChild;
      session = new DebugSession(resolved.adapter, resolved.configuration, cwd, {
        startDebugging: (arguments_, childSignal) => this.startChild(record, arguments_, childSignal),
        closeChildren: (reason) => this.closeChildren(record.id, reason),
      });
      record.configuration = resolved.configuration;
      record.session = session;
      clearTimeout(timer);
      const result = await session.start(
        { breakpoints: options.breakpoints, waitMs: options.waitMs, deadline },
        startSignal,
      );
      return { sessionId: record.id, ...result };
    } catch (error) {
      record.reason = endReason(error);
      if (!session) {
        const unused = resolved ? Promise.resolve(resolved) : record.resolving;
        if (unused) {
          record.state = "closing";
          record.lateAdapterCleanup = unused.then(
            ({ adapter }) => {
              adapter.dispose();
            },
            () => undefined,
          );
        } else {
          record.state = "closed";
        }
      }
      this.finishFailedStart(record);
      throw withSessionId(error, record.id);
    } finally {
      clearTimeout(timer);
      record.finishStart();
    }
  }

  private async startChild(
    parent: SessionRecord,
    arguments_: DebugProtocol.StartDebuggingRequestArguments,
    signal: AbortSignal,
  ): Promise<void> {
    const parentConfiguration = parent.configuration;
    if (!parentConfiguration) throw new DebugError("INVALID_STATE", "Parent debug session has no configuration.");
    const requestedName = arguments_.configuration.name;
    const configuration: DebugConfiguration = {
      ...arguments_.configuration,
      name:
        typeof requestedName === "string" && requestedName.length > 0
          ? requestedName
          : `${parentConfiguration.name} (child)`,
      type: parentConfiguration.type,
      request: arguments_.request,
    };
    await this.startSession(
      parent.cwd,
      {
        configuration,
        breakpoints: inheritedBreakpoints(parent.session),
        waitMs: 0,
      },
      signal,
      parent,
    );
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

  private resolveAdapter(
    configuration: DebugConfiguration,
    cwd: string,
    parent?: SessionRecord,
  ): Promise<ResolvedDebugAdapter> {
    if (parent?.resolveChild) return parent.resolveChild(configuration);
    try {
      return getDebugAdapterProvider(configuration.type).resolve(configuration, cwd);
    } catch (error) {
      throw new DebugError("INVALID_ARGUMENT", errorMessage(error), { type: configuration.type }, { cause: error });
    }
  }

  private createRecord(cwd: string, parentId?: DebugSessionId): SessionRecord {
    let finishStart!: () => void;
    const startDone = new Promise<void>((resolvePromise) => {
      finishStart = resolvePromise;
    });
    return {
      id: `debug-${this.nextSessionId++}`,
      cwd,
      parentId,
      abort: new AbortController(),
      startDone,
      finishStart,
      state: "starting",
    };
  }

  private finishFailedStart(record: SessionRecord): void {
    void Promise.resolve().then(async () => {
      await record.startDone;
      if (record.session) {
        const state = record.session.snapshot().state;
        // Cancelling only the initial observation does not invalidate a session
        // whose startup handshake already completed.
        if (state.state === "active") return;
        await record.session.close(record.reason).catch(() => undefined);
        const closed = record.session.snapshot().state;
        if (closed.state === "closed" && closed.cleanupError) record.cleanupError = closed.cleanupError;
      } else if (record.lateAdapterCleanup) {
        try {
          await record.lateAdapterCleanup;
        } catch (error) {
          record.cleanupError = errorMessage(error);
        }
      }
      record.state = "closed";
      if (!record.closePromise && !record.cleanupError && this.sessionsById.get(record.id) === record) {
        this.sessionsById.delete(record.id);
      }
    });
  }

  private async closeRecord(record: SessionRecord, reason: SessionEndReason): Promise<void> {
    record.reason ??= reason;
    record.state = "closing";
    record.abort.abort(
      new DebugError("CANCELLED", `Debug session '${record.id}' close requested.`, { sessionId: record.id }),
    );

    await record.startDone;
    try {
      await record.lateAdapterCleanup;
      await record.session?.close(reason);
    } catch (error) {
      record.cleanupError = errorMessage(error);
    } finally {
      record.state = "closed";
    }
  }

  private async closeChildren(parentId: DebugSessionId, reason: SessionEndReason): Promise<void> {
    const children = [...this.sessionsById.values()].filter((record) => record.parentId === parentId);
    const results = await Promise.allSettled(
      children.map((record) => {
        record.closePromise ??= this.closeRecord(record, reason);
        return record.closePromise;
      }),
    );
    const errors = results.flatMap((result, index) => {
      if (result.status === "rejected") return [errorMessage(result.reason)];
      const child = children[index];
      const state = child.session?.snapshot().state;
      const cleanupError = state?.state === "closed" ? state.cleanupError : child.cleanupError;
      return cleanupError ? [`${child.id}: ${cleanupError}`] : [];
    });
    if (errors.length) throw new Error(errors.join("; "));
  }

  private summary(record: SessionRecord): DebugSessionSummary {
    if (record.session) {
      const snapshot = record.session.snapshot();
      const state = snapshot.state;
      return {
        sessionId: record.id,
        ...(record.parentId ? { parentSessionId: record.parentId } : {}),
        configuration: snapshot.configuration,
        state: state.state,
        busy: snapshot.busy,
        ...(state.state === "closed" && state.cleanupError ? { cleanupError: state.cleanupError } : {}),
      };
    }
    return {
      sessionId: record.id,
      ...(record.parentId ? { parentSessionId: record.parentId } : {}),
      ...(record.configuration ? { configuration: { ...record.configuration } } : {}),
      state: record.state,
      ...(record.cleanupError ? { cleanupError: record.cleanupError } : {}),
    };
  }

  private requireRecord(sessionId: DebugSessionId): SessionRecord {
    const record = this.sessionsById.get(sessionId);
    if (!record) {
      const availableSessionIds = [...this.sessionsById.keys()].slice(0, 20);
      throw new DebugError("SESSION_NOT_FOUND", `Debug session '${sessionId}' does not exist.`, {
        sessionId,
        availableSessionIds,
        totalSessions: this.sessionsById.size,
      });
    }
    return record;
  }

  private assertAvailable(): void {
    if (this.disposePromise) throw new DebugError("INVALID_STATE", "Debug session manager is disposed.");
  }
}

function inheritedBreakpoints(session: DebugSession | undefined): InitialBreakpoints {
  if (!session) throw new DebugError("INVALID_STATE", "Parent debug session has not been created.");
  const breakpoints = session.listBreakpoints();
  return {
    source: breakpoints.source.flatMap((entry) =>
      entry.source.path ? [{ file: entry.source.path, lines: structuredClone(entry.specs) }] : [],
    ),
    ...(breakpoints.function ? { function: structuredClone(breakpoints.function.specs) } : {}),
  };
}

function endReason(error: unknown): SessionEndReason {
  return error instanceof DebugError && error.code === "CANCELLED"
    ? { kind: "requested" }
    : { kind: "error", message: errorMessage(error) };
}

function withSessionId(error: unknown, sessionId: DebugSessionId): unknown {
  if (!(error instanceof DebugError)) return error;
  return new DebugError(error.code, error.message, { ...error.details, sessionId }, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
