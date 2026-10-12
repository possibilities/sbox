export class UsageError extends Error {}

export interface Arguments {
  positionals: string[];
  command: string[];
  flags: Map<string, string[]>;
}

const booleanFlags = new Set([
  "help",
  "version",
  "json",
  "persistent",
  "detached",
  "stdin",
  "sudo",
  "keep",
  "read-only",
  "follow",
  "recursive",
]);
const valueFlags = new Set([
  "config",
  "secrets-file",
  "url",
  "token",
  "host",
  "port",
  "data-dir",
  "hypeman-url",
  "hypeman-token",
  "public-url",
  "preview-host",
  "name",
  "image",
  "runtime",
  "timeout",
  "cpu",
  "memory",
  "disk",
  "ports",
  "env",
  "env-file",
  "tag",
  "mount",
  "network",
  "source",
  "revision",
  "snapshot",
  "cwd",
  "user",
  "harness",
  "mode",
  "prompt",
  "model",
  "limit",
  "cursor",
  "expires",
  "size",
  "path",
  "shell",
  "after",
  "count",
  "signal",
]);
const aliases: Record<string, string> = {
  h: "help",
  v: "version",
  e: "env",
  d: "detached",
  i: "stdin",
  r: "recursive",
  f: "follow",
};

/** Everything after -- belongs to the guest. It is never parsed or evaluated locally. */
export function parseArgs(argv: string[]): Arguments {
  const result: Arguments = { positionals: [], command: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      result.command = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      result.positionals.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const raw = arg.slice(
      arg.startsWith("--") ? 2 : 1,
      equal < 0 ? undefined : equal,
    );
    const name = aliases[raw] ?? raw;
    if (!booleanFlags.has(name) && !valueFlags.has(name))
      throw new UsageError(
        `Unknown option ${arg}. Use -- before guest command arguments.`,
      );
    let value = equal >= 0 ? arg.slice(equal + 1) : undefined;
    if (booleanFlags.has(name)) {
      if (value !== undefined && value !== "true" && value !== "false")
        throw new UsageError(`--${name} expects true or false`);
      value ??= "true";
    } else if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`--${name} requires a value`);
    }
    result.flags.set(name, [...(result.flags.get(name) ?? []), value]);
  }
  return result;
}

export function flag(args: Arguments, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}
export function enabled(args: Arguments, name: string): boolean {
  return flag(args, name) === "true";
}
export function numberFlag(
  args: Arguments,
  name: string,
  fallback?: number,
): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new UsageError(`--${name} must be a nonnegative integer`);
  return value;
}
export function required(
  value: string | undefined,
  description: string,
): string {
  if (!value) throw new UsageError(`Missing ${description}`);
  return value;
}
export function pairs(
  values: string[],
  description: string,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const value of values) {
    const equal = value.indexOf("=");
    if (equal < 1) throw new UsageError(`${description} requires KEY=VALUE`);
    const key = value.slice(0, equal);
    if (description === "--env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new UsageError(`Invalid environment variable name: ${key}`);
    out[key] = value.slice(equal + 1);
  }
  return out;
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: string[] = [];
  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match)
      throw new UsageError(`Invalid env file entry on line ${index + 1}`);
    let value = match[2]!;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      if (value.at(-1) !== quote || value.length < 2)
        throw new UsageError(`Unclosed quote in env file on line ${index + 1}`);
      value = value.slice(1, -1);
      if (quote === '"')
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
    } else value = value.replace(/\s+#.*$/, "").trimEnd();
    values.push(`${match[1]}=${value}`);
  }
  return pairs(values, "--env");
}
