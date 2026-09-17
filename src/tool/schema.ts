import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

const breakpoint = Type.Object({
  file: Type.String({ minLength: 1 }),
  lines: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100 }),
});

/** Public debugger arguments; action-specific requirements are checked before execution. */
export const debugParameters = Type.Object(
  {
    // 操作选择
    action: StringEnum([
      "configurations",
      "start",
      "stop",
      "status",
      "wait",
      "set_breakpoints",
      "continue",
      "next",
      "step_in",
      "step_out",
      "pause",
      "stack_trace",
      "variables",
      "evaluate",
      "inspect",
    ] as const),

    // 启动配置
    configuration: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, description: "Configuration name from launch.json." }),
        Type.Object(
          {
            name: Type.String(),
            type: Type.String(),
            request: StringEnum(["launch", "attach"] as const),
          },
          { additionalProperties: true },
        ),
      ]),
    ),
    breakpoints: Type.Optional(Type.Array(breakpoint, { maxItems: 100 })),

    // 断点配置
    file: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100 })),

    // 执行控制
    threadId: Type.Optional(Type.Integer({ minimum: 1 })),
    waitMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 30000,
        description: "Wait for a stop/termination; default 1000 ms. Use wait to poll.",
      }),
    ),

    // 栈帧与作用域选择
    frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "Zero-based stack frame index; default 0." })),
    scope: Type.Optional(Type.String({ minLength: 1, description: "Scope name or locals (default)." })),

    // 变量展开限制
    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    maxChildren: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),

    // 表达式求值
    expression: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Arguments accepted by the debug tool. */
export type DebugArguments = Static<typeof debugParameters>;
