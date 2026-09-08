import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CONFIG_FILE_NAME = "debug.json";

const adapterConfigSchema = z
  .object({
    args: z.array(z.string()).optional(),
  })
  .loose();

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

const configSchema = z.object({
  adapters: z.record(z.string().min(1), adapterConfigSchema).default({}),
});

/** Parsed contents of `debug.json`. Callers merge {@link adapters} onto the built-in defaults. */
export type ExtensionConfig = z.infer<typeof configSchema>;

/** Absolute path to the extension config file. */
export function getExtensionConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

/**
 * Load `debug.json` from the agent config directory. Missing file yields an
 * empty config; parse or schema errors surface as thrown errors so the caller
 * can decide how to report them.
 */
export async function loadExtensionConfig(): Promise<ExtensionConfig> {
  const path = getExtensionConfigPath();

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { adapters: {} };
    }
    throw err;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(", ");
    throw new Error(`Failed to parse ${path}: ${details}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid ${path}: ${details}`);
  }
  return result.data;
}
