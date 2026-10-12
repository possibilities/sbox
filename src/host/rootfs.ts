import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { SboxError, invariant } from "../errors.ts";
import { HypemanClient } from "../hypeman/client.ts";
import { hypemanConnection } from "../server/config.ts";
import { withLeaseGuard } from "../server/leases.ts";
import { atomicClone } from "./atomic-clone.ts";

export type RootfsSource = { instanceId: string } | { snapshotId: string };
export interface RootfsInfo {
  resolvedImage: string;
  platform: string;
  sizeBytes: number;
}
export interface RootfsInstall {
  source: RootfsSource;
  targetId: string;
}
export interface RootfsCompanionOptions {
  dataDir: string;
  hypemanUrl?: string;
  hypemanToken?: string;
}
interface NativeInstance {
  id: string;
  name: string;
  state: string;
}
interface NativeSnapshot {
  id: string;
  kind: string;
  source_instance_id: string;
  source_instance_name: string;
}
interface Metadata {
  Id: string;
  Name: string;
  Image?: string;
  ResolvedImage?: string;
  Platform?: string;
  OverlaySize?: number;
  StartedAt?: string | null;
  Volumes?: Array<{ Overlay?: boolean }> | null;
}
interface Image extends RootfsInfo {
  path: string;
  nativeId: string;
  owner: string;
  incarnation?: string | null;
}
interface InstallIntent {
  version: 1;
  source: RootfsSource;
  targetId: string;
  targetOwner: string;
  image: RootfsInfo;
  status: "pending" | "cloned" | "installed";
  sourceIncarnation?: string | null;
  targetIncarnation?: string | null;
  capturedFileKey?: string;
}

const nativeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(value);
const ownedName = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:sbx-[a-f0-9]{24}|snp-[a-f0-9]{24}-capture)$/.test(value);
const sourceKey = (source: RootfsSource) =>
  "instanceId" in source
    ? `instance:${source.instanceId}`
    : `snapshot:${source.snapshotId}`;
function validateSource(value: unknown): asserts value is RootfsSource {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_ARGUMENT",
    "A root filesystem source is required",
  );
  const keys = Object.keys(value);
  invariant(
    keys.length === 1 &&
      ["instanceId", "snapshotId"].includes(keys[0]!) &&
      nativeId((value as Record<string, unknown>)[keys[0]!]),
    "INVALID_ARGUMENT",
    "Use one exact native instance or snapshot ID",
  );
}

