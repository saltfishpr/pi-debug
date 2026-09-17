import type { DebugProtocol } from "@vscode/debugprotocol";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { DapClient, type DapRequests } from "../dap/index.js";

/** 描述返回给调用方的单个变量及其按需展开的子变量。 */
interface VariableView {
  /** 变量在当前作用域或父变量中的名称。 */
  name: string;
  /** Adapter 格式化后的变量值。 */
  value: string;
  /** Adapter 提供的可选变量类型。 */
  type?: string;
  /** 在深度和预算允许时递归展开的子变量。 */
  children?: VariableView[];
  /** 标记变量是否仍有可通过 DAP 引用获取的子项。 */
  expandable?: boolean;
}

/** 记录一次变量树展开尚可使用的节点数和字符数预算。 */
interface VariableBudget {
  /** 尚可加入结果的变量节点数。 */
  remaining: number;
  /** 尚可加入结果的字符数。 */
  characters: number;
  /** 标记结果是否因节点、字符、深度或循环引用限制而被截断。 */
  truncated: boolean;
}

/** 保存线程的运行证据；undefined 表示尚无停止或继续事件确认。 */
interface ThreadRecord {
  name?: string;
  stopped?: boolean;
  details?: DebugProtocol.StoppedEvent["body"];
  revision: number;
  continuedRevision?: number;
  stoppedAt?: number;
}

/** 维护单个事件驱动的 DAP 会话，并封装不会向外泄漏的帧与变量引用。 */
export class DebugSession {
  /** 会话工作目录，用于把调用方传入的相对路径解析为绝对路径。 */
  readonly workspaceFolder: string;
  /** 与 Debug Adapter 通信的 DAP 客户端。 */
  private readonly client: DapClient;
  /** 会话的启动模式，决定启动请求及关闭时是否终止被调试进程。 */
  private readonly launchCommand: "launch" | "attach";
  /** initialize 请求中声明的 Debug Adapter 标识。 */
  private readonly adapterID: string;

  /** 当前调试会话状态。 */
  private state: "starting" | "running" | "stopped" | "terminated" = "starting";
  /** 标记 Adapter 是否已发送 initialized 事件。 */
  private initialized = false;
  /** Adapter 声明及后续动态更新的能力集合。 */
  private capabilities: DebugProtocol.Capabilities = {};
  /** 连接异常终止时记录的失败信息。 */
  private failure: string | undefined;
  /** 被调试进程通过 exited 事件报告的退出码。 */
  private exitCode: number | undefined;
  /** 共享的关闭流程 Promise，用于保证 close 幂等。 */
  private closing: Promise<void> | undefined;

  /** 会话状态变化通知器，供异步等待逻辑订阅。 */
  private readonly changes = new EventEmitter();

  /** 线程目录与事件确认的停止状态；不缓存帧或变量引用。 */
  private readonly threads = new Map<number, ThreadRecord>();
  /** 记录已通过 thread exited 事件退出的线程 ID，避免后续 refresh 复活。 */
  private readonly exitedThreads = new Set<number>();
  /** 当前默认操作的线程，通常是最近一次 stopped 事件报告的线程。 */
  private selectedThread: number | undefined;
  /** 事件确认的所有线程整体停止标志。 */
  private allStopped = false;
  /** 尚未枚举的线程继承最近的全局事件；局部继续不能抹掉其他线程的全停证据。 */
  private defaultStopped: boolean | undefined;

  /** 执行状态的修订号，用于识别早于请求响应到达的 stopped 事件。 */
  private revision = 0;
  /** 记录最近一次 stopped 事件对应的修订号，用于等待新一次停止。 */
  private stopRevision = 0;
  /** 记录最近一次 allThreadsStopped 事件的修订号，避免其他线程的继续操作抹掉全停证据。 */
  private allStoppedRevision = 0;
  /** 记录最近一次 allThreadsContinued 事件的修订号，用于判断是否需要根据响应补写线程状态。 */
  private allContinuedRevision = 0;

