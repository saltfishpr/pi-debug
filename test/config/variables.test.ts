import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVariables } from "../../src/config/variables.js";

afterEach(() => vi.unstubAllEnvs());

describe("resolveVariables", () => {
  it("替换同一字符串中重复及混合使用的变量", () => {
    vi.stubEnv("PI_DEBUG_CONFIG_VALUE", "bin");
    expect(resolveVariables("${workspaceFolder}/${env:PI_DEBUG_CONFIG_VALUE}:${workspaceFolder}", "/project"))
      .toBe("/project/bin:/project");
  });

  it("将未定义或为空的环境变量替换为空字符串", () => {
    vi.stubEnv("PI_DEBUG_CONFIG_MISSING", undefined);
    vi.stubEnv("PI_DEBUG_CONFIG_EMPTY", "");
    expect(resolveVariables("a${env:PI_DEBUG_CONFIG_MISSING}b${env:PI_DEBUG_CONFIG_EMPTY}c", "/project"))
      .toBe("abc");
  });

  it("保留不支持的变量和不完整的占位符", () => {
    const value = "${file}:${workspaceFolder:other}:${command:pick}:${env:NAME";
    expect(resolveVariables(value, "/project")).toBe(value);
  });

  it("按字面值插入替换结果，不展开其中的变量或特殊替换字符", () => {
    vi.stubEnv("PI_DEBUG_CONFIG_VALUE", "${workspaceFolder}/$&/$1");
    expect(resolveVariables("${env:PI_DEBUG_CONFIG_VALUE}", "/project"))
      .toBe("${workspaceFolder}/$&/$1");
    expect(resolveVariables("${workspaceFolder}", "/${env:PI_DEBUG_CONFIG_VALUE}"))
      .toBe("/${env:PI_DEBUG_CONFIG_VALUE}");
  });

  it("递归解析数组和对象中的值，保留键及非字符串值，且不修改输入", () => {
    const input = {
      "${workspaceFolder}": "${workspaceFolder}/main.go",
      nested: [{ args: ["${workspaceFolder}", 42, false, null] }, []],
      empty: {},
    };
    const original = structuredClone(input);
    expect(resolveVariables(input, "/project")).toEqual({
      "${workspaceFolder}": "/project/main.go",
      nested: [{ args: ["/project", 42, false, null] }, []],
      empty: {},
    });
    expect(input).toEqual(original);
  });
});
