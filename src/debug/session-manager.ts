import { getDebugAdapterProvider } from "../adapters/index.js";
import { loadDebugConfigurations } from "../config/launch-config.js";
import { DapClient, RequestTimeoutError } from "../dap/index.js";
import type { DebugArguments } from "../tool/schema.js";
import { DebugSession } from "./session.js";

/** 管理单个活动调试会话，并串行执行工具调用以避免执行状态相互覆盖。 */
export class DebugSessionManager {
  /** 管理器生命周期的取消源，用于在关闭时中止当前及后续操作。 */
  private readonly lifetime = new AbortController();
  /** 当前活动的调试会话；未启动或已终止时为空。 */
  private session: DebugSession | undefined;
  /** 工具调用队列的尾部 Promise，用于保证调试操作按提交顺序执行。 */
  private pending: Promise<unknown> = Promise.resolve();

  /** 将一次工具调用加入串行队列，并统一处理取消、超时与会话失效。 */
  execute(args: DebugArguments, cwd: string, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const result = this.pending.then(async () => {
      combined.throwIfAborted();
      try {
        return await this.dispatch(args, cwd, combined);
      } catch (error) {
        // 已取消或超时的请求可能已经改变被调试进程，关闭会话以免暴露过期的停止状态。
        if (combined.aborted || error instanceof RequestTimeoutError) {
          await this.session?.close();
          this.session = undefined;
        }
        throw error;
      }
    });
    this.pending = result.catch(() => {});
    return result;
  }

  /** 终止管理器生命周期，等待队列清空，并释放当前调试会话。 */
  async close(): Promise<void> {
    this.lifetime.abort(new Error("Pi session ended."));
    await this.pending;
    await this.session?.close();
    this.session = undefined;
  }

  /** 根据 action 校验参数并将调用分派给配置加载器、Adapter Provider 或活动会话。 */
  private async dispatch(args: DebugArguments, cwd: string, signal: AbortSignal): Promise<unknown> {
    switch (args.action) {
      case "configurations":
        return loadDebugConfigurations(cwd);
      case "start":
        return this.start(args, cwd, signal);
      case "stop": {
        await this.session?.close();
        const result = this.session?.snapshot() ?? { state: "terminated" };
        this.session = undefined;
        return result;
      }
      case "status":
        return this.session?.snapshot() ?? { state: "idle" };
      case "set_breakpoints":
        if (!args.file || !args.lines)
          throw new Error("set_breakpoints requires file and lines; [] clears that file's breakpoints.");
        return this.requireSession().setBreakpoints(args.file, args.lines, signal);
      case "continue":
      case "next":
        return this.requireSession().control(args.action, args.singleThread, args.threadId, args.waitMs, signal);
      case "step_in":
        return this.requireSession().control("stepIn", args.singleThread, args.threadId, args.waitMs, signal);
      case "step_out":
        return this.requireSession().control("stepOut", args.singleThread, args.threadId, args.waitMs, signal);
      case "pause":
        return this.requireSession().control("pause", false, args.threadId, args.waitMs, signal);
      case "wait": {
        const session = this.requireSession();
        const result = await session.wait(args.threadId, args.waitMs ?? 1000, signal);
        return { ...session.snapshot(), ...result };
      }
      case "threads":
        return this.requireSession().listThreads(args.start, args.count, signal);
      case "stack_trace":
        return this.requireSession().stackTrace(args.threadId, args.start, args.count, signal);
      case "variables":
        return this.requireSession().variables(
          args.threadId,
          args.frame,
          args.scope,
          args.depth,
          args.maxChildren,
          signal,
        );
      case "evaluate":
        return this.requireSession().evaluate(args.expression, args.threadId, args.frame, signal);
      case "inspect":
        return this.requireSession().inspect(
          args.threadId,
          args.frame,
          args.scope,
          args.depth,
          args.maxChildren,
          signal,
        );
    }
  }

  /** 解析配置并创建会话；启动失败时不保留失效会话。 */
  private async start(args: DebugArguments, cwd: string, signal: AbortSignal): Promise<unknown> {
    if (this.session) throw new Error("A debug session already exists. Stop it before starting another.");
    if (!args.configuration) throw new Error("start requires a configuration name or inline configuration.");

    const selected =
      typeof args.configuration === "string"
        ? (await loadDebugConfigurations(cwd)).find((configuration) => configuration.name === args.configuration)
        : args.configuration;
    if (!selected) throw new Error(`Debug configuration '${args.configuration}' not found.`);

    const provider = getDebugAdapterProvider(selected.type);
    const adapter = await provider.resolve(selected, cwd);
    const session = new DebugSession(cwd, new DapClient(adapter.transport), selected.request, adapter.adapterID);
    this.session = session;
    try {
      return await session.start(adapter.configuration, args.breakpoints, args.waitMs, signal);
    } catch (error) {
      this.session = undefined;
      throw error;
    }
  }

  private requireSession(): DebugSession {
    if (!this.session) throw new Error("No debug session. Use debug start first.");
    return this.session;
  }
}
