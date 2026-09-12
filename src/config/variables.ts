/** Resolve supported variables in JSON configuration values without changing object keys. */
export function resolveVariables<T>(value: T, workspaceFolder: string): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([^{}]+)\}/g, (match, variable: string) => {
      if (variable === "workspaceFolder") return workspaceFolder;
      if (variable.startsWith("env:")) return process.env[variable.slice(4)] ?? "";
      return match;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveVariables(item, workspaceFolder)) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveVariables(item, workspaceFolder)]),
    ) as T;
  }

  return value;
}
