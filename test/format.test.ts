import { describe, expect, it } from "vitest";
import { SessionState } from "../src/dap";
import {
  formatAddBreakpoints,
  formatEvaluate,
  formatListBreakpoints,
  formatListSessions,
  formatOutput,
  formatStatus,
  formatThreads,
  formatVariables,
} from "../src/format";
import type { SessionSnapshot } from "../src/session";

const snapshot: SessionSnapshot = {
  id: "sess-123",
  state: SessionState.Stopped,
  configuration: { name: "Debug app", type: "node", request: "launch" },
  stop: { threadId: 7, focusedFrameId: 42 },
  threads: { stopped: 1, total: 3, observedAt: 10_000 },
};

describe("format", () => {
  it("formats session status as ordered YAML fields using supplied time", () => {
    expect(formatStatus(snapshot, 22_999)).toBe(
      [
        "state: stopped",
        "threads:",
        "  stopped: 1",
        "  total: 3",
        '  observed: "12s ago"',
        "sessionId: sess-123",
        "threadId: 7",
        "frameId: 42",
        "configuration:",
        '  name: "Debug app"',
        "  type: node",
        "  request: launch",
      ].join("\n"),
    );
  });

  it("keeps list_sessions scoped to session evidence", () => {
    expect(formatListSessions("sess-123", [snapshot])).toBe(
      ["sessions:", '  - { sessionId: sess-123, state: stopped, active: true, name: "Debug app" }'].join("\n"),
    );
  });

  it("uses quoted strings and block mappings for multiline variables", () => {
    expect(
      formatVariables("sess-123", 12, [
        { name: "query", value: "SELECT *\nFROM users", type: "string", variablesReference: 0 },
        { name: "count", value: "3", type: "number", variablesReference: 7 },
      ]),
    ).toBe(
      [
        "variables:",
        '  - name: "query"',
        "    value: |-",
        "      SELECT *",
        "      FROM users",
        '    type: "string"',
        '  - { name: "count", value: "3", type: "number", variablesReference: 7 }',
        "sessionId: sess-123",
        "variablesReference: 12",
      ].join("\n"),
    );
  });

  it("preserves output order, joins only adjacent categories, and retains trailing LF", () => {
    expect(
      formatOutput(
        "sess-123",
        [
          { category: "stdout", output: "hello", timestamp: 0 },
          { category: "stdout", output: " world\n", timestamp: 1 },
          { category: "stderr", output: "warn", timestamp: 2 },
          { category: "stdout", output: "again", timestamp: 3 },
        ],
        true,
      ),
    ).toBe(
      [
        "output:",
        '  - category: "stdout"',
        "    text: |",
        "      hello world",
        '  - { category: "stderr", text: "warn" }',
        '  - { category: "stdout", text: "again" }',
        "sessionId: sess-123",
        "buffer: cleared",
      ].join("\n"),
    );
  });

  it("emits actionable thread pagination only when it can advance", () => {
    expect(formatThreads("sess-123", [{ id: 7, name: "Main", stopped: true }], 2, 5, 1)).toBe(
      [
        "threads:",
        '  - { threadId: 7, stopped: true, name: "Main" }',
        "page: { start: 2, returned: 1, total: 5 }",
        "sessionId: sess-123",
        "more: { action: threads, sessionId: sess-123, start: 3, levels: 1 }",
      ].join("\n"),
    );
  });

  it("reports current source breakpoint state with verification", () => {
    expect(
      formatAddBreakpoints("sess-123", "/app/main.ts", [
        { line: 42, actualLine: 44, verified: true, id: 17, condition: "count > 3" },
        { line: 80, verified: false, message: "No executable code" },
      ]),
    ).toBe(
      [
        "outcome: updated",
        "verification: { verified: 1, unverified: 1 }",
        'source: "/app/main.ts"',
        "breakpoints:",
        '  - { line: 42, actualLine: 44, verified: true, breakpointId: 17, condition: "count > 3" }',
        '  - { line: 80, verified: false, message: "No executable code" }',
        "sessionId: sess-123",
      ].join("\n"),
    );
  });

  it("does not claim unrequested function breakpoints exist", () => {
    expect(formatListBreakpoints("sess-123", {}, undefined, { includeFunctions: false, source: "/app/main.ts" })).toBe(
      ["sources: []", "includeFunctions: false", 'filterSource: "/app/main.ts"', "sessionId: sess-123"].join("\n"),
    );
  });

  it("keeps evaluation results as strings and escapes terminal controls", () => {
    expect(formatEvaluate("sess-123", "value", undefined, { result: "\u001b[31m3", type: "number", variablesReference: 0 })).toBe(
      ['result: "\\u001b[31m3"', 'type: "number"', 'expression: "value"', "sessionId: sess-123"].join("\n"),
    );
  });
});
