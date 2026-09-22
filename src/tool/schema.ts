import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

const DEBUG_ACTIONS = [
  "configurations",
  "start",
  "status",
  "stop",
  "set_breakpoints",
  "continue",
  "next",
  "step_in",
  "step_out",
  "pause",
  "wait",
  "threads",
  "stack_trace",
  "inspect",
  "variables",
  "evaluate",
  "output",
] as const;

const breakpointSchema = Type.Object({
  file: Type.String({ minLength: 1, description: "Source file path, absolute or relative to the project directory." }),
  lines: Type.Array(Type.Integer({ minimum: 1 }), {
    maxItems: 100,
    description: "One-based breakpoint line numbers in `file`.",
  }),
});

const configurationSchema = Type.Union(
  [
    Type.String({ minLength: 1, description: "Saved configuration name returned by `configurations`." }),
    Type.Object(
      {
        name: Type.String({ description: "Name identifying this configuration in `status` output." }),
        type: Type.String({
          description: "Debugger type for the target program, as used in the `type` field of launch.json.",
        }),
        request: StringEnum(["launch", "attach"] as const, {
          description: "`launch` starts a new program under the debugger; `attach` connects to an existing program.",
        }),
      },
      {
        additionalProperties: true,
        description:
          "Inline alternative to a saved configuration. Include target-specific launch.json fields, such as `program`, `args`, or a process selector, alongside `name`, `type`, and `request`.",
      },
    ),
  ],
  { description: "Required for `start`: a saved configuration name or an inline launch/attach configuration." },
);

/** Public debugger arguments; action-specific requirements are checked before execution. */
export const debugParameters = Type.Object(
  {
    // 操作选择
    action: StringEnum(DEBUG_ACTIONS, {
      description:
        "Choose an operation: `configurations` lists saved configurations; `start` opens a session; `stop` closes it; `status` reports current state; `wait` awaits a new stop, thread exit, or completed session closure. `set_breakpoints` replaces a file's breakpoints. `continue` resumes execution; `next` steps over; `step_in` steps into; `step_out` steps out; `pause` interrupts execution. `threads` lists threads; `stack_trace` lists frames; `variables` reads a scope or variable container; `evaluate` evaluates an expression in a frame; `output` reads buffered program output. `inspect` returns a bounded overview of the stack, selected frame, scopes, variables, and available source context.",
    }),

    // 启动配置
    configuration: Type.Optional(configurationSchema),
    breakpoints: Type.Optional(
      Type.Array(breakpointSchema, {
        maxItems: 100,
        description:
          "For `start`: source breakpoints installed during session setup; defaults to none. Use `set_breakpoints` for later changes. Attaching does not undo execution that occurred before setup.",
      }),
    ),

    // 断点配置
    file: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Required for `set_breakpoints`: source file path, absolute or relative to the project directory.",
      }),
    ),
    lines: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        maxItems: 100,
        description:
          "Required for `set_breakpoints`: one-based line numbers replacing all breakpoints in `file`, not appending to them. Include existing lines you want to keep; an empty array clears the file's breakpoints.",
      }),
    ),

    // 执行控制
    singleThread: Type.Optional(
      Type.Boolean({
        description:
          "For `continue`, `next`, `step_in`, and `step_out`: request resuming only the selected thread; defaults to false. Requires `capabilities.supportsSingleThreadExecutionRequests` in `status` to be true. Does not pause other running threads.",
      }),
    ),
    threadId: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Thread from `threads` or a stop result. For inspection, `continue`, and stepping: omit to select the most recently stopped thread if still stopped, otherwise the only stopped thread; required if neither rule resolves the choice. For `pause`: omit only when exactly one thread can be paused. For `wait`: omit to await any new stop or session closure; supply to await this thread's new stop or exit, or session closure.",
      }),
    ),
    waitMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 30000,
        description:
          "For `start`, `continue`, stepping, `pause`, and `wait`: event-wait budget in milliseconds; defaults to 1000. Zero checks for a new event or closed state without waiting. Not a deadline for the entire tool call: setup, requests, and result inspection may take additional time. Execution-control actions wait for the selected thread's new stop or exit, or completed session closure, not an existing stop on another thread.",
      }),
    ),

    // 输出筛选
    category: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "For `output`: filter buffered events by category, such as `stdout`, `stderr`, `console`, `important`, or `telemetry`. Omit to include all categories.",
      }),
    ),

    // 列表分页
    start: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "For `threads`, `output`, `stack_trace`, and `variables`: zero-based offset in the selected list or container; defaults to 0. For `output`, applied after category filtering. Use the previous result's `nextStart` to fetch the next page with the same selection.",
      }),
    ),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "For `threads`, `output`, `stack_trace`, and `variables`: maximum entries per page. Defaults to 20 for `stack_trace`, 50 for the others. Does not change the fixed limits of `inspect`.",
      }),
    ),

    // 栈帧与作用域选择
    variablesReference: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "For `variables`: use a `variablesReference` from `variables` or `inspect` to read that container's direct children instead of selecting a scope. Use a reference from the selected thread's current stop; do not reuse it after execution resumes or changes. Cannot be combined with `frame` or `scope`.",
      }),
    ),
    frame: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 999,
        description:
          "For `inspect`, `evaluate`, and scope-based `variables`: zero-based position in the selected thread's stack, not a frame identifier. Defaults to 0 (the top frame). For `variables`, cannot be combined with `variablesReference`.",
      }),
    ),
    scope: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "For `inspect` and scope-based `variables`: scope name at the selected frame, matched case-insensitively; available names are returned by `inspect`. Defaults to `locals` for `variables`. When omitted for `inspect`, prefers a locals scope, then a non-expensive scope, then the first available scope. For `variables`, cannot be combined with `variablesReference`.",
      }),
    ),

    // 表达式求值
    expression: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Required for `evaluate`: expression in the target program's language, evaluated in the selected thread and frame.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Arguments accepted by the debug tool. */
export type DebugArguments = Static<typeof debugParameters>;
