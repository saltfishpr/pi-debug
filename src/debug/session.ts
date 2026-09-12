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

/** 维护单个事件驱动的 DAP 会话，并封装不会向外泄漏的帧与变量引用。 */
export class DebugSession {
  readonly workspaceFolder: string;
  /** 与 Debug Adapter 通信的 DAP 客户端。 */
  private readonly client: DapClient;
  /** 会话的启动模式，决定启动请求及关闭时是否终止被调试进程。 */
  private readonly launchCommand: "launch" | "attach";
  /** initialize 请求中声明的 Debug Adapter 标识。 */
  private readonly adapterID: string;
  /** 会话状态变化通知器，供异步等待逻辑订阅。 */
  private readonly changes = new EventEmitter();
  /** 当前调试会话状态。 */
  private state: "starting" | "running" | "stopped" | "terminated" = "starting";
  /** 标记 Adapter 是否已发送 initialized 事件。 */
  private initialized = false;
  /** 最近一次 stopped 事件的上下文，用于定位默认线程及报告停止原因。 */
  private stopped: DebugProtocol.StoppedEvent["body"] | undefined;
  /** Adapter 声明及后续动态更新的能力集合。 */
  private capabilities: DebugProtocol.Capabilities = {};
  /** 执行状态的修订号，用于识别早于请求响应到达的 stopped 事件。 */
  private revision = 0;
  /** 尚未通过 status 返回的 Adapter 输出。 */
  private output = "";
  /** 标记当前缓存的 Adapter 输出是否因长度限制被截断。 */
  private outputTruncated = false;
  /** 连接异常终止时记录的失败信息。 */
  private failure: string | undefined;
  /** 被调试进程通过 exited 事件报告的退出码。 */
  private exitCode: number | undefined;
  /** 共享的关闭流程 Promise，用于保证 close 幂等。 */
  private closing: Promise<void> | undefined;

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
      this.changes.emit("change");
    });
  }

  // -- 生命周期 ---------------------------------------------------------------

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
      await this.wait(waitMs, signal);
      return { ...this.status(), breakpoints };
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
        this.stopped = undefined;
        this.changes.emit("change");
        await this.client.close();
      }
    })();
    return this.closing;
  }

  // -- 状态与执行控制 ---------------------------------------------------------

  /** 返回当前会话快照，并消费自上次查询后累积的 Adapter 输出。 */
  status() {
    const result = {
      state: this.state,
      reason: this.stopped?.reason,
      threadId: this.stopped?.threadId,
      description: this.stopped?.description,
      exitCode: this.exitCode,
      error: this.failure,
      output: this.output,
      outputTruncated: this.outputTruncated,
    };
    this.output = "";
    this.outputTruncated = false;
    return result;
  }

  /** 等待会话停止、终止或达到指定超时时间。 */
  async wait(timeout: number, signal?: AbortSignal): Promise<void> {
    await this.waitUntil(() => this.state === "stopped" || this.state === "terminated", timeout, signal);
    if (this.state === "terminated") await this.close(false);
  }

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
    threadId?: number,
    waitMs = 1000,
    signal?: AbortSignal,
  ) {
    if (action !== "pause") this.requireStopped();
    else if (this.state !== "running") throw new Error("pause requires a running session.");
    threadId = await this.thread(threadId, signal);
    const revision = this.revision;
    await this.request(action, { threadId }, signal);
    // stopped 事件可能先于请求响应到达，此时不能覆盖事件带来的较新状态。
    if (action !== "pause" && revision === this.revision && this.state !== "terminated") {
      this.state = "running";
      this.stopped = undefined;
    }
    await this.wait(waitMs, signal);
    return this.status();
  }

  // -- 调试数据查询 -----------------------------------------------------------

  /** 获取目标线程顶部有限数量的调用栈帧。 */
  async stackTrace(threadId?: number, signal?: AbortSignal) {
    this.requireStopped();
    threadId = await this.thread(threadId, signal);
    const result = await this.request(
      "stackTrace",
      { threadId, ...(this.capabilities.supportsDelayedStackTraceLoading ? { startFrame: 0, levels: 20 } : {}) },
      signal,
    );
    return {
      threadId,
      totalFrames: result?.totalFrames,
      frames: (result?.stackFrames ?? []).slice(0, 20).map((frame, index) => ({
        frame: index,
        name: frame.name,
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
    const frame = await this.frame(threadId, frameIndex, signal);
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
    return { frame: frameIndex, scope: scope.name, variables, truncated: budget.truncated };
  }

  /** 在指定栈帧上下文中求值表达式，并限制返回文本长度。 */
  async evaluate(expression?: string, threadId?: number, frameIndex = 0, signal?: AbortSignal) {
    if (!expression) throw new Error("evaluate requires expression.");
    const frame = await this.frame(threadId, frameIndex, signal);
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
      result: result?.result.slice(0, 2000),
      type: result?.type,
      truncated: (result?.result.length ?? 0) > 2000,
      expandable: (result?.variablesReference ?? 0) > 0,
    };
  }

  // -- 内部：DAP 数据访问 -----------------------------------------------------

  /** 发送类型安全的 DAP 请求，并从响应中提取命令对应的 body。 */
  private async request<K extends keyof DapRequests>(
    command: K,
    args: DapRequests[K][0],
    signal?: AbortSignal,
  ): Promise<DapRequests[K][1]["body"]> {
    const response = await this.client.request(command, args, { signal });
    return response.body as DapRequests[K][1]["body"];
  }

  /** 解析显式线程、当前停止线程或 Adapter 返回的首个可用线程。 */
  private async thread(id: number | undefined, signal?: AbortSignal): Promise<number> {
    if (id !== undefined) return id;
    if (this.stopped?.threadId !== undefined) return this.stopped.threadId;
    const result = await this.request("threads", undefined, signal);
    const thread = result?.threads[0];
    if (!thread) throw new Error("No debuggee threads are available.");
    return thread.id;
  }

  /** 获取调用方指定索引处的单个栈帧，供变量查询和表达式求值使用。 */
  private async frame(threadId?: number, index = 0, signal?: AbortSignal) {
    this.requireStopped();
    threadId = await this.thread(threadId, signal);
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

  /** 断言会话当前已停止，避免在无稳定帧上下文时读取或单步。 */
  private requireStopped(): void {
    if (this.state !== "stopped")
      throw new Error(`Session is ${this.state}; wait for a stop before inspecting or stepping.`);
  }

  // -- 内部：事件与等待 -------------------------------------------------------

  /** 追加 Adapter 输出，并仅保留最新的限定长度内容。 */
  private appendOutput(text: string): void {
    if (this.output.length + text.length > 16000) this.outputTruncated = true;
    this.output = (this.output + text).slice(-16000);
  }

  /** 将 DAP 事件归并到本地会话状态，并通知所有等待者重新检查条件。 */
  private onEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "initialized":
        this.initialized = true;
        break;
      case "stopped":
        if (this.state === "terminated") break;
        this.revision++;
        this.stopped = event.body as DebugProtocol.StoppedEvent["body"];
        this.state = "stopped";
        break;
      case "continued":
        if (this.state === "terminated") break;
        this.revision++;
        this.state = "running";
        this.stopped = undefined;
        break;
      case "terminated":
        this.state = "terminated";
        this.stopped = undefined;
        // terminated 结束调试会话，但 Adapter 可能仍在等待 disconnect 才会退出。
        void this.close(false).catch((error) => {
          this.failure = error instanceof Error ? error.message : String(error);
        });
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
}
