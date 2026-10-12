import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { CreateSandboxParams, UpdateSandboxParams } from "../index.ts";
import { flag, UsageError, type Arguments } from "./args.ts";

const keys = new Set([
  "name",
  "image",
  "runtime",
  "resources",
  "timeout",
  "ports",
  "persistent",
  "networkPolicy",
  "env",
  "credentials",
  "credentialSecrets",
  "tags",
  "source",
  "mounts",
  "snapshotExpiration",
  "keepLastSnapshots",
]);
const createOnly = new Set(["name", "image", "runtime", "source"]);
const maxConfigBytes = 1024 * 1024;
type Options = CreateSandboxParams &
  Pick<UpdateSandboxParams, "currentSnapshotId">;

/** Read only the explicitly named JSON file. Values and paths inside it remain literal. */
export async function readJsonFile(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxConfigBytes)
      throw new UsageError(
        `${label} must be a regular JSON file of at most 1 MiB`,
      );
    const buffer = Buffer.alloc(maxConfigBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxConfigBytes) throw new UsageError(`${label} exceeds 1 MiB`);
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${label} contains invalid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError(`${label} must contain a JSON object`);
  return value as Record<string, unknown>;
}

export async function configuration(
  args: Arguments,
  update = false,
): Promise<Options> {
  for (const name of ["config", "secrets-file"]) {
    if ((args.flags.get(name)?.length ?? 0) > 1)
      throw new UsageError(`Specify --${name} only once`);
  }
  const path = flag(args, "config");
  const value = path ? await readJsonFile(path, "--config") : {};
  for (const key of Object.keys(value)) {
    if (
      (!keys.has(key) && !(update && key === "currentSnapshotId")) ||
      (update && createOnly.has(key))
    )
      throw new UsageError(
        `Unsupported ${update ? "update" : "create"} configuration field: ${key}`,
      );
  }
  // Reject malformed maps before merging explicit flags. Full semantic validation is performed by the control plane.
  for (const key of [
    "resources",
    "env",
    "tags",
    "mounts",
    "credentials",
    "credentialSecrets",
  ]) {
    if (
      value[key] !== undefined &&
      (!value[key] ||
        typeof value[key] !== "object" ||
        Array.isArray(value[key]))
    )
      throw new UsageError(`--config ${key} must be an object`);
  }
  const secretsPath = flag(args, "secrets-file");
  if (secretsPath) {
    const secrets = await readJsonFile(secretsPath, "--secrets-file");
    for (const [name, secret] of Object.entries(secrets)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof secret !== "string" ||
        secret.includes("\0")
      )
        throw new UsageError(
          "--secrets-file must map environment variable names to string values without NUL bytes",
        );
    }
    value.credentialSecrets = {
      ...(value.credentialSecrets as Record<string, string> | undefined),
      ...secrets,
    };
  }
  return value as Options;
}

/** CLI flags override only their own keys; maps merge by entry, arrays and policy replace. */
export function mergeOptions(base: Options, explicit: Options): Options {
  const result: Options = { ...base };
  const maps = new Set(["resources", "env", "tags", "mounts"]);
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue;
    (result as Record<string, unknown>)[key] = maps.has(key)
      ? {
          ...(base[key as keyof Options] as
            | Record<string, unknown>
            | undefined),
          ...(value as Record<string, unknown>),
        }
      : value;
  }
  return result;
}
