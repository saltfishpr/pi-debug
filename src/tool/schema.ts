import { StringEnum, Type } from "@earendil-works/pi-ai";

const sourceBreakpointsSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      description: "Source path for these breakpoints. Relative paths resolve against the project directory.",
    }),
    lines: Type.Array(Type.Integer({ minimum: 1 }), {
      maxItems: 100,
      description:
        "Line numbers in `file`, starting at 1. This list replaces all breakpoints in that file, not just the changed lines; [] clears them.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "One file's complete breakpoint set: pass as `breakpoints` to `set_breakpoints`, or as an entry in `initialBreakpoints` to `start`.",
  },
);

export const parameters = Type.Object(
  {
    action: StringEnum(
      [
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
        "variables",
        "evaluate",
        "output",
      ] as const,
      {
        description:
          "Select an operation: `configurations` finds saved launch settings; `start` creates a session; `status` reports its cached state; `stop` requests cleanup; `set_breakpoints` replaces one file's breakpoints. `continue` resumes, `next` steps over, `step_in` enters, `step_out` returns, and `pause` interrupts. `wait` observes without controlling execution; `threads` refreshes the thread list; `stack_trace` lists frames; `variables` reads a scope or expands a value; `evaluate` runs an expression; `output` reads buffered events.",
      },
    ),
    configuration: Type.Optional(
      Type.Union(
        [
          Type.String({ minLength: 1, description: "For `start`, use an exact name returned by `configurations`." }),
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
      Type.Array(sourceBreakpointsSchema, {
        maxItems: 100,
        description:
          "For `start`, install these breakpoints during session setup, before observing execution. Omit for no initial breakpoints; include each resolved source file at most once.",
      }),
    ),
    breakpoints: Type.Optional(sourceBreakpointsSchema),
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
          "For `stack_trace`, `variables`, or `evaluate`, pass the selected thread's revision from a stop or inspection result to reject stale inspections; required when expanding `variablesReference`. For `wait`, a revision is a baseline: return only for a still-valid stop newer than it (or an exit/closure); omit to accept an existing stop. Revisions and references belong to one session and become stale when the thread resumes.",
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
          "For `variables`, expand one level of a value returned by `variables` or `evaluate`. Use its reference with the same thread's current stop `revision`; after resuming, fetch a new reference. Do not combine with `frameIndex` or `scope`.",
      }),
    ),
    expression: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Required for `evaluate`: a non-empty expression in the target program's language, evaluated in the selected stopped frame. Calls or assignments may mutate the program.",
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
  },
  { additionalProperties: false },
);
