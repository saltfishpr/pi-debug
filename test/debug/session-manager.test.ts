import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DebugSessionManager } from "../../src/debug/session-manager.js";
import type { DebugArguments } from "../../src/tool/schema.js";

const fixture = fileURLToPath(new URL("./fixtures/go-session/", import.meta.url));
const source = await readFile(join(fixture, "main.go"), "utf8");

function line(marker: string): number {
  const index = source.split("\n").findIndex((text) => text.includes(`// breakpoint: ${marker}`));
  if (index < 0) throw new Error(`Unknown breakpoint marker: ${marker}`);
  return index + 1;
}

// 真实 Delve 测试不自动跳过：缺少依赖或调试权限必须显式报告，避免误认为集成验证通过。
describe("DebugSessionManager with Go / Delve", { timeout: 60_000 }, () => {
  let cwd: string;
  let manager: DebugSessionManager;

  beforeAll(() => {
    execFileSync("go", ["version"], { timeout: 10_000 });
    execFileSync("dlv", ["version"], { timeout: 10_000 });
  });

  beforeEach(async () => {
    // macOS 的临时目录包含 /var → /private/var 符号链接；Go module 路径需要一致。
    cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-debug-session-")));
    await cp(fixture, cwd, { recursive: true });
    manager = new DebugSessionManager();
  });

  afterEach(async () => {
    try {
      await manager?.close();
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  });

  function execute(args: DebugArguments, signal?: AbortSignal) {
    return manager.execute(args, cwd, signal);
  }

  function start(marker: string, args: string[] = []) {
    const configuration = {
      name: "Go session",
      type: "go",
      request: "launch" as const,
      program: ".",
      stopOnEntry: false,
      args,
    };
    return execute({
      action: "start",
      configuration,
      breakpoints: [{ file: "main.go", lines: [line(marker)] }],
      waitMs: 10_000,
    });
  }

  it("命中初始断点，读取调用栈及不同栈帧的变量，求值后继续至正常退出", async () => {
    expect(await execute({ action: "status" })).toEqual({ state: "idle" });
    expect(await start("calculate")).toMatchObject({
      state: "stopped",
      reason: "breakpoint",
      breakpoints: [{ breakpoints: [{ verified: true, line: line("calculate") }] }],
    });

    expect(await execute({ action: "inspect" })).toMatchObject({
      state: "stopped",
      frames: expect.arrayContaining([
        expect.objectContaining({ frame: 0, name: "main.calculate", line: line("calculate") }),
        expect.objectContaining({ frame: 1, name: "main.main", line: line("call") }),
      ]),
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "base", value: "35" }),
        expect.objectContaining({ name: "bonus", value: "7" }),
      ]),
      truncated: false,
    });
    expect(await execute({ action: "variables", frame: 1 })).toMatchObject({
      frame: 1,
      variables: expect.arrayContaining([expect.objectContaining({ name: "base", value: "35" })]),
    });
    expect(await execute({ action: "evaluate", expression: "base + bonus" })).toMatchObject({ result: "42" });
    // Delve 不一定发送 exited；通过程序输出和 terminated 验证完成运行。
    expect(await execute({ action: "continue", waitMs: 10_000 })).toMatchObject({
      state: "terminated",
      output: expect.stringContaining("result: 42"),
      error: undefined,
    });
    expect(await execute({ action: "stop" })).toMatchObject({ state: "terminated" });
    expect(await execute({ action: "status" })).toEqual({ state: "idle" });
  });

  it("单步进入函数、执行下一行、跳出函数，并替换和清除断点", async () => {
    expect(await start("call")).toMatchObject({ state: "stopped" });
    expect(await execute({ action: "step_in", waitMs: 10_000 })).toMatchObject({ state: "stopped" });
    expect(await execute({ action: "stack_trace" })).toMatchObject({
      frames: expect.arrayContaining([expect.objectContaining({ frame: 0, name: "main.calculate" })]),
    });
    await execute({ action: "set_breakpoints", file: "main.go", lines: [line("calculate")] });
    expect(await execute({ action: "continue", waitMs: 10_000 })).toMatchObject({
      state: "stopped",
      reason: "breakpoint",
    });
    expect(await execute({ action: "next", waitMs: 10_000 })).toMatchObject({ state: "stopped" });
    expect(await execute({ action: "evaluate", expression: "total" })).toMatchObject({ result: "42" });
    expect(await execute({ action: "stack_trace" })).toMatchObject({
      frames: expect.arrayContaining([expect.objectContaining({ frame: 0, line: line("return") })]),
    });
    expect(await execute({ action: "step_out", waitMs: 10_000 })).toMatchObject({ state: "stopped" });
    expect(await execute({ action: "stack_trace" })).toMatchObject({
      frames: expect.arrayContaining([expect.objectContaining({ frame: 0, name: "main.main" })]),
    });
    expect(await execute({ action: "set_breakpoints", file: "main.go", lines: [] })).toMatchObject({ breakpoints: [] });
    expect(await execute({ action: "continue", waitMs: 10_000 })).toMatchObject({
      state: "terminated",
      output: expect.stringContaining("result: 42"),
      error: undefined,
    });
  });

  it("运行期间等待、拒绝读取变量、暂停，并在 stop 后重新启动", async () => {
    await start("output", ["wait"]);
    expect(await execute({ action: "continue", waitMs: 0 })).toMatchObject({ state: "running" });
    expect(await execute({ action: "wait", waitMs: 50 })).toMatchObject({ state: "running" });
    await expect(execute({ action: "variables" })).rejects.toThrow("Session is running");
    await expect(start("call")).rejects.toThrow("A debug session already exists");
    expect(await execute({ action: "pause", waitMs: 10_000 })).toMatchObject({ state: "stopped" });
    await execute({ action: "stop" });
    expect(await execute({ action: "status" })).toEqual({ state: "idle" });
    expect(await start("calculate")).toMatchObject({ state: "stopped", reason: "breakpoint" });
  });

  it("取消等待时关闭活动会话，之后可以重新启动", async () => {
    await start("output", ["wait"]);
    await execute({ action: "continue", waitMs: 0 });
    const controller = new AbortController();
    const waiting = execute({ action: "wait", waitMs: 30_000 }, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error("Cancel integration wait")), 100);
    try {
      await expect(waiting).rejects.toThrow("Cancel integration wait");
    } finally {
      clearTimeout(timer);
    }
    expect(await execute({ action: "status" })).toEqual({ state: "idle" });
    expect(await start("calculate")).toMatchObject({ state: "stopped" });
  });

  it("启动失败后释放会话，close 幂等且拒绝后续调用", async () => {
    const configuration = {
      name: "Missing program",
      type: "go",
      request: "launch" as const,
      program: "./missing.go",
    };
    await expect(execute({ action: "start", configuration })).rejects.toThrow("Failed to launch");
    expect(await execute({ action: "status" })).toEqual({ state: "idle" });
    expect(await start("calculate")).toMatchObject({ state: "stopped" });
    await manager.close();
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(execute({ action: "status" })).rejects.toThrow("Pi session ended");
  });
});
