/** 可显式释放的资源；异步释放必须返回完成时才兑现的 Promise。 */
export interface Disposable {
  /** 释放资源；异步资源应在清理完成后再兑现 Promise。 */
  dispose(): void | Promise<void>;
}

/** 按登记顺序释放资源；清理失败不会跳过后续资源。 */
export class AsyncDisposableStore implements Disposable {
  private readonly resources = new Set<Disposable>();
  /** 共享的关闭结果；存在即表示不再接受新资源。 */
  private closing: Promise<void> | undefined;

  /** 关闭一经开始即为 true，不表示异步清理已经完成。 */
  get isDisposed(): boolean {
    return this.closing !== undefined;
  }

  /** 登记资源并返回它；关闭后禁止登记，同一对象只登记一次。 */
  add<T extends Disposable>(resource: T): T {
    if (this.isDisposed) throw new Error("Cannot add resources to a disposed store.");
    if (Object.is(resource, this)) throw new Error("Cannot register a store on itself.");
    this.resources.add(resource);
    return resource;
  }

  /** 移除已自行释放的资源，不调用 dispose。 */
  delete(resource: Disposable): void {
    this.resources.delete(resource);
  }

  /** 共享同一次关闭结果；全部清理完成后再报告错误。 */
  dispose(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        for (const resource of this.resources) {
          try {
            await resource.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        this.resources.clear();
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to release resources.");
    });
    return this.closing;
  }
}
