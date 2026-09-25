import { StringEnum, Type } from "@earendil-works/pi-ai";

const sourceBreakpointsSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      description: "Source path for these breakpoints. Relative paths resolve against the project directory.",
    }),
    lines: Type.Array(
      Type.Object(
        {
          line: Type.Integer({
            minimum: 1,
            description: "One-based line in the file where this breakpoint is placed.",
          }),
          condition: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Break only when this expression is truthy in the target program's language. Requires adapter support for conditional breakpoints; on unsupported adapters `set_breakpoints` fails.",
            }),
          ),
          hitCondition: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Break based on hit count using adapter syntax such as `>=5` or `%3`. Requires adapter support for hit-count breakpoints; on unsupported adapters `set_breakpoints` fails.",
            }),
          ),
          logMessage: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Emit this message on hit instead of stopping; the adapter interpolates `{expr}` segments. Requires adapter support for log points; on unsupported adapters `set_breakpoints` fails.",
            }),
          ),
        },
        {
          description: "One line's breakpoint with optional condition, hit-count, or log-message behavior.",
        },
      ),
      {
        maxItems: 100,
        description:
          "Breakpoints for `file`. This list replaces all breakpoints in that file, not just the changed ones; [] clears them. Each entry keeps its own `condition`, `hitCondition`, and `logMessage`.",
      },
    ),
  },
  {
    description:
      "One file's complete breakpoint set: pass as `breakpoints` to `set_breakpoints`, or as an entry in `initialBreakpoints.source` to `start`.",
  },
);

const functionBreakpointSpecSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description: "Function name to break on. Matching is adapter-defined and may accept mangled or qualified names.",
    }),
    condition: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Break only when this expression is truthy in the target program's language. Requires adapter support for conditional breakpoints; on unsupported adapters `set_function_breakpoints` fails.",
      }),
    ),
    hitCondition: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Break based on hit count using adapter syntax such as `>=5` or `%3`. Requires adapter support for hit-count breakpoints; on unsupported adapters `set_function_breakpoints` fails.",
      }),
    ),
  },
  {
    description: "One function-name breakpoint with optional condition or hit-count behavior.",
  },
);

