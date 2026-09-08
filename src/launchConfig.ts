import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { DebugConfiguration } from "./dap";

const debugConfigurationSchema = z
  .object({
    type: z.string().min(1, "'type' must be a non-empty string"),
    request: z.union([z.literal("launch"), z.literal("attach")]),
    name: z.string().min(1).optional(),
  })
  .loose();

const launchFileSchema = z.object({ configurations: z.array(debugConfigurationSchema) }).loose();

interface DebugConfigurationResolveContext {
  workspaceFolder: string;
  env: NodeJS.ProcessEnv;
}

function resolveDebugConfiguration(configuration: DebugConfiguration, context: DebugConfigurationResolveContext): DebugConfiguration {
  return resolveValue(configuration, context) as DebugConfiguration;
}

function resolveValue(value: unknown, context: DebugConfigurationResolveContext): unknown {
  if (typeof value === "string") return resolveString(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, context)]));
  }
  return value;
}

function resolveString(value: string, context: DebugConfigurationResolveContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (variable, name: string) => {
    if (name === "workspaceFolder") return context.workspaceFolder;
    if (name === "workspaceFolderBasename") return basename(context.workspaceFolder);
    if (name.startsWith("env:")) {
      const envName = name.slice("env:".length);
      const envValue = context.env[envName];
      if (envValue !== undefined) return envValue;
      throw new Error(`Debug configuration variable '${variable}' is not defined`);
    }
    throw new Error(
      `Unsupported debug configuration variable '${variable}'. Supported variables: \${workspaceFolder}, \${workspaceFolderBasename}, \${env:NAME}`,
    );
  });
}

export async function loadDebugConfigurations(cwd: string): Promise<DebugConfiguration[]> {
  const paths = [join(cwd, ".vscode", "launch.json"), join(cwd, ".pi", "launch.json")];
  const configurations = (await Promise.all(paths.map(loadLaunchFile))).flat();
  const merged: DebugConfiguration[] = [];
  const indexesByName = new Map<string, number>();

  for (const configuration of configurations) {
    if (!configuration.name) {
      merged.push(configuration);
      continue;
    }
    const index = indexesByName.get(configuration.name);
    if (index === undefined) {
      indexesByName.set(configuration.name, merged.length);
      merged.push(configuration);
    } else {
      merged[index] = configuration;
    }
  }

  return merged.map((configuration) => resolveDebugConfiguration(configuration, { workspaceFolder: cwd, env: process.env }));
}

async function loadLaunchFile(path: string): Promise<DebugConfiguration[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(", ");
    throw new Error(`Failed to parse ${path}: ${details}`);
  }

  const result = launchFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid ${path}: ${details}`);
  }
  if (result.data.configurations.length === 0) {
    throw new Error(`Invalid ${path}: expected at least one configuration`);
  }

  return result.data.configurations;
}
