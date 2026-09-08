/**
 * A tiny, dependency-free, multi-subscriber typed event primitive.
 *
 * Replaces VS Code's single-callback `onEvent(cb)` setters (which error on a
 * second subscription) with an ergonomic emitter that returns a disposable per
 * listener and never throws on multiple subscribers.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (event: T) => void;

/** Read-only view exposed to consumers: subscribe only, cannot fire. */
export interface EventSource<T> {
  (listener: Listener<T>): Disposable;
}

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** The subscribable side. Call it with a listener to subscribe. */
  readonly event: EventSource<T> = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    // Copy to tolerate (un)subscription during iteration.
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Subscribe to a source exactly once, resolving with the first event. */
export function once<T>(source: EventSource<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const sub = source((value) => {
      sub.dispose();
      resolve(value);
    });
  });
}