export const parameters = Type.Object({
  action: StringEnum([
    "list_configurations",
    "list_sessions",
    "start",
    "status",
    "close_session",
    "set_breakpoints",
    "set_function_breakpoints",
    "list_breakpoints",
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
    "output",
  ] as const),
  sessionId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Required for every session-specific action except `start`; use the ID returned by `start` or `list_sessions`. Thread IDs, revisions, frame selections, and variable references are valid only within this session.",
    }),
  ),
  configuration: Type.Optional(
    Type.Union(
      [
        Type.String({ minLength: 1, description: "For `start`, use an exact name returned by `list_configurations`." }),
        Type.Object(
          {
            name: Type.String({
              minLength: 1,
              description: "For an inline `start` configuration, choose a name shown by `status`.",
            }),
            type: Type.String({
              minLength: 1,
              description: "For an inline `start` configuration, use the debugger type required by the target.",
            }),
            request: StringEnum(["launch", "attach"] as const, {
              description:
                "For inline `start`: `launch` starts a program under the debugger; `attach` connects to one already running.",
            }),
          },
          {
            additionalProperties: true,
            description:
              "For `start`, supply `name`, `type`, `request`, and any target-specific launch or attach fields (for example, `program`, `args`, or a process selector).",
          },
        ),
      ],
      {
        description:
          "Required for `start`: select a saved configuration by name or provide an inline configuration. Other actions do not use it.",
      },
    ),
  ),
  initialBreakpoints: Type.Optional(
    Type.Object(
      {
        source: Type.Optional(
          Type.Array(sourceBreakpointsSchema, {
            maxItems: 100,
            description:
              "Per-file source breakpoints to install during startup; include each resolved source path at most once. Omit or use [] to install no source breakpoints.",
          }),
        ),
        function: Type.Optional(
          Type.Array(functionBreakpointSpecSchema, {
            maxItems: 100,
            description:
              "Function-name breakpoints to install during startup; the list is global. Requires adapter capability `supportsFunctionBreakpoints`; omit if the adapter does not support it.",
          }),
        ),
      },
      {
        description:
          "For `start`, install these breakpoints during session setup, before observing execution. Omit both fields (or the whole object) for no initial breakpoints.",
      },
    ),
  ),
  breakpoints: Type.Optional(sourceBreakpointsSchema),
  functionBreakpoints: Type.Optional(
    Type.Array(functionBreakpointSpecSchema, {
      maxItems: 100,
      description:
        "For `set_function_breakpoints`, replace the entire function-breakpoint list; [] clears them. Requires adapter capability `supportsFunctionBreakpoints`; check `status` first.",
    }),
  ),
  threadId: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "For execution and inspection, use a thread ID from `threads` or a stop result. `continue`, stepping, `stack_trace`, `variables`, and `evaluate` require a stopped thread: omission selects the last-stopped thread if still stopped, otherwise the sole stopped thread. `pause` requires a running or unknown-state thread; omit its ID only if exactly one qualifies. For `wait`, omit to observe any stop or session closure, or specify an ID to observe that thread's stop or exit (or closure).",
    }),
  ),
  revision: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "For `stack_trace`, `variables`, or `evaluate`, pass the selected thread's revision from the same session's stop or inspection result to reject stale inspections; required when expanding `variablesReference`. For `wait`, a revision is a baseline: return only for a still-valid stop newer than it (or an exit/closure); omit to accept an existing stop. Revisions and references belong to the selected `sessionId` and become stale when the thread resumes.",
    }),
  ),
  singleThread: Type.Optional(
    Type.Boolean({
      description:
        "For `continue` or stepping, set true to request that only the selected thread resume; requires single-thread execution support in `status`. Omit or set false for normal execution. This does not pause threads already running; do not pass to `pause`.",
    }),
  ),
  waitMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 30000,
      description:
        "For `start`, `continue`, stepping, `pause`, or `wait`, observe for up to this many milliseconds after setup or a control request completes (default 1000). 0 checks without waiting. This is not a whole-call deadline: requests can take longer, and an observation timeout neither cancels execution nor stops the program.",
    }),
  ),
  frameIndex: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 999,
      description:
        "For `evaluate` or scope-based `variables`, use the zero-based `frameIndex` returned by `stack_trace`; omit for the top frame (index 0). Do not combine with `variablesReference`.",
    }),
  ),
  scope: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "For scope-based `variables`, name the scope in the selected frame (case-insensitive; default `locals`). If no scope or multiple scopes match, the error lists available names. Do not combine with `variablesReference`.",
    }),
  ),
  variablesReference: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "For `variables`, expand one level of a value returned by `variables` or `evaluate`. Use its reference with the same `sessionId`, thread, and current stop `revision`; after resuming, fetch a new reference. Do not combine with `frameIndex` or `scope`.",
    }),
  ),
  expressions: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 20,
      description:
        "Required for `evaluate`: one or more non-empty expressions in the target program's language, evaluated in order in the selected stopped frame. Each expression is a separate adapter request; calls or assignments may mutate the program, and an earlier expression's side effects are observed by later expressions in the same batch.",
    }),
  ),
  start: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "For `threads`, `stack_trace`, `variables`, or `output`, skip this many entries from the selected list (zero-based; default 0). Use `nextStart` with the same selection for the next page. For `output`, filtering happens first; new or evicted events may shift later pages.",
    }),
  ),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        "For `threads`, `stack_trace`, `variables`, or `output`, cap the number of entries in a page. Default: 20 for `stack_trace`, 50 for the others.",
    }),
  ),
  category: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "For `output`, filter buffered events by exact category, such as `stdout`, `stderr`, or `console`. Omit to include every category.",
    }),
  ),
});