/** Copies stopped root overlays only. Native API ownership remains authoritative. */
export async function rootfsCompanion(options: RootfsCompanionOptions) {
  const root = await realpath(options.dataDir);
  const journal = join(root, ".sbox-storage", "rootfs");
  await mkdir(journal, { recursive: true, mode: 0o700 });
  invariant(
    (await realpath(journal)) === journal,
    "INVALID_ROOTFS_PATH",
    "Root filesystem journal must not be a symlink",
    422,
  );
  await chmod(journal, 0o700);
  const native = new HypemanClient(
    await hypemanConnection({
      baseUrl: options.hypemanUrl,
      apiKey: options.hypemanToken,
    }),
  );

  const safePath = async (...parts: string[]) => {
    const path = join(root, ...parts);
    try {
      invariant(
        (await realpath(path)) === path,
        "INVALID_ROOTFS_PATH",
        "Root filesystem paths must not contain symlinks",
        422,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new SboxError(
          "ROOTFS_NOT_FOUND",
          "Root filesystem data is unavailable",
          404,
        );
      throw error;
    }
    return path;
  };
  const readJson = async <T>(path: string): Promise<T> => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await file.stat();
      invariant(
        details.isFile() && details.size <= 1024 * 1024,
        "INVALID_ROOTFS_METADATA",
        "Root filesystem metadata must be a regular file smaller than 1 MiB",
        422,
      );
      try {
        return JSON.parse(await file.readFile("utf8")) as T;
      } catch {
        throw new SboxError(
          "INVALID_ROOTFS_METADATA",
          "Root filesystem metadata is invalid",
          422,
        );
      }
    } finally {
      await file.close();
    }
  };
  const describe = async (metadata: Metadata, path: string): Promise<Image> => {
    invariant(
      metadata &&
        typeof metadata === "object" &&
        nativeId(metadata.Id) &&
        ownedName(metadata.Name),
      "ROOTFS_OWNERSHIP_MISMATCH",
      "Root filesystem metadata is not Sbox-owned",
      409,
    );
    invariant(
      metadata.Volumes == null || Array.isArray(metadata.Volumes),
      "INVALID_ROOTFS_METADATA",
      "Root filesystem volume metadata is invalid",
      422,
    );
    invariant(
      !metadata.Volumes?.some((volume) => volume?.Overlay === true),
      "OVERLAY_TRANSPLANT_UNAVAILABLE",
      "Root-only copying cannot preserve per-instance drive overlays",
      422,
    );
    const resolvedImage = metadata.ResolvedImage || metadata.Image;
    invariant(
      typeof resolvedImage === "string" &&
        /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(resolvedImage),
      "ROOTFS_IMAGE_UNPINNED",
      "Root filesystem restoration requires a digest-pinned image",
      422,
    );
    invariant(
      typeof metadata.Platform === "string" &&
        /^linux\/(?:amd64|arm64)(?:\/[a-zA-Z0-9_.-]+)?$/.test(
          metadata.Platform,
        ),
      "ROOTFS_PLATFORM_UNKNOWN",
      "Root filesystem platform is unavailable",
      422,
    );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await file.stat();
      invariant(
        details.isFile() &&
          Number.isSafeInteger(details.size) &&
          details.size > 0 &&
          metadata.OverlaySize === details.size,
        "INVALID_ROOTFS_FILE",
        "Root overlay must be a regular file matching its recorded disk size",
        422,
      );
      return {
        path,
        nativeId: metadata.Id,
        owner: metadata.Name,
        incarnation: metadata.StartedAt,
        resolvedImage,
        platform: metadata.Platform,
        sizeBytes: details.size,
      };
    } finally {
      await file.close();
    }
  };
  const inspectInstance = async (
    id: string,
    requireStopped = true,
  ): Promise<Image> => {
    invariant(
      nativeId(id),
      "INVALID_ARGUMENT",
      "An exact native instance ID is required",
    );
    const instance = await native.request<NativeInstance>(
      "GET",
      `/instances/${encodeURIComponent(id)}`,
    );
    invariant(
      instance.id === id && ownedName(instance.name),
      "ROOTFS_OWNERSHIP_MISMATCH",
      "Native instance identity is not Sbox-owned",
      409,
    );
    if (requireStopped)
      invariant(
        instance.state === "Stopped",
        "ROOTFS_INSTANCE_RUNNING",
        "Root filesystem copying requires a stopped instance",
        409,
      );
    const metadata = await readJson<Metadata>(
      await safePath("guests", id, "metadata.json"),
    );
    invariant(
      metadata.Id === id && metadata.Name === instance.name,
      "ROOTFS_OWNERSHIP_MISMATCH",
      "Native instance and root filesystem identities differ",
      409,
    );
    return describe(metadata, await safePath("guests", id, "overlay.raw"));
  };
  const inspect = async (source: RootfsSource): Promise<Image> => {
    validateSource(source);
    if ("instanceId" in source) return inspectInstance(source.instanceId);
    const id = source.snapshotId;
    const snapshot = await native.request<NativeSnapshot>(
      "GET",
      `/snapshots/${encodeURIComponent(id)}`,
    );
    invariant(
      snapshot.id === id &&
        nativeId(snapshot.source_instance_id) &&
        ownedName(snapshot.source_instance_name),
      "ROOTFS_OWNERSHIP_MISMATCH",
      "Native snapshot identity is not Sbox-owned",
      409,
    );
    invariant(
      snapshot.kind === "Stopped",
      "ROOTFS_SNAPSHOT_KIND",
      "Only filesystem snapshots from stopped instances can be installed",
      422,
    );
    const manifest = await readJson<{
      snapshot: NativeSnapshot;
      stored_metadata: Metadata;
    }>(await safePath("snapshots", id, "snapshot.json"));
    invariant(
      manifest.snapshot?.id === id &&
        manifest.snapshot.kind === "Stopped" &&
        manifest.snapshot.source_instance_id === snapshot.source_instance_id &&
        manifest.snapshot.source_instance_name ===
          snapshot.source_instance_name &&
        manifest.stored_metadata?.Id === snapshot.source_instance_id &&
        manifest.stored_metadata.Name === snapshot.source_instance_name,
      "ROOTFS_OWNERSHIP_MISMATCH",
      "Native snapshot and stored root filesystem identities differ",
      409,
    );
    return describe(
      manifest.stored_metadata,
      await safePath("snapshots", id, "guest", "overlay.raw"),
    );
  };
  const publicInfo = (image: RootfsInfo): RootfsInfo => ({
    resolvedImage: image.resolvedImage,
    platform: image.platform,
    sizeBytes: image.sizeBytes,
  });
  const syncDirectory = async (path: string) => {
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const writeIntent = async (path: string, value: InstallIntent) => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(journal);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  const assertCompatible = (source: RootfsInfo, target: RootfsInfo) => {
    invariant(
      source.resolvedImage === target.resolvedImage &&
        source.platform === target.platform,
      "ROOTFS_IMAGE_MISMATCH",
      "Source and target require the same pinned image and platform",
      409,
    );
    invariant(
      source.sizeBytes === target.sizeBytes,
      "ROOTFS_SIZE_MISMATCH",
      "Root filesystem copying requires equal disk sizes; resizing ext4 is not automatic",
      422,
    );
  };

  return {
    async info(source: RootfsSource): Promise<RootfsInfo> {
      return publicInfo(await inspect(source));
    },
    async install(
      request: RootfsInstall,
    ): Promise<{ id: string; sizeBytes: number }> {
      invariant(
        request !== null &&
          typeof request === "object" &&
          !Array.isArray(request),
        "INVALID_ARGUMENT",
        "A root filesystem installation request is required",
      );
      invariant(
        Object.keys(request).every((key) =>
          ["source", "targetId"].includes(key),
        ),
        "INVALID_ARGUMENT",
        "Unknown root filesystem installation option",
      );
      validateSource(request.source);
      invariant(
        nativeId(request.targetId) &&
          (!("instanceId" in request.source) ||
            request.source.instanceId !== request.targetId),
        "INVALID_ARGUMENT",
        "Source and target must be distinct native instances",
      );
      const { source, targetId } = request;
      return withLeaseGuard(journal, targetId, async () => {
        const intentPath = join(journal, `${targetId}.json`);
        let intent: InstallIntent | undefined;
        try {
          intent = await readJson<InstallIntent>(
            await safePath(".sbox-storage", "rootfs", `${targetId}.json`),
          );
        } catch (error) {
          if (
            !(error instanceof SboxError && error.code === "ROOTFS_NOT_FOUND")
          )
            throw error;
        }
        if (intent) {
          invariant(
            intent.version === 1 &&
              intent.targetId === targetId &&
              ["pending", "cloned", "installed"].includes(intent.status) &&
              intent.image &&
              typeof intent.image === "object" &&
              ownedName(intent.targetOwner),
            "INVALID_ROOTFS_JOURNAL",
            "Root filesystem installation journal is invalid",
            409,
          );
          validateSource(intent.source);
          invariant(
            sourceKey(intent.source) === sourceKey(source),
            "ROOTFS_INSTALL_CONFLICT",
            "Target belongs to another root filesystem installation",
            409,
          );
        }
        const target = await inspectInstance(
          targetId,
          intent?.status !== "installed",
        );
        if (intent) {
          invariant(
            intent.targetOwner === target.owner,
            "ROOTFS_OWNERSHIP_MISMATCH",
            "Installation target ownership changed",
            409,
          );
          assertCompatible(intent.image, target);
          if (intent.status === "installed")
            return { id: targetId, sizeBytes: intent.image.sizeBytes };
          invariant(
            intent.targetIncarnation === target.incarnation,
            "ROOTFS_TARGET_CHANGED",
            "Target instance restarted during installation recovery",
            409,
          );
        }
        const temporary = join(dirname(target.path), ".sbox-rootfs.raw");
        const captured = await lstat(temporary).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        invariant(
          !captured || captured.isFile(),
          "INVALID_ROOTFS_FILE",
          "Installation temporary image must be a regular file",
          422,
        );
        if (intent?.status !== "cloned") {
          const origin = await inspect(source);
          assertCompatible(origin, target);
          if (intent)
            invariant(
              intent.sourceIncarnation === origin.incarnation,
              "ROOTFS_SOURCE_CHANGED",
              "Source instance restarted during installation recovery",
              409,
            );
          intent ??= {
            version: 1,
            source,
            targetId,
            targetOwner: target.owner,
            image: publicInfo(origin),
            sourceIncarnation: origin.incarnation,
            targetIncarnation: target.incarnation,
            status: "pending",
          };
          await writeIntent(intentPath, intent);
          // An uncommitted temporary file cannot prove a completed copy. Recreate
          // it from the still-stopped source; only the 'cloned' journal commits it.
          if (captured) await unlink(temporary);
          try {
            atomicClone(origin.path, temporary);
          } catch (error) {
            await unlink(temporary).catch(() => {});
            if (
              !(
                error instanceof SboxError &&
                error.code === "ATOMIC_CLONE_UNAVAILABLE"
              )
            )
              throw error;
            // Unlike live volume captures, both overlays are stopped here, so a
            // regular copy is semantically safe on hosts without reflinks.
            await copyFile(origin.path, temporary, constants.COPYFILE_EXCL);
          }
          await chmod(temporary, 0o600);
          const copied = await open(
            temporary,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const details = await copied.stat({ bigint: true });
            invariant(
              details.size === BigInt(origin.sizeBytes),
              "INVALID_ROOTFS_FILE",
              "Captured overlay has an unexpected size",
              422,
            );
            intent.capturedFileKey = `${details.dev}:${details.ino}`;
            await copied.sync();
          } finally {
            await copied.close();
          }
          if ("instanceId" in source) {
            const checked = await inspectInstance(source.instanceId);
            invariant(
              checked.incarnation === origin.incarnation,
              "ROOTFS_SOURCE_CHANGED",
              "Source restarted during root filesystem copying",
              409,
            );
          }
          await syncDirectory(dirname(temporary));
          intent.status = "cloned";
          await writeIntent(intentPath, intent);
        } else {
          invariant(
            !captured || captured.size === intent.image.sizeBytes,
            "INVALID_ROOTFS_FILE",
            "Journaled overlay has an unexpected size",
            422,
          );
          if (captured) {
            const recorded = await open(
              temporary,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const details = await recorded.stat({ bigint: true });
              invariant(
                intent.capturedFileKey === `${details.dev}:${details.ino}`,
                "ROOTFS_RECOVERY_REQUIRED",
                "Journaled capture identity changed before installation",
                409,
              );
            } finally {
              await recorded.close();
            }
          }
        }
        // Validate again after the copy and before replacing the stopped target.
        const checkedTarget = await inspectInstance(targetId);
        invariant(
          checkedTarget.owner === intent.targetOwner &&
            checkedTarget.incarnation === target.incarnation,
          "ROOTFS_TARGET_CHANGED",
          "Target restarted during root filesystem copying",
          409,
        );
        assertCompatible(intent.image, checkedTarget);
        try {
          await rename(temporary, target.path);
        } catch (error) {
          // The only missing-file case accepted is a crash after atomic rename
          // but before recording its completion. The durable 'cloned' intent is
          // what distinguishes it from an unstarted operation.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          invariant(
            !captured && intent.status === "cloned",
            "INVALID_ROOTFS_FILE",
            "Captured root filesystem disappeared",
            409,
          );
          const installed = await open(
            target.path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const details = await installed.stat({ bigint: true });
            invariant(
              intent.capturedFileKey === `${details.dev}:${details.ino}`,
              "ROOTFS_RECOVERY_REQUIRED",
              "Journaled capture is missing and the target cannot prove a completed installation",
              409,
            );
          } finally {
            await installed.close();
          }
        }
        await syncDirectory(dirname(target.path));
        intent.status = "installed";
        await writeIntent(intentPath, intent);
        return { id: targetId, sizeBytes: intent.image.sizeBytes };
      });
    },
  };
}
