import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const adapterConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
  })
  .loose();

const extensionConfigSchema = z
  .object({
    adapters: z.record(z.string(), adapterConfigSchema).optional(),
  })
  .loose();

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export interface ExtensionConfig {
  adapters: Record<string, AdapterConfig>;
}

/**
 * Load `<cwd>/.pi/debug.json`. Missing file yields an empty config so callers
 * can rely on defaults; parse and schema errors are thrown with the offending
 * path so misconfiguration surfaces at session start.
 */
export async function loadExtensionConfig(cwd: string): Promise<ExtensionConfig> {
  const path = join(cwd, CONFIG_DIR_NAME, "debug.json");

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { adapters: {} };
    throw error;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(", ");
    throw new Error(`Failed to parse ${path}: ${details}`);
  }

  const result = extensionConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid ${path}: ${details}`);
  }

  return { adapters: result.data.adapters ?? {} };
}
