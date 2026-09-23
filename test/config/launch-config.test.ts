import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDebugConfigurations } from "../../src/config/launch-config.js";

describe("loadDebugConfigurations", () => {
  let cwd: string;
  const launch = { name: "Launch", type: "go", request: "launch", program: "main.go" };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-debug-config-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function writeLaunch(directory: string, content: unknown): Promise<string> {
    const path = join(cwd, directory, "launch.json");
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  }

  it("两个配置文件都不存在时返回空数组", async () => {
    expect(await loadDebugConfigurations(cwd)).toEqual([]);
  });

  it.each([".vscode", CONFIG_DIR_NAME])("仅存在 %s 配置时正常加载", async (directory) => {
    await writeLaunch(directory, { configurations: [launch] });
    expect(await loadDebugConfigurations(cwd)).toEqual([launch]);
  });

  it("支持 JSONC 注释和尾随逗号，保留 adapter 自定义字段", async () => {
    await writeLaunch(
      ".vscode",
      `{
      // Debug configuration
      "version": "0.2.0",
      "configurations": [{
        "name": "Attach", "type": "go", "request": "attach",
        "processId": 123, "stopOnEntry": false,
      }],
    }`,
    );
    expect(await loadDebugConfigurations(cwd)).toEqual([
      { name: "Attach", type: "go", request: "attach", processId: 123, stopOnEntry: false },
    ]);
  });

  it("Pi 同名配置按字段覆盖 VS Code 配置，保留顺序并追加新配置", async () => {
    const second = { ...launch, name: "Second" };
    const override = { name: "Launch", request: "attach", processId: 123 };
    const third = { ...launch, name: "Third" };
    await writeLaunch(".vscode", { configurations: [launch, second] });
    await writeLaunch(CONFIG_DIR_NAME, { configurations: [override, third] });
    expect(await loadDebugConfigurations(cwd)).toEqual([
      { ...launch, request: "attach", processId: 123 },
      second,
      third,
    ]);
  });

  it("返回两个来源中已解析的配置，包括覆盖后的嵌套字段", async () => {
    vi.stubEnv("PI_DEBUG_CONFIG_ARG", "hello");
    await writeLaunch(".vscode", {
      configurations: [launch, { ...launch, name: "Second", program: "${workspaceFolder}/second.go" }],
    });
    await writeLaunch(CONFIG_DIR_NAME, {
      configurations: [
        {
          ...launch,
          program: "${workspaceFolder}/main.go",
          args: ["${env:PI_DEBUG_CONFIG_ARG}"],
          custom: { cwd: "${workspaceFolder}", unknown: "${file}", enabled: true },
        },
      ],
    });
    expect(await loadDebugConfigurations(cwd)).toEqual([
      {
        ...launch,
        program: `${cwd}/main.go`,
        args: ["hello"],
        custom: { cwd, unknown: "${file}", enabled: true },
      },
      { ...launch, name: "Second", program: `${cwd}/second.go` },
    ]);
  });

  it("JSONC 语法错误包含文件路径和解析错误位置", async () => {
    const path = await writeLaunch(".vscode", '{ "configurations": [ }');
    await expect(loadDebugConfigurations(cwd)).rejects.toThrow(`Failed to parse ${path}:`);
    await expect(loadDebugConfigurations(cwd)).rejects.toThrow(/@\d+/);
  });

  it.each([
    ["缺少 configurations", {}, "configurations"],
    ["configurations 不是数组", { configurations: {} }, "configurations"],
    ["name 为空", { configurations: [{ ...launch, name: "" }] }, "configurations.0.name"],
    ["缺少 type", { configurations: [{ name: "Launch", request: "launch" }] }, "configurations.0.type"],
    ["request 无效", { configurations: [{ ...launch, request: "run" }] }, "configurations.0.request"],
  ])("拒绝无效配置：%s", async (_description, content, field) => {
    const path = await writeLaunch(".vscode", content);
    await expect(loadDebugConfigurations(cwd)).rejects.toThrow(`Invalid ${path}: ${field}:`);
  });

  it.each([".vscode", CONFIG_DIR_NAME])("拒绝 %s 文件内部的同名配置", async (directory) => {
    const path = await writeLaunch(directory, { configurations: [launch, { ...launch, program: "other.go" }] });
    await expect(loadDebugConfigurations(cwd)).rejects.toThrow(`Duplicate configuration 'Launch' in ${path}`);
  });

  it("向上传递文件不存在以外的读取错误", async () => {
    await mkdir(join(cwd, ".vscode", "launch.json"), { recursive: true });
    await expect(loadDebugConfigurations(cwd)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
