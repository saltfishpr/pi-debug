import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveVariables } from "./variables.js";

const debugConfigurationSchema = z
  .object({
    name: z.string().min(1, "'name' must be a non-empty string"),
    type: z.string().min(1, "'type' must be a non-empty string"),
    request: z.union([z.literal("launch"), z.literal("attach")]),
  })
  .loose();

/** Named VS Code launch/attach configuration; adapter-specific fields are preserved. */
export type DebugConfiguration = z.infer<typeof debugConfigurationSchema>;

const configurationOverrideSchema = debugConfigurationSchema.partial().required({ name: true });
const launchFileSchema = z.object({ configurations: z.array(configurationOverrideSchema) }).loose();

/** Load and resolve project JSONC configurations; later same-name entries override fields they define. */
export async function loadDebugConfigurations(cwd: string): Promise<DebugConfiguration[]> {
  const paths = [join(cwd, ".vscode", "launch.json"), join(cwd, CONFIG_DIR_NAME, "launch.json")];
  const launchFiles = await Promise.all(paths.map(loadLaunchFile));
  const merged: DebugConfiguration[] = [];
  const indexesByName = new Map<string, number>();

  for (const [fileIndex, configurations] of launchFiles.entries()) {
    for (const [configurationIndex, configuration] of configurations.entries()) {
      const index = indexesByName.get(configuration.name);
      const candidate = index === undefined ? configuration : { ...merged[index], ...configuration };
      const result = debugConfigurationSchema.safeParse(candidate);
      if (!result.success) {
        throw new Error(`Invalid ${paths[fileIndex]}: ${formatIssues(result.error.issues, configurationIndex)}`);
      }

      if (index === undefined) {
        indexesByName.set(configuration.name, merged.length);
        merged.push(result.data);
      } else {
        merged[index] = result.data;
      }
    }
  }

  return resolveVariables(merged, cwd);
}

async function loadLaunchFile(path: string): Promise<z.infer<typeof configurationOverrideSchema>[]> {
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
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid ${path}: ${details}`);
  }
  const names = new Set<string>();
  for (const configuration of result.data.configurations) {
    if (names.has(configuration.name)) throw new Error(`Duplicate configuration '${configuration.name}' in ${path}`);
    names.add(configuration.name);
  }

  return result.data.configurations;
}

function formatIssues(issues: z.core.$ZodIssue[], configurationIndex: number): string {
  return issues
    .map((issue) => `configurations.${configurationIndex}.${issue.path.join(".")}: ${issue.message}`)
    .join(", ");
}
