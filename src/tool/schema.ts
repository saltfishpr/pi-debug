import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

const breakpoint = Type.Object({
  file: Type.String({ minLength: 1, description: "Source file path, absolute or relative to the project directory." }),
  lines: Type.Array(Type.Integer({ minimum: 1 }), {
    maxItems: 100,
    description: "One-based line numbers in file at which execution should break.",
  }),
});

/** Public debugger arguments; action-specific requirements are checked before execution. */
export const debugParameters = Type.Object(
  {
    // 操作选择
    action: StringEnum(
      [
        "configurations",
        "start",
        "stop",
        "status",
        "set_breakpoints",
        "continue",
        "next",
        "step_in",
        "step_out",
        "pause",
        "wait",
        "threads",
        "stack_trace",
        "variables",
        "evaluate",
        "inspect",
      ] as const,
      {
        description:
          "Operation to perform. configurations lists saved configurations; start begins a new session; stop ends it. status reports current session and thread state without blocking; wait blocks until the next stop or exit. set_breakpoints installs breakpoints in a source file. continue, next, step_in, and step_out resume a stopped thread; pause interrupts a running thread. threads and stack_trace enumerate concurrent work and call frames. variables and evaluate read state at a specific frame; inspect returns a combined stack and locals snapshot suitable as a first look after a stop.",
      },
    ),

    // 启动配置
    configuration: Type.Optional(
      Type.Union(
        [
          Type.String({ minLength: 1, description: "Name of a saved configuration returned by the configurations action." }),
          Type.Object(
            {
              name: Type.String({ description: "Display name for this configuration; used only in status output." }),
              type: Type.String({ description: "Debugger type for the target program, matching the type field used in launch.json." }),
              request: StringEnum(["launch", "attach"] as const, {
                description: "launch starts a new program under the debugger; attach connects to an already running one.",
              }),
            },
            {
              additionalProperties: true,
              description:
                "Inline configuration used when no saved configuration exists. Include target-specific fields such as program path, arguments, or a process selector alongside name, type, and request.",
            },
          ),
        ],
        { description: "Required for start. Provide either a saved configuration name or an inline configuration object." },
      ),
    ),
    breakpoints: Type.Optional(
      Type.Array(breakpoint, {
        maxItems: 100,
        description:
          "For start: initial breakpoint set installed before the target program begins executing. Later changes must go through set_breakpoints.",
      }),
    ),

    // 断点配置
    file: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Required for set_breakpoints. Source file path, absolute or relative to the project directory.",
      }),
    ),
    lines: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        maxItems: 100,
        description:
          "Required for set_breakpoints. One-based line numbers, treated as the full breakpoint set for file: entries not present are removed and an empty array clears all breakpoints in that file. To keep an existing breakpoint, include its line here.",
      }),
    ),

    // 执行控制
    singleThread: Type.Optional(
      Type.Boolean({
        description:
          "For continue, next, step_in, and step_out. When true, resume only the selected thread instead of all threads; default false. Requires supportsSingleThreadExecution to be true in status, otherwise the request fails. This flag does not pause threads that are already running.",
      }),
    ),
    threadId: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Target thread from the threads action. For inspection and stepping actions, defaults to the thread from the most recent stopped event, or the only stopped thread when unambiguous; must be supplied when multiple stopped threads are eligible, and the target thread must be stopped. pause targets a thread not currently stopped. For wait, omit to await any stop or termination; supply to await this specific thread stopping or exiting.",
      }),
    ),
    waitMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 30000,
        description:
          "For start, execution control actions, and wait. Maximum time in milliseconds to await a new stop, target thread exit, or program termination; default 1000. On expiry the call returns with the current state and does not interrupt execution, and control actions wait for a new stop rather than an existing stop on another thread. Read waitOutcome in the result to distinguish stop, exit, and timeout.",
      }),
    ),

    // 列表分页
    start: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "For threads and stack_trace. Zero-based offset of the first entry to return; default 0. Pass the nextStart from the previous response to fetch the following page.",
      }),
    ),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "For threads and stack_trace. Maximum entries in the returned page; default 50 for threads and 20 for stack frames. Output size limits may return fewer entries even when more exist; use nextStart to continue.",
      }),
    ),

    // 栈帧与作用域选择
    frame: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 999,
        description:
          "For inspect, variables, and evaluate. Zero-based index into the selected thread's call stack, where 0 is the top (currently executing) frame; default 0.",
      }),
    ),
    scope: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "For inspect and variables. Name of the scope to read at the selected frame, matched case-insensitively against the scopes reported by the debugger; default locals.",
      }),
    ),

    // 变量展开限制
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3,
        description:
          "For inspect and variables. Levels of nested structure to expand; default 2. Use 1 to see only top-level values and raise it to walk into nested fields.",
      }),
    ),
    maxChildren: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description:
          "For inspect and variables. Maximum entries returned per scope or expanded structure; default 50. Overall output size limits may still truncate the response further.",
      }),
    ),

    // 表达式求值
    expression: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Required for evaluate. Expression in the target program's language, evaluated in the selected thread and frame. Runs like real code, so function calls and assignments can mutate program state; prefer read-only expressions unless the side effect is intended.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Arguments accepted by the debug tool. */
export type DebugArguments = Static<typeof debugParameters>;
