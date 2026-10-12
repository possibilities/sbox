import { validatePolicy } from "../network/policy.ts";
import { posix } from "node:path";
import { invariant, SboxError } from "../errors.ts";
import type {
  CreateOptions,
  ExecOptions,
  ListOptions,
  NetworkPolicy,
} from "../types.ts";

export function object(
  value: unknown,
  label = "parameters",
): asserts value is Record<string, unknown> {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_ARGUMENT",
    `${label} must be an object`,
  );
}
export function string(
  value: unknown,
  label: string,
  max = 4096,
): asserts value is string {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !value.includes("\0"),
    "INVALID_ARGUMENT",
    `${label} must be a nonempty string (maximum ${max} characters, no NUL bytes)`,
  );
}
export function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): asserts value is number {
  invariant(
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max,
    "INVALID_ARGUMENT",
    `${label} must be an integer from ${min} to ${max}`,
  );
}
export function env(value: unknown, label = "env"): void {
  if (value === undefined) return;
  object(value, label);
  invariant(
    Object.keys(value).length <= 256,
    "INVALID_ARGUMENT",
    `${label} has too many entries`,
  );
  for (const [key, item] of Object.entries(value)) {
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
      "INVALID_ARGUMENT",
      `Invalid environment variable name: ${key}`,
    );
    invariant(
      typeof item === "string" && !item.includes("\0") && item.length <= 131072,
      "INVALID_ARGUMENT",
      `Invalid value for ${key}`,
    );
  }
}
export function policy(value: unknown): asserts value is NetworkPolicy {
  if (value !== undefined) validatePolicy(value);
}
export function create(value: unknown): asserts value is CreateOptions {
  object(value);
  const allowed = new Set([
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
    "resume",
  ]);
  for (const key of Object.keys(value))
    invariant(
      allowed.has(key),
      "INVALID_ARGUMENT",
      `Unknown sandbox option: ${key}`,
    );
  if (value.name !== undefined) {
    string(value.name, "name", 63);
    invariant(
      /^[a-z0-9][a-z0-9._-]*$/.test(value.name),
      "INVALID_ARGUMENT",
      "name must use lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  if (value.image !== undefined) string(value.image, "image", 1024);
  if (value.runtime !== undefined)
    invariant(
      ["bun", "node22", "node24", "python3.13", "python3.14"].includes(
        String(value.runtime),
      ),
      "INVALID_ARGUMENT",
      "Unknown runtime; use an OCI image containing Bun for a custom runtime",
    );
  if (value.persistent !== undefined)
    invariant(
      typeof value.persistent === "boolean",
      "INVALID_ARGUMENT",
      "persistent must be a boolean",
    );
  if (value.timeout !== undefined)
    integer(value.timeout, "timeout", 1000, 86_400_000);
  if (value.snapshotExpiration !== undefined)
    integer(value.snapshotExpiration, "snapshotExpiration", 0, 31_536_000_000);
  if (
    value.keepLastSnapshots !== undefined &&
    value.keepLastSnapshots !== null
  ) {
    object(value.keepLastSnapshots);
    integer(value.keepLastSnapshots.count, "keepLastSnapshots.count", 1, 1000);
    if (value.keepLastSnapshots.expiration !== undefined)
      integer(
        value.keepLastSnapshots.expiration,
        "keepLastSnapshots.expiration",
        0,
        31_536_000_000,
      );
    if (value.keepLastSnapshots.deleteEvicted !== undefined)
      invariant(
        typeof value.keepLastSnapshots.deleteEvicted === "boolean",
        "INVALID_ARGUMENT",
        "keepLastSnapshots.deleteEvicted must be boolean",
      );
  }
  policy(value.networkPolicy);
  env(value.env);
  env(value.credentialSecrets, "credentialSecrets");
  if (value.credentials !== undefined) {
    object(value.credentials, "credentials");
    invariant(
      Object.keys(value.credentials).length <= 64,
      "INVALID_ARGUMENT",
      "At most 64 brokered credentials are supported",
    );
    for (const [alias, policy] of Object.entries(value.credentials)) {
      env({ [alias]: "placeholder" }, "credential alias");
      object(policy, "credential policy");
      object(policy.source, "credential source");
      string(policy.source.env, "credential source env", 256);
      env({ [policy.source.env]: "placeholder" }, "credential source");
      invariant(
        Array.isArray(policy.inject) &&
          policy.inject.length > 0 &&
          policy.inject.length <= 64,
        "INVALID_ARGUMENT",
        "Credential inject must contain 1 to 64 rules",
      );
      for (const rule of policy.inject) {
        object(rule, "credential rule");
        invariant(
          Array.isArray(rule.hosts) &&
            rule.hosts.length > 0 &&
            rule.hosts.length <= 100,
          "INVALID_ARGUMENT",
          "Credential rules require explicit destination hosts",
        );
        for (const host of rule.hosts)
          invariant(
            typeof host === "string" &&
              /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),
            "INVALID_ARGUMENT",
            "Invalid credential destination host",
          );
        object(rule.as, "credential header template");
        invariant(
          typeof rule.as.header === "string" &&
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rule.as.header),
          "INVALID_ARGUMENT",
          "Invalid credential header name",
        );
        invariant(
          typeof rule.as.format === "string" &&
            rule.as.format.includes("${value}") &&
            !/[\r\n]/.test(rule.as.format),
          "INVALID_ARGUMENT",
          "Credential format must contain ${value} and no newlines",
        );
      }
    }
  }
  if (value.resources !== undefined) {
    object(value.resources);
    for (const key of Object.keys(value.resources))
      invariant(
        ["vcpus", "memoryMb", "diskMb"].includes(key),
        "INVALID_ARGUMENT",
        `Unknown resource: ${key}`,
      );
    if (value.resources.vcpus !== undefined)
      integer(value.resources.vcpus, "vcpus", 1, 256);
    if (value.resources.memoryMb !== undefined)
      integer(value.resources.memoryMb, "memoryMb", 128, 1_048_576);
    if (value.resources.diskMb !== undefined)
      integer(value.resources.diskMb, "diskMb", 128, 16_777_216);
  }
  if (value.ports !== undefined) {
    invariant(
      Array.isArray(value.ports) && value.ports.length <= 15,
      "INVALID_ARGUMENT",
      "ports must be an array of at most 15 ports",
    );
    for (const port of value.ports) integer(port, "port", 1, 65535);
    invariant(
      new Set(value.ports).size === value.ports.length,
      "INVALID_ARGUMENT",
      "ports must be unique",
    );
  }
  if (value.tags !== undefined) {
    object(value.tags);
    invariant(
      Object.keys(value.tags).length <= 32,
      "INVALID_ARGUMENT",
      "At most 32 tags are supported",
    );
    for (const [k, v] of Object.entries(value.tags)) {
      string(k, "tag key", 128);
      invariant(
        typeof v === "string" && v.length <= 1024,
        "INVALID_ARGUMENT",
        "Invalid tag value",
      );
    }
  }
  if (value.source !== undefined) {
    object(value.source);
    invariant(
      ["git", "tarball", "snapshot"].includes(String(value.source.type)),
      "INVALID_ARGUMENT",
      "Invalid source type",
    );
    if (value.source.type === "snapshot")
      string(value.source.snapshotId, "snapshotId");
    else {
      string(value.source.url, "source.url");
      let url: URL;
      try {
        url = new URL(value.source.url);
      } catch {
        throw new SboxError(
          "INVALID_ARGUMENT",
          "source.url must be an HTTP(S) URL",
        );
      }
      invariant(
        ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password,
        "INVALID_ARGUMENT",
        "source.url must be HTTP(S), with credentials passed separately",
      );
      if (value.source.revision !== undefined) {
        string(value.source.revision, "revision", 256);
        invariant(
          !value.source.revision.startsWith("-"),
          "INVALID_ARGUMENT",
          "revision cannot start with a hyphen",
        );
      }
      if (value.source.depth !== undefined)
        integer(value.source.depth, "depth", 1, 1_000_000);
      for (const key of ["username", "password"])
        if (value.source[key] !== undefined)
          string(value.source[key], `source.${key}`, 16384);
    }
  }
  if (value.mounts !== undefined) {
    object(value.mounts);
    invariant(
      Object.keys(value.mounts).length <= 4,
      "INVALID_ARGUMENT",
      "At most four drives can be mounted",
    );
    for (const [path, mount] of Object.entries(value.mounts)) {
      string(path, "mount path");
      invariant(
        path.startsWith("/") &&
          path === posix.normalize(path) &&
          path !== "/" &&
          !/^\/(proc|sys|dev|run|etc|bin|sbin|usr|lib)(\/|$)/.test(path),
        "INVALID_ARGUMENT",
        "Drive mount must be a normalized absolute data directory",
      );
      object(mount);
      string(mount.driveId, "driveId");
      if (mount.readOnly !== undefined)
        invariant(
          typeof mount.readOnly === "boolean",
          "INVALID_ARGUMENT",
          "readOnly must be boolean",
        );
      if (mount.mode !== undefined)
        invariant(
          ["read-write", "snapshot"].includes(String(mount.mode)),
          "INVALID_ARGUMENT",
          "Unknown drive mount mode",
        );
      if (mount.overlay !== undefined)
        invariant(
          typeof mount.overlay === "boolean" &&
            (!mount.overlay || mount.readOnly === true),
          "INVALID_ARGUMENT",
          "Overlay mounts require readOnly:true",
        );
      if (mount.overlaySizeBytes !== undefined)
        integer(
          mount.overlaySizeBytes,
          "overlaySizeBytes",
          1024 ** 3,
          16 * 1024 ** 4,
        );
    }
  }
}
export function command(value: unknown): asserts value is ExecOptions {
  object(value);
  string(value.cmd, "cmd");
  if (value.args !== undefined) {
    invariant(
      Array.isArray(value.args) && value.args.length <= 4096,
      "INVALID_ARGUMENT",
      "args must be an array",
    );
    for (const arg of value.args)
      invariant(
        typeof arg === "string" && !arg.includes("\0") && arg.length <= 131072,
        "INVALID_ARGUMENT",
        "args must contain strings without NUL bytes",
      );
  }
  if (value.cwd !== undefined) {
    string(value.cwd, "cwd");
    invariant(
      value.cwd.startsWith("/"),
      "INVALID_ARGUMENT",
      "cwd must be absolute",
    );
  }
  if (value.user !== undefined) {
    string(value.user, "user", 64);
    invariant(
      /^[a-z_][a-z0-9_-]*[$]?$/.test(value.user),
      "INVALID_ARGUMENT",
      "Invalid user name",
    );
  }
  for (const key of ["sudo", "detached", "stdin"])
    if (value[key] !== undefined)
      invariant(
        typeof value[key] === "boolean",
        "INVALID_ARGUMENT",
        `${key} must be boolean`,
      );
  if (value.timeoutMs !== undefined)
    integer(value.timeoutMs, "timeoutMs", 1, 86_400_000);
  env(value.env);
}
export function list(value: ListOptions): void {
  if (value.limit !== undefined) integer(value.limit, "limit", 1, 1000);
  if (value.cursor !== undefined) string(value.cursor, "cursor", 1024);
  if (value.name !== undefined) string(value.name, "name", 63);
  if (value.namePrefix !== undefined)
    string(value.namePrefix, "namePrefix", 63);
  if (value.sortOrder !== undefined)
    invariant(
      ["asc", "desc"].includes(value.sortOrder),
      "INVALID_ARGUMENT",
      "sortOrder must be asc or desc",
    );
  if (value.sortBy !== undefined)
    invariant(
      ["createdAt", "updatedAt", "statusUpdatedAt", "name"].includes(
        value.sortBy,
      ),
      "INVALID_ARGUMENT",
      "Unknown sortBy field",
    );
}
export function base64(value: unknown): asserts value is string {
  invariant(
    typeof value === "string" &&
      value.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    "INVALID_ARGUMENT",
    "Expected base64 encoded bytes",
  );
}