  /** 尚未通过 status 返回的 Adapter 输出。 */
  private output = "";
  /** 标记当前缓存的 Adapter 输出是否因长度限制被截断。 */
  private outputTruncated = false;

  /** 创建会话并注册 DAP 事件、Adapter 输出和连接关闭监听器。 */
  constructor(workspaceFolder: string, client: DapClient, launchCommand: "launch" | "attach", adapterID: string) {
    this.workspaceFolder = workspaceFolder;
    this.client = client;
    this.launchCommand = launchCommand;
    this.adapterID = adapterID;
    client.onEvent((event) => this.onEvent(event));
    client.onOutput("stderr", (data) => this.appendOutput(data.toString("utf8")));
    client.onOutput("stdout", (data) => this.appendOutput(data.toString("utf8")));
    client.onClose((error) => {
      if (this.state !== "terminated") this.failure = error.message;
      this.state = "terminated";
      this.threads.clear();
      this.selectedThread = undefined;
      this.allStopped = false;
      this.defaultStopped = undefined;
      this.revision++;
      this.changes.emit("change");
    });
  }

  // -- 生命周期 -------------------------------------------------------------

  /** 连接 Adapter、完成 DAP 初始化和断点配置，并返回启动后的会话状态。 */
  async start(
    configuration: Record<string, unknown>,
    initialBreakpoints: { file: string; lines: number[] }[] = [],
    waitMs = 1000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      await this.client.connect({ signal });
      this.capabilities =
        (await this.request(
          "initialize",
          {
            clientID: "pi-debug",
            clientName: "Pi Debug",
            adapterID: this.adapterID,
            pathFormat: "path",
            linesStartAt1: true,
            columnsStartAt1: true,
            supportsRunInTerminalRequest: false,
            supportsStartDebuggingRequest: false,
            supportsVariableType: true,
          },
          signal,
        )) ?? {};
      // launch 可能要等到 configurationDone 后才返回，因此并行执行启动与配置流程。
      const launching = this.request(this.launchCommand, configuration, signal);
      const configuring = (async () => {
        await this.waitUntil(() => this.initialized, 30000, signal);
        if (!this.initialized) throw new Error(this.failure ?? "Adapter did not send initialized.");
        const breakpoints = [];
        for (const item of initialBreakpoints) {
          breakpoints.push(await this.setBreakpoints(item.file, item.lines, signal));
        }
        if (this.capabilities.exceptionBreakpointFilters?.length) {
          await this.request("setExceptionBreakpoints", { filters: [] }, signal);
        }
        if (this.capabilities.supportsConfigurationDoneRequest) {
          await this.request("configurationDone", {}, signal);
        }
        return breakpoints;
      })();
      const [, breakpoints] = await Promise.all([launching, configuring]);
      if (this.state === "starting") this.state = "running";
      const result = await this.wait(undefined, waitMs, signal);
      return { ...this.snapshot(), ...result, breakpoints };
    } catch (error) {
      const diagnostics = this.output;
      await this.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}${diagnostics ? `\nAdapter output: ${diagnostics}` : ""}`, { cause: error });
    }
  }

  /** 幂等断开 DAP 会话并释放底层客户端资源。 */
  close(terminateDebuggee = this.launchCommand === "launch"): Promise<void> {
    this.closing ??= (async () => {
      try {
        if (this.initialized) {
          await this.client.request(
            "disconnect",
            this.capabilities.supportTerminateDebuggee ? { terminateDebuggee } : {},
            { timeoutMs: 3000 },
          );
        }
      } catch {
        // Adapter 失败或断开连接时，仍须继续清理底层 transport。
      } finally {
        this.state = "terminated";
        this.threads.clear();
        this.allStopped = false;
        this.defaultStopped = undefined;
        this.selectedThread = undefined;
        this.revision++;
        this.changes.emit("change");
        await this.client.close();
      }
    })();
    return this.closing;
  }

  // -- 会话状态查询 ---------------------------------------------------------

  /** 返回当前会话快照，并消费自上次查询后累积的 Adapter 输出。 */
  snapshot() {
    const selected = this.selectedThread === undefined ? undefined : this.threads.get(this.selectedThread);
    const result = {
      state: this.state,
      reason: selected?.details?.reason,
      threadId: this.selectedThread,
      description: selected?.details?.description,
      allThreadsStopped: this.state === "stopped" ? this.allStopped : undefined,
      knownThreadCount: this.threads.size,
      knownStoppedThreadCount: [...this.threads.values()].filter((thread) => thread.stopped).length,
      supportsSingleThreadExecution: this.capabilities.supportsSingleThreadExecutionRequests === true,
      exitCode: this.exitCode,
      error: this.failure,
      output: this.output,
      outputTruncated: this.outputTruncated,
    };
    this.output = "";
    this.outputTruncated = false;
    return result;
  }

  // -- 断点与执行控制 -------------------------------------------------------

  /** 替换指定源文件的全部断点，并返回 Adapter 验证后的断点信息。 */
  async setBreakpoints(file: string, lines: number[], signal?: AbortSignal) {
    const path = resolve(this.workspaceFolder, file);
    const result = await this.request(
      "setBreakpoints",
      {
        source: { path },
        breakpoints: lines.map((line) => ({ line })),
        sourceModified: false,
      },
      signal,
    );
    return { file: path, breakpoints: result?.breakpoints ?? [] };
  }

  /** 执行继续、单步或暂停操作，并等待下一次停止或终止。 */
  async control(
    action: "continue" | "next" | "stepIn" | "stepOut" | "pause",
    singleThread = false,
    threadId?: number,
    waitMs = 1000,
    signal?: AbortSignal,
  ) {
    if (singleThread && (action === "pause" || !this.capabilities.supportsSingleThreadExecutionRequests)) {
      throw new Error("singleThread requires a supported continue or stepping action.");
    }
    threadId = await this.thread(threadId, signal, action === "pause" ? "running" : "stopped");
    const revision = this.revision;
    const response = await this.request(action, { threadId, ...(singleThread ? { singleThread } : {}) }, signal);
    // 响应仅补全尚未被更新事件覆盖的线程状态。
    if (
      action !== "pause" &&
      this.state !== "terminated" &&
      this.allContinuedRevision <= revision &&
      (this.threads.get(threadId)?.continuedRevision ?? 0) <= revision
    ) {
      // 单步默认允许其他线程恢复；没有事件确认时不能承诺其他线程仍暂停。
      const all =
        action === "continue"
          ? (response as DebugProtocol.ContinueResponse["body"])?.allThreadsContinued !== false
          : !singleThread;
      this.continued(threadId, all, revision);
    }
    const result = await this.waitForStop(threadId, waitMs, signal, revision);
    return { ...this.snapshot(), ...result };
  }

  /** 等待会话停止、终止或达到指定超时时间。 */
  async wait(threadId?: number, timeout = 1000, signal?: AbortSignal) {
    if (threadId !== undefined && this.state !== "terminated" && !this.exitedThreads.has(threadId)) {
      await this.refreshThreads(signal);
      if (!this.threads.has(threadId) && !this.exitedThreads.has(threadId))
        throw new Error(`Thread ${threadId} is unavailable.`);
    }
    return this.waitForStop(threadId, timeout, signal);
  }

  // -- 线程、调用栈与变量查询 -----------------------------------------------------

  /** 查询当前线程列表，并保留事件提供的逐线程停止状态。 */
  async listThreads(start = 0, count = 50, signal?: AbortSignal) {
    await this.refreshThreads(signal);
    const threads = [...this.threads]
      .sort(([a], [b]) => a - b)
      .slice(start, start + count)
      .map(([threadId, thread]) => ({
        threadId,
        name: thread.name?.slice(0, 200),
        state: thread.stopped === undefined ? "unknown" : thread.stopped ? "stopped" : "running",
        reason: thread.details?.reason,
        description: thread.details?.description?.slice(0, 500),
      }));
    return {
      threads,
      totalThreads: this.threads.size,
      nextStart: start + count < this.threads.size ? start + count : undefined,
    };
  }

  /** 分页获取目标线程的调用栈，frame 始终使用整个栈的零基索引。 */
  async stackTrace(threadId?: number, start = 0, count = 20, signal?: AbortSignal) {
    threadId = await this.thread(threadId, signal, "stopped");
    const result = await this.request(
      "stackTrace",
      { threadId, ...(this.capabilities.supportsDelayedStackTraceLoading ? { startFrame: start, levels: count } : {}) },
      signal,
    );
    const frames = this.capabilities.supportsDelayedStackTraceLoading
      ? (result?.stackFrames ?? []).slice(0, count)
      : (result?.stackFrames ?? []).slice(start, start + count);
    const totalFrames =
      result?.totalFrames ??
      (this.capabilities.supportsDelayedStackTraceLoading ? undefined : result?.stackFrames.length);
    const hasMore =
      frames.length > 0 && (totalFrames === undefined ? frames.length === count : start + frames.length < totalFrames);
    return {
      threadId,
      totalFrames,
      nextStart: hasMore ? start + frames.length : undefined,
      frames: frames.map((frame, index) => ({
        frame: start + index,
        name: frame.name.slice(0, 200),
        file: frame.source?.path,
        line: frame.line,
        column: frame.column,
      })),
    };
  }

  /** 获取指定栈帧和作用域中的变量树，并应用节点、字符及深度限制。 */
  async variables(
    threadId?: number,
    frameIndex = 0,
    scopeName = "locals",
    depth = 2,
    maxChildren = 50,
    signal?: AbortSignal,
  ) {
    threadId = await this.thread(threadId, signal, "stopped");
    const revision = this.revision;
    const frame = await this.frame(threadId, frameIndex, signal);
    this.checkRevision(revision);
    const result = await this.request("scopes", { frameId: frame.id }, signal);
    const scopes = result?.scopes ?? [];
    const scope =
      scopeName.toLowerCase() === "locals"
        ? scopes.find((item) => item.presentationHint === "locals" || /^locals?$/i.test(item.name))
        : scopes.find((item) => item.name.toLowerCase() === scopeName.toLowerCase());
    if (!scope) {
      throw new Error(
        `Scope '${scopeName}' not found. Available scopes: ${scopes.map((item) => item.name).join(", ")}`,
      );
    }
    const budget = { remaining: 100, characters: 12000, truncated: false };
    const variables = await this.expand(scope.variablesReference, depth, maxChildren, budget, new Set(), signal);
    this.checkRevision(revision);
    return { threadId, frame: frameIndex, scope: scope.name, variables, truncated: budget.truncated };
  }

  /** 在指定栈帧上下文中求值表达式，并限制返回文本长度。 */
  async evaluate(expression?: string, threadId?: number, frameIndex = 0, signal?: AbortSignal) {
    if (!expression) throw new Error("evaluate requires expression.");
    threadId = await this.thread(threadId, signal, "stopped");
    const revision = this.revision;
    const frame = await this.frame(threadId, frameIndex, signal);
    this.checkRevision(revision);
    const result = await this.request(
      "evaluate",
      {
        expression,
        frameId: frame.id,
        context: "watch",
      },
      signal,
    );
    return {
      threadId,
      frame: frameIndex,
      result: result?.result.slice(0, 2000),
      type: result?.type,
      truncated: (result?.result.length ?? 0) > 2000,
      expandable: (result?.variablesReference ?? 0) > 0,
    };
  }

  /** 返回同一线程的调用栈和所选栈帧变量。 */
  async inspect(threadId?: number, frame = 0, scope = "locals", depth = 2, maxChildren = 50, signal?: AbortSignal) {
    threadId = await this.thread(threadId, signal, "stopped");
    const revision = this.revision;
    const stack = await this.stackTrace(threadId, 0, 20, signal);
    this.checkRevision(revision);
    const variables = await this.variables(threadId, frame, scope, depth, maxChildren, signal);
    this.checkRevision(revision);
    return { state: this.state, reason: this.threads.get(threadId)?.details?.reason, ...stack, ...variables };
  }

  // -- 内部：DAP 请求 -------------------------------------------------------

  /** 发送类型安全的 DAP 请求，并从响应中提取命令对应的 body。 */
  private async request<K extends keyof DapRequests>(
    command: K,
    args: DapRequests[K][0],
    signal?: AbortSignal,
  ): Promise<DapRequests[K][1]["body"]> {
    const revision = this.revision;
    const response = await this.client.request(command, args, { signal });
    if (["stackTrace", "scopes", "variables", "evaluate"].includes(command)) this.checkRevision(revision);
    return response.body as DapRequests[K][1]["body"];
  }

  private checkRevision(revision: number): void {
    if (revision !== this.revision || this.state === "terminated") {
      throw new Error(
        "Debug context changed during inspection. Query threads and inspect again; evaluation was not retried.",
      );
    }
  }

  // -- 内部：线程与栈帧 -----------------------------------------------------

  private async refreshThreads(signal?: AbortSignal, retry = true): Promise<void> {
    if (this.state === "terminated") return;
    const revision = this.revision;
    const result = await this.request("threads", undefined, signal);
    if (this.isTerminated()) return;
    // 事件与 threads 响应交错时，重取目录，避免复活已退出的线程。
    if (revision !== this.revision) {
      if (retry) return this.refreshThreads(signal, false);
      throw new Error("Threads changed during discovery. Query threads again.");
    }
    const ids = new Set((result?.threads ?? []).map((thread) => thread.id));
    for (const id of this.threads.keys()) {
      if (!ids.has(id)) {
        this.threads.delete(id);
        this.exitedThreads.add(id);
        this.revision++;
      }
    }
    for (const thread of result?.threads ?? []) {
      const current = this.threads.get(thread.id);
      this.threads.set(thread.id, {
        ...current,
        name: thread.name,
        stopped: current ? current.stopped : this.defaultStopped,
        revision: current?.revision ?? this.revision,
      });
      this.exitedThreads.delete(thread.id);
    }
    this.updateState();
  }

  private async thread(
    id: number | undefined,
    signal?: AbortSignal,
    required?: "running" | "stopped",
  ): Promise<number> {
    if (this.state === "terminated") throw new Error("Session is terminated.");
    await this.refreshThreads(signal);
    if (
      id === undefined &&
      required !== "running" &&
      this.selectedThread !== undefined &&
      this.threads.get(this.selectedThread)?.stopped
    ) {
      id = this.selectedThread;
    }
    if (id === undefined) {
      const candidates = [...this.threads].filter(
        ([, thread]) =>
          required === undefined || (required === "stopped" ? thread.stopped === true : thread.stopped !== true),
      );
      if (candidates.length !== 1) {
        const reason = candidates.length
          ? "multiple eligible threads; specify threadId from threads"
          : "no eligible threads";
        throw new Error(`Session is ${this.state}; ${reason}.`);
      }
      id = candidates[0][0];
    }
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Thread ${id} is unavailable. Use threads to select a current thread.`);
    if (required && (required === "stopped" ? thread.stopped !== true : thread.stopped === true)) {
      throw new Error(`Thread ${id} must be ${required}.`);
    }
    return id;
  }

  /** 获取调用方指定索引处的单个栈帧，供变量查询和表达式求值使用。 */
  private async frame(threadId: number, index = 0, signal?: AbortSignal) {
    const paged = this.capabilities.supportsDelayedStackTraceLoading;
    const result = await this.request(
      "stackTrace",
      { threadId, ...(paged ? { startFrame: index, levels: 1 } : {}) },
      signal,
    );
    const frame = result?.stackFrames[paged ? 0 : index];
    if (!frame) throw new Error(`Stack frame ${index} is unavailable.`);
    return frame;
  }

  // -- 内部：状态更新 -------------------------------------------------------

  private updateState(): void {
    if (this.state === "terminated") return;
    const stopped = [...this.threads].filter(([, thread]) => thread.stopped);
    this.state = this.allStopped || stopped.length ? "stopped" : this.state === "starting" ? "starting" : "running";
    if (this.selectedThread === undefined || !this.threads.get(this.selectedThread)?.stopped) {
      const latest = stopped
        .filter(([, thread]) => thread.details)
        .sort(([, a], [, b]) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0))[0];
      this.selectedThread = latest?.[0] ?? (stopped.length === 1 ? stopped[0][0] : undefined);
    }
  }

  private continued(threadId: number, all: boolean, before = Infinity): void {
    if (this.allStoppedRevision <= before) {
      this.allStopped = false;
      if (all) this.defaultStopped = false;
    }
    if (!all && !this.threads.has(threadId) && !this.exitedThreads.has(threadId)) {
      this.threads.set(threadId, { stopped: false, revision: this.revision });
    }
    for (const [id, thread] of this.threads) {
      if ((all || id === threadId) && thread.revision <= before) {
        thread.stopped = false;
        thread.details = undefined;
        thread.revision = this.revision;
      }
    }
    this.updateState();
  }

  private isTerminated(): boolean {
    return this.state === "terminated";
  }

  // -- 内部：变量展开 -------------------------------------------------------

  /** 在共享预算内递归展开变量引用，并阻止沿当前路径形成循环引用。 */
  private async expand(
    reference: number,
    depth: number,
    maxChildren: number,
    budget: VariableBudget,
    ancestors: Set<number>,
    signal?: AbortSignal,
  ): Promise<VariableView[]> {
    if (!reference || depth === 0 || ancestors.has(reference)) return [];
    const result = await this.request("variables", { variablesReference: reference }, signal);
    const all = result?.variables ?? [];
    const selected = all.slice(0, Math.min(maxChildren, budget.remaining));
    if (selected.length < all.length) budget.truncated = true;
    budget.remaining -= selected.length;
    const path = new Set(ancestors).add(reference);
    const values: VariableView[] = [];
    /** 按单值上限和共享字符预算截断变量文本。 */
    const text = (input: string, maximum: number): string => {
      const result = input.slice(0, Math.min(maximum, budget.characters));
      budget.characters -= result.length;
      if (result.length < input.length) budget.truncated = true;
      return result;
    };
    for (const item of selected) {
      if (budget.characters <= 0) {
        budget.truncated = true;
        break;
      }
      const value: VariableView = {
        name: text(item.name, 200),
        value: text(item.value, 2000),
        type: item.type === undefined ? undefined : text(item.type, 200),
      };
      if (item.variablesReference > 0) {
        value.expandable = true;
        if (depth > 1 && budget.remaining > 0 && budget.characters > 0 && !path.has(item.variablesReference)) {
          value.children = await this.expand(item.variablesReference, depth - 1, maxChildren, budget, path, signal);
        } else budget.truncated = true;
      }
      values.push(value);
    }
    return values;
  }

  // -- 内部：事件处理 -------------------------------------------------------

  /** 将 DAP 事件归并到本地会话状态，并通知所有等待者重新检查条件。 */
  private onEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "initialized":
        this.initialized = true;
        break;
      case "stopped": {
        if (this.state === "terminated") break;
        this.stopRevision = ++this.revision;
        const details = event.body as DebugProtocol.StoppedEvent["body"];
        if (details.allThreadsStopped) {
          this.allStopped = true;
          this.defaultStopped = true;
          this.allStoppedRevision = this.revision;
          for (const thread of this.threads.values()) {
            thread.stopped = true;
            thread.revision = this.revision;
          }
        }
        if (details.threadId !== undefined) {
          const thread = this.threads.get(details.threadId);
          this.threads.set(details.threadId, {
            ...thread,
            stopped: true,
            details,
            revision: this.revision,
            stoppedAt: this.revision,
          });
          this.exitedThreads.delete(details.threadId);
          this.selectedThread = details.threadId;
        }
        this.updateState();
        break;
      }
      case "continued": {
        if (this.state === "terminated") break;
        this.revision++;
        const body = event.body as DebugProtocol.ContinuedEvent["body"];
        this.continued(body.threadId, body.allThreadsContinued !== false);
        if (body.allThreadsContinued !== false) this.allContinuedRevision = this.revision;
        else {
          const thread = this.threads.get(body.threadId);
          if (thread) thread.continuedRevision = this.revision;
        }
        break;
      }
      case "thread": {
        if (this.state === "terminated") break;
        const body = event.body as DebugProtocol.ThreadEvent["body"];
        this.revision++;
        if (body.reason === "exited") {
          this.threads.delete(body.threadId);
          this.exitedThreads.add(body.threadId);
        } else if (body.reason === "started") {
          // started 只确认线程存在，不保证 Adapter 已恢复该线程。
          if (!this.threads.has(body.threadId)) this.threads.set(body.threadId, { revision: this.revision });
          this.exitedThreads.delete(body.threadId);
          this.allStopped = false;
        }
        this.updateState();
        break;
      }
      case "terminated":
        this.state = "terminated";
        this.revision++;
        this.selectedThread = undefined;
        this.threads.clear();
        this.allStopped = false;
        this.defaultStopped = undefined;
        // terminated 结束调试会话，但 Adapter 可能仍在等待 disconnect 才会退出。
        void this.close(false).catch((error) => {
          this.failure = error instanceof Error ? error.message : String(error);
        });
        break;
      case "invalidated":
        this.revision++;
        break;
      case "exited":
        this.exitCode = (event.body as DebugProtocol.ExitedEvent["body"]).exitCode;
        break;
      case "output":
        this.appendOutput((event.body as DebugProtocol.OutputEvent["body"]).output);
        break;
      case "capabilities":
        Object.assign(this.capabilities, (event.body as DebugProtocol.CapabilitiesEvent["body"]).capabilities);
        break;
    }
    this.changes.emit("change");
  }

  /** 追加 Adapter 输出，并仅保留最新的限定长度内容。 */
  private appendOutput(text: string): void {
    if (this.output.length + text.length > 16000) this.outputTruncated = true;
    this.output = (this.output + text).slice(-16000);
  }

  // -- 内部：等待原语 -------------------------------------------------------

  /** 等待谓词成立、会话终止、调用取消或超时，并在结束时移除监听器。 */
  private async waitUntil(predicate: () => boolean, timeout: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (predicate() || this.state === "terminated" || timeout === 0) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.changes.off("change", changed);
        signal?.removeEventListener("abort", aborted);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const changed = () => {
        if (predicate() || this.state === "terminated") done();
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Debug operation aborted."));
      };
      const timer = setTimeout(done, timeout);
      this.changes.on("change", changed);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private async waitForStop(threadId: number | undefined, timeout: number, signal?: AbortSignal, after?: number) {
    const outcome = () => {
      if (this.state === "terminated") return "terminated";
      if (threadId !== undefined && this.exitedThreads.has(threadId)) return "thread_exited";
      const stopped =
        after !== undefined
          ? this.stopRevision > after
          : threadId === undefined
            ? this.state === "stopped"
            : this.threads.get(threadId)?.stopped;
      if (stopped) return "stopped";
      return undefined;
    };
    await this.waitUntil(() => outcome() !== undefined, timeout, signal);
    const waitOutcome = outcome() ?? "timeout";
    if (this.state === "terminated") await this.close(false);
    return { waitOutcome, waitedThreadId: threadId };
  }
}
