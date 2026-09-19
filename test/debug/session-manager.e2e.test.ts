import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugSessionManager } from "../../src/debug/session-manager.js";

const hasDelve = spawnSync("dlv", ["version"], { stdio: "ignore" }).status === 0;

// This test crosses the process and socket boundaries and therefore requires Delve on PATH.
describe.skipIf(!hasDelve)("DebugSessionManager e2e", () => {
  let cwd: string;
  let manager: DebugSessionManager;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-debug-e2e-"));
    manager = new DebugSessionManager();

    await mkdir(join(cwd, ".vscode"));
    await writeFile(join(cwd, "go.mod"), "module example.com/pi-debug-e2e\n\ngo 1.22\n");
    await writeFile(
      join(cwd, "main.go"),
      [
        "package main",
        "",
        'import "fmt"',
        "",
        "func add(a, b int) int {",
        "\tresult := a + b",
        "\treturn result",
        "}",
        "",
        "func main() {",
        "\ttotal := add(2, 3)",
        "\tfmt.Println(total)",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, ".vscode", "launch.json"),
      JSON.stringify({
        version: "0.2.0",
        configurations: [
          {
            name: "Launch e2e",
            type: "go",
            request: "launch",
            mode: "debug",
            program: "${workspaceFolder}",
            stopOnEntry: false,
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  it("启动真实 Go 程序并完成断点检查与继续执行", async () => {
    await expect(manager.configurations(cwd)).resolves.toEqual({
      configurations: [{ name: "Launch e2e", type: "go", request: "launch" }],
    });

    const started = await manager.start(
      "Launch e2e",
      { breakpoints: [{ file: "main.go", lines: [6] }], waitMs: 10_000 },
      cwd,
    );
    expect(started).toMatchObject({
      waitOutcome: "stopped",
      stop: { reason: "breakpoint" },
      session: { lifecycle: "active", name: "Launch e2e", type: "go" },
    });

    const session = manager.getSession();
    const stack = await session.stackTrace({ start: 0, count: 1 });
    expect(stack).toMatchObject({
      frames: [{ name: "main.add", line: 6 }],
    });

    const evaluated = await session.evaluate({ frame: 0, expression: "a + b" });
    expect(evaluated).toMatchObject({ result: "5" });

    const resumed = await session.continue({ singleThread: false, waitMs: 10_000 });
    expect(["exited", "terminated", "adapterExit"]).toContain(resumed.waitOutcome);
  }, 30_000);
});
