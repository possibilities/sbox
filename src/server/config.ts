import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SboxError } from "../errors.ts";

/** Uses the same credentials as Hypeman's CLI without copying them into guests. */
export async function hypemanConnection(
  options: { baseUrl?: string; apiKey?: string } = {},
): Promise<{ baseUrl: string; apiKey?: string }> {
  let config: { base_url?: unknown; api_key?: unknown } = {};
  if (!options.baseUrl || !options.apiKey) {
    const path = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "hypeman/cli.yaml",
    );
    try {
      const parsed = Bun.YAML.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        config = parsed as typeof config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SboxError(
          "HYPEMAN_CONFIG_ERROR",
          `Cannot read Hypeman CLI configuration at ${path}. Check its YAML syntax and permissions.`,
        );
    }
  }
  return {
    baseUrl:
      options.baseUrl ??
      (typeof config.base_url === "string" ? config.base_url : undefined) ??
      "http://127.0.0.1:4973",
    apiKey:
      options.apiKey ??
      (typeof config.api_key === "string" ? config.api_key : undefined),
  };
}
