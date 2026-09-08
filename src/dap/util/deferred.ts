/** A promise together with its externally-callable resolve/reject handlers. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason?: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T | PromiseLike<T>): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveFn(value);
    }
  }

  reject(reason?: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectFn(reason);
    }
  }

  get isSettled(): boolean {
    return this.settled;
  }
}
