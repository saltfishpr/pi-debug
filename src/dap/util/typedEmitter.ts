import { EventEmitter } from "node:events";

/**
 * A minimal strongly-typed wrapper around Node's {@link EventEmitter}.
 *
 * `TEvents` maps an event name to the tuple of arguments its listeners receive.
 */
export type EventMap = Record<string, unknown[]>;

export type Listener<Args extends unknown[]> = (...args: Args) => void;

export interface Disposable {
  dispose(): void;
}

export class TypedEventEmitter<TEvents extends EventMap> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Debug adapters can emit a large number of distinct events; avoid the
    // default max-listeners warning without hiding genuine leaks entirely.
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof TEvents & string>(event: K, listener: Listener<TEvents[K]>): Disposable {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return { dispose: () => this.off(event, listener) };
  }

  once<K extends keyof TEvents & string>(event: K, listener: Listener<TEvents[K]>): Disposable {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return { dispose: () => this.off(event, listener) };
  }

  off<K extends keyof TEvents & string>(event: K, listener: Listener<TEvents[K]>): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  protected emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
