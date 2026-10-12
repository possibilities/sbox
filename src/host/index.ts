import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { SboxError, errorMessage, invariant } from "../errors.ts";
import { HypemanClient } from "../hypeman/client.ts";
import { hypemanConnection } from "../server/config.ts";
import { Locks } from "../server/store.ts";
import { rootfsCompanion } from "./rootfs.ts";
import { atomicClone } from "./atomic-clone.ts";
import { withLeaseGuard } from "../server/leases.ts";

export interface HostServerOptions {
  dataDir: string;
  token: string;
  hypemanUrl?: string;
  hypemanToken?: string;
  hostname?: string;
  port?: number;
  publicUrl?: string;
}
interface Volume {
  id: string;
  name: string;
  size_gb: number;
  attachments?: Array<unknown>;
}
interface Intent {
  sourceId: string;
  targetId: string;
  size: number;
  status: "pending" | "cloned" | "installed";
}
const hash = (text: string) => createHash("sha256").update(text).digest();
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^(?:drv|dgs)-[a-f0-9]{24}$/.test(id);

/** Run beside Hypeman, as the same host user. Only Sbox-owned raw volume files are accepted. */
export async function startHostServer(options: HostServerOptions) {
  invariant(
    typeof options.token === "string" && options.token.length >= 16,
    "AUTH_REQUIRED",
    "The storage companion requires a token of at least 16 characters",
  );
  const dataDir = await realpath(options.dataDir);
  const volumeRoot = await realpath(join(dataDir, "volumes"));
  const journal = join(dataDir, ".sbox-storage");
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await chmod(journal, 0o700);
  const native = new HypemanClient(
    await hypemanConnection({
      baseUrl: options.hypemanUrl,
      apiKey: options.hypemanToken,
    }),
  );
  const locks = new Locks();
  const hostname = options.hostname ?? "127.0.0.1";
  const publicOrigin = options.publicUrl
    ? new URL(options.publicUrl)
    : undefined;
  if (publicOrigin)
    invariant(
      ["http:", "https:"].includes(publicOrigin.protocol) &&
        !publicOrigin.username &&
        !publicOrigin.password &&
        !publicOrigin.search &&
        !publicOrigin.hash &&
        publicOrigin.pathname === "/",
      "INVALID_ARGUMENT",
      "publicUrl must be an HTTP(S) origin without credentials or a path",
    );
  const publicHost = publicOrigin?.hostname;
  const probePath = join(volumeRoot, `.sbox-probe-${crypto.randomUUID()}`);
  let atomicVolumeClone = false;
  try {
    const probe = await open(probePath, "wx", 0o600);
    try {
      await probe.writeFile("sbox-clone-probe");
      await probe.sync();
    } finally {
      await probe.close();
    }
    atomicClone(probePath, `${probePath}.copy`);
    atomicVolumeClone = true;
  } catch {
    /* Report filesystem support, not merely the operating system. */
  } finally {
    await Promise.all([
      unlink(probePath).catch(() => {}),
      unlink(`${probePath}.copy`).catch(() => {}),
    ]);
  }
  let rootfs: ReturnType<typeof rootfsCompanion> | undefined;
  const filesystem = () =>
    (rootfs ??= rootfsCompanion({
      dataDir,
      hypemanUrl: options.hypemanUrl,
      hypemanToken: options.hypemanToken,
    }));
  const writeIntent = async (path: string, intent: Intent) => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(intent));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  const volumePath = async (id: string) => {
    const directory = await realpath(join(volumeRoot, id));
    invariant(
      directory === join(volumeRoot, id),
      "INVALID_VOLUME_FILE",
      "Volume directory must not be a symlink",
      422,
    );
    const raw = join(directory, "data.raw");
    invariant(
      (await realpath(raw)) === raw,
      "INVALID_VOLUME_FILE",
      "Volume image must not be a symlink",
      422,
    );
    return raw;
  };
  return Bun.serve({
    hostname,
    port: options.port ?? 7071,
    maxRequestBodySize: 16384,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        invariant(
          [hostname, "localhost", "127.0.0.1", "[::1]", publicHost].includes(
            url.hostname,
          ),
          "INVALID_HOST",
          "Unrecognized storage companion hostname",
          403,
        );
        invariant(
          !request.headers.get("origin") ||
            request.headers.get("origin") === url.origin,
          "INVALID_ORIGIN",
          "Cross-origin storage requests are not allowed",
          403,
        );
        invariant(
          timingSafeEqual(
            hash(request.headers.get("authorization") ?? ""),
            hash(`Bearer ${options.token}`),
          ),
          "UNAUTHORIZED",
          "A storage companion bearer token is required",
          401,
        );
        if (request.method === "GET" && url.pathname === "/v1/capabilities")
          return Response.json({
            atomicVolumeClone,
            rootfsTransplant: true,
            consistency: "crash-consistent",
            protocol: 1,
          });
        const rootMatch = /^\/v1\/rootfs\/(instances|snapshots)\/([^/]+)$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && rootMatch)
          return Response.json(
            await (
              await filesystem()
            ).info(
              rootMatch[1] === "instances"
                ? { instanceId: rootMatch[2]! }
                : { snapshotId: rootMatch[2]! },
            ),
          );
        if (
          request.method === "POST" &&
          url.pathname === "/v1/rootfs/install"
        ) {
          invariant(
            request.headers.get("content-type")?.split(";")[0] ===
              "application/json",
            "CONTENT_TYPE_REQUIRED",
            "Use application/json",
            415,
          );
          return Response.json(
            await (await filesystem()).install(await request.json()),
          );
        }
        invariant(
          request.method === "POST" && url.pathname === "/v1/volumes/clone",
          "NOT_FOUND",
          "Endpoint not found",
          404,
        );
        invariant(
          request.headers.get("content-type")?.split(";")[0] ===
            "application/json",
          "CONTENT_TYPE_REQUIRED",
          "Use application/json",
          415,
        );
        const body = (await request.json()) as {
          sourceId?: unknown;
          targetId?: unknown;
        };
        invariant(
          body !== null && typeof body === "object" && !Array.isArray(body),
          "INVALID_ARGUMENT",
          "Clone request must be an object",
        );
        invariant(
          validId(body.sourceId) &&
            validId(body.targetId) &&
            body.sourceId !== body.targetId,
          "INVALID_ARGUMENT",
          "Source and destination must be distinct Sbox-managed volume IDs",
        );
        const sourceId = body.sourceId,
          targetId = body.targetId;
        return await locks.run(targetId, () =>
          withLeaseGuard(journal, targetId, async () => {
            const intentPath = join(journal, `${targetId}.json`);
            let intent: Intent | undefined;
            try {
              intent = JSON.parse(await readFile(intentPath, "utf8"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            if (intent) {
              invariant(
                intent.sourceId === sourceId && intent.targetId === targetId,
                "CLONE_CONFLICT",
                "Destination belongs to a different clone operation",
                409,
              );
              invariant(
                ["pending", "cloned", "installed"].includes(intent.status) &&
                  Number.isSafeInteger(intent.size) &&
                  intent.size > 0,
                "INVALID_CLONE_JOURNAL",
                "Clone journal is invalid",
                409,
              );
              if (intent.status === "installed")
                return Response.json({ id: targetId });
            }
            const [source, target] = await Promise.all([
              native.request<Volume>("GET", `/volumes/${sourceId}`),
              native.request<Volume>("GET", `/volumes/${targetId}`),
            ]);
            invariant(
              source.id === sourceId &&
                target.id === targetId &&
                source.name === sourceId &&
                target.name === targetId,
              "VOLUME_OWNERSHIP_MISMATCH",
              "Native volume identity does not match the clone request",
              409,
            );
            invariant(
              !target.attachments?.length,
              "VOLUME_IN_USE",
              "Clone destination is already attached",
              409,
            );
            invariant(
              source.size_gb === target.size_gb,
              "VOLUME_SIZE_MISMATCH",
              "Atomic clones require equal source and destination sizes",
              422,
            );
            const [from, to] = await Promise.all([
              volumePath(sourceId),
              volumePath(targetId),
            ]);
            const [sourceFile, targetFile] = await Promise.all([
              stat(from),
              stat(to),
            ]);
            const size = sourceFile.size;
            invariant(
              sourceFile.isFile() &&
                targetFile.isFile() &&
                size > 0 &&
                targetFile.size === size,
              "INVALID_VOLUME_FILE",
              "Clone images must be regular files of equal nonzero size",
              422,
            );
            intent ??= { sourceId, targetId, size, status: "pending" };
            invariant(
              intent.size === size,
              "VOLUME_SIZE_MISMATCH",
              "Source volume size changed during clone recovery",
              409,
            );
            await writeIntent(intentPath, intent);
            const temporary = join(dirname(to), ".sbox-cloned.raw");
            const captured = await lstat(temporary).catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            invariant(
              !captured ||
                (captured.isFile() &&
                  (intent.status === "pending" || captured.size === size)),
              "INVALID_VOLUME_FILE",
              "Clone temporary image must be a regular file of the recorded size",
              422,
            );
            if (intent.status === "pending") {
              const existing = await lstat(temporary).catch((error) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
              invariant(
                !existing || existing.isFile(),
                "INVALID_VOLUME_FILE",
                "Clone temporary file must be a regular file",
                422,
              );
              if (!existing || existing.size !== size) {
                if (existing) await unlink(temporary);
                try {
                  atomicClone(from, temporary);
                } catch (error) {
                  await unlink(temporary).catch(() => {});
                  throw error;
                }
              }
              await chmod(temporary, 0o600);
              const cloned = await open(temporary, "r");
              try {
                await cloned.sync();
              } finally {
                await cloned.close();
              }
              const parent = await open(dirname(temporary), "r");
              try {
                await parent.sync();
              } finally {
                await parent.close();
              }
              intent.status = "cloned";
              await writeIntent(intentPath, intent);
            }
            // A missing temporary file after a journaled clone means its atomic
            // install completed before the final journal fsync. Never recapture.
            if (
              await stat(temporary).then(
                () => true,
                (error) => {
                  if (error.code === "ENOENT") return false;
                  throw error;
                },
              )
            )
              await rename(temporary, to);
            const directory = await open(dirname(to), "r");
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
            intent.status = "installed";
            await writeIntent(intentPath, intent);
            return Response.json({ id: targetId });
          }),
        );
      } catch (error) {
        const failure =
          error instanceof SboxError
            ? error
            : new SboxError("STORAGE_ERROR", errorMessage(error), 500);
        return Response.json(
          { error: { code: failure.code, message: failure.message } },
          { status: failure.status, headers: { "cache-control": "no-store" } },
        );
      }
    },
  });
}
