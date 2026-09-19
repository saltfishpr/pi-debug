import type { DebugAdapterProvider } from "./index.js";

/** Python launch and TCP attach through debugpy. */
export const pythonProvider: DebugAdapterProvider = {
  types: ["debugpy", "python"],
  async resolve(_configuration) {
    throw new Error("Python adapter is not implemented yet.");
  },
};
