import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rootfsCompanion } from "../src/host/rootfs.ts";
import { startHostServer } from "../src/host/index.ts";

const sourceId = "native-source",
  targetId = "native-target",
  snapshotId = "native-snapshot";
const sourceOwner = `sbx-${"a".repeat(24)}`,
  targetOwner = `snp-${"b".repeat(24)}-capture`;
const image = `docker.io/example/image@sha256:${"c".repeat(64)}`;
const original = Buffer.alloc(8192, 0x41),
  emptyTarget = Buffer.alloc(8192, 0x42);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "sbox-rootfs-test-"));
  const instances: Record<string, { id: string; name: string; state: string }> =
    {
      [sourceId]: { id: sourceId, name: sourceOwner, state: "Stopped" },
      [targetId]: { id: targetId, name: targetOwner, state: "Stopped" },
    };
  const snapshot = {
    id: snapshotId,
    source_instance_id: sourceId,
    source_instance_name: sourceOwner,
    kind: "Stopped",
  };
  const metadata = (id: string, name: string) => ({
    Id: id,
    Name: name,
    Image: "docker.io/example/image:latest",
    ResolvedImage: image,
    Platform: "linux/arm64",
    OverlaySize: original.length,
    StartedAt: "2026-01-01T00:00:00Z",
    // Go serializes an uninitialized volume slice as null for drive-free VMs.
    Volumes: null,
    Env: { PRIVATE_VALUE: "must-never-be-returned" },
  });
  const path = (id: string, file = "overlay.raw") =>
    join(root, "guests", id, file);
  const snapshotPath = (file: string) =>
    join(root, "snapshots", snapshotId, file);
  const patchMetadata = async (id: string, patch: Record<string, unknown>) => {
    const value = JSON.parse(
      await fs.readFile(path(id, "metadata.json"), "utf8"),
    );
    Object.assign(value, patch);
    await fs.writeFile(path(id, "metadata.json"), JSON.stringify(value));
  };
  for (const id of [sourceId, targetId]) {
    await fs.mkdir(join(root, "guests", id, "vol-overlays"), {
      recursive: true,
    });
    await fs.writeFile(path(id), id === sourceId ? original : emptyTarget);
    await fs.writeFile(
      path(id, "metadata.json"),
      JSON.stringify(metadata(id, instances[id]!.name)),
    );
    await fs.writeFile(path(id, "config.ext4"), `config-${id}`);
    await fs.writeFile(path(id, "vol-overlays/drive.raw"), `drive-${id}`);
  }
  await fs.mkdir(snapshotPath("guest"), { recursive: true });
  await fs.writeFile(snapshotPath("guest/overlay.raw"), original);
  await fs.writeFile(
    snapshotPath("snapshot.json"),
    JSON.stringify({
      snapshot,
      stored_metadata: metadata(sourceId, sourceOwner),
    }),
  );
  const requests: string[] = [];
  let beforeRequest: ((path: string) => Promise<void>) | undefined;
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer native-rootfs-token",
      );
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      await beforeRequest?.(pathname);
      if (pathname.startsWith("/instances/")) {
        const value = instances[pathname.slice("/instances/".length)];
        return value
          ? Response.json(value)
          : new Response(null, { status: 404 });
      }
      if (pathname === `/snapshots/${snapshotId}`)
        return Response.json(snapshot);
      return new Response(null, { status: 404 });
    },
  });
  const options = {
    dataDir: root,
    hypemanUrl: native.url.toString(),
    hypemanToken: "native-rootfs-token",
  };
  const companion = await rootfsCompanion(options);
  cleanup.push(async () => {
    await native.stop(true);
    await fs.rm(root, { recursive: true, force: true });
  });
  const journalPath = join(root, ".sbox-storage", "rootfs", `${targetId}.json`);
  return {
    root,
    path,
    snapshotPath,
    instances,
    snapshot,
    patchMetadata,
    requests,
    companion,
    options,
    journalPath,
    before(action: typeof beforeRequest) {
      beforeRequest = action;
    },
  };
}

describe("stopped root filesystem transplant", () => {
  test("native null and empty volume lists permit copies while malformed lists fail closed", async () => {
    const f = await fixture();
    await f.patchMetadata(targetId, { Volumes: [] });
    await f.companion.install({ source: { instanceId: sourceId }, targetId });
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
    await f.patchMetadata(sourceId, { Volumes: { Overlay: false } });
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "INVALID_ROOTFS_METADATA" });
  });

  test("root-only copying refuses per-instance volume overlays without changing source or target", async () => {
    const f = await fixture();
    await f.patchMetadata(sourceId, { Volumes: [{ Overlay: true }] });
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "OVERLAY_TRANSPLANT_UNAVAILABLE" });
    await expect(
      f.companion.install({ source: { instanceId: sourceId }, targetId }),
    ).rejects.toMatchObject({ code: "OVERLAY_TRANSPLANT_UNAVAILABLE" });
    expect(await fs.readFile(f.path(sourceId))).toEqual(original);
    expect(await fs.readFile(f.path(targetId))).toEqual(emptyTarget);
    expect(await Bun.file(f.journalPath).exists()).toBe(false);
  });

  test("info pins the exact image without returning guest environment or host paths", async () => {
    const f = await fixture();
    const expected = {
      resolvedImage: image,
      platform: "linux/arm64",
      sizeBytes: original.length,
    };
    expect(await f.companion.info({ instanceId: sourceId })).toEqual(expected);
    expect(await f.companion.info({ snapshotId })).toEqual(expected);
    const serialized = JSON.stringify(
      await f.companion.info({ instanceId: sourceId }),
    );
    expect(serialized).not.toContain(f.root);
    expect(serialized).not.toContain("must-never-be-returned");
  });

  test("copy changes only the stopped target root overlay and retries never roll it back", async () => {
    const f = await fixture();
    const beforeMetadata = await fs.readFile(f.path(targetId, "metadata.json"));
    const request = { source: { instanceId: sourceId }, targetId };
    expect(await f.companion.install(request)).toEqual({
      id: targetId,
      sizeBytes: original.length,
    });
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
    expect(await fs.readFile(f.path(sourceId))).toEqual(original);
    expect(await fs.readFile(f.path(targetId, "metadata.json"))).toEqual(
      beforeMetadata,
    );
    expect(await fs.readFile(f.path(targetId, "config.ext4"), "utf8")).toBe(
      `config-${targetId}`,
    );
    expect(
      await fs.readFile(f.path(targetId, "vol-overlays/drive.raw"), "utf8"),
    ).toBe(`drive-${targetId}`);
    expect((await fs.stat(f.path(targetId))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.journalPath)).mode & 0o777).toBe(0o600);
    const later = Buffer.alloc(original.length, 0x43);
    await fs.writeFile(f.path(targetId), later);
    f.instances[targetId]!.state = "Running";
    delete f.instances[sourceId];
    const restarted = await rootfsCompanion(f.options);
    expect(await restarted.install(request)).toEqual({
      id: targetId,
      sizeBytes: original.length,
    });
    expect(await fs.readFile(f.path(targetId))).toEqual(later);
    await expect(
      restarted.install({ source: { snapshotId }, targetId }),
    ).rejects.toMatchObject({ code: "ROOTFS_INSTALL_CONFLICT" });
  });

  test("restores an immutable native snapshot after its source instance has been deleted", async () => {
    const f = await fixture();
    delete f.instances[sourceId];
    await fs.rm(join(f.root, "guests", sourceId), { recursive: true });
    await f.companion.install({ source: { snapshotId }, targetId });
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
    await fs.writeFile(f.path(targetId), emptyTarget);
    expect(await fs.readFile(f.snapshotPath("guest/overlay.raw"))).toEqual(
      original,
    );
  });

  test("rejects active, paused, shutdown, unknown and standby states without changing the target", async () => {
    const f = await fixture();
    for (const state of [
      "Running",
      "Paused",
      "Shutdown",
      "Unknown",
      "Standby",
      "Initializing",
    ]) {
      f.instances[sourceId]!.state = state;
      await expect(
        f.companion.install({ source: { instanceId: sourceId }, targetId }),
      ).rejects.toMatchObject({ code: "ROOTFS_INSTANCE_RUNNING" });
      f.instances[sourceId]!.state = "Stopped";
      f.instances[targetId]!.state = state;
      await expect(
        f.companion.install({ source: { instanceId: sourceId }, targetId }),
      ).rejects.toMatchObject({ code: "ROOTFS_INSTANCE_RUNNING" });
      f.instances[targetId]!.state = "Stopped";
    }
    expect(await fs.readFile(f.path(targetId))).toEqual(emptyTarget);
  });

  test("rejects mismatched native ownership, local metadata and snapshot identity", async () => {
    const f = await fixture();
    f.instances[sourceId]!.name = "unmanaged-instance";
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "ROOTFS_OWNERSHIP_MISMATCH" });
    f.instances[sourceId]!.name = sourceOwner;
    await f.patchMetadata(sourceId, { Name: `sbx-${"f".repeat(24)}` });
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "ROOTFS_OWNERSHIP_MISMATCH" });
    f.snapshot.source_instance_name = targetOwner;
    await expect(f.companion.info({ snapshotId })).rejects.toMatchObject({
      code: "ROOTFS_OWNERSHIP_MISMATCH",
    });
    f.snapshot.source_instance_name = sourceOwner;
    f.snapshot.kind = "Standby";
    await expect(f.companion.info({ snapshotId })).rejects.toMatchObject({
      code: "ROOTFS_SNAPSHOT_KIND",
    });
  });

  test("rejects path traversal, ambiguous sources and identical instances before provider access", async () => {
    const f = await fixture();
    for (const request of [
      { source: { instanceId: ".." }, targetId },
      { source: { instanceId: sourceId }, targetId: "../target" },
      { source: { instanceId: sourceId, snapshotId }, targetId },
      { source: { instanceId: sourceId }, targetId: sourceId },
    ])
      await expect(f.companion.install(request)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    expect(f.requests).toEqual([]);
  });

  test("rejects unpinned images, architecture changes, image changes and disk size changes", async () => {
    const f = await fixture();
    const request = { source: { instanceId: sourceId }, targetId };
    await f.patchMetadata(sourceId, { ResolvedImage: undefined });
    await expect(f.companion.install(request)).rejects.toMatchObject({
      code: "ROOTFS_IMAGE_UNPINNED",
    });
    await f.patchMetadata(sourceId, { ResolvedImage: image });
    await f.patchMetadata(targetId, { Platform: "linux/amd64" });
    await expect(f.companion.install(request)).rejects.toMatchObject({
      code: "ROOTFS_IMAGE_MISMATCH",
    });
    await f.patchMetadata(targetId, {
      Platform: "linux/arm64",
      ResolvedImage: image.replace("c".repeat(64), "d".repeat(64)),
    });
    await expect(f.companion.install(request)).rejects.toMatchObject({
      code: "ROOTFS_IMAGE_MISMATCH",
    });
    await f.patchMetadata(targetId, {
      ResolvedImage: image,
      OverlaySize: original.length * 2,
    });
    await fs.truncate(f.path(targetId), original.length * 2);
    await expect(f.companion.install(request)).rejects.toMatchObject({
      code: "ROOTFS_SIZE_MISMATCH",
    });
    expect(
      (await fs.readFile(f.path(targetId))).subarray(0, original.length),
    ).toEqual(emptyTarget);
  });

  test("rejects symlinked directories, overlays and metadata without following them", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.raw");
    await fs.writeFile(outside, original);
    await fs.unlink(f.path(sourceId));
    await fs.symlink(outside, f.path(sourceId));
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "INVALID_ROOTFS_PATH" });
    await fs.unlink(f.path(sourceId));
    await fs.writeFile(f.path(sourceId), original);
    await fs.rename(
      f.path(sourceId, "metadata.json"),
      join(f.root, "outside.json"),
    );
    await fs.symlink(
      join(f.root, "outside.json"),
      f.path(sourceId, "metadata.json"),
    );
    await expect(
      f.companion.info({ instanceId: sourceId }),
    ).rejects.toMatchObject({ code: "INVALID_ROOTFS_PATH" });
    await fs.rename(
      join(f.root, "guests", targetId),
      join(f.root, "moved-target"),
    );
    await fs.symlink(
      join(f.root, "moved-target"),
      join(f.root, "guests", targetId),
    );
    await expect(
      f.companion.install({ source: { snapshotId }, targetId }),
    ).rejects.toMatchObject({ code: "INVALID_ROOTFS_PATH" });
    expect(await fs.readFile(outside)).toEqual(original);
  });

  test("detects a source restart during capture and a target restart before install", async () => {
    const f = await fixture();
    let sourceReads = 0;
    f.before(async (path) => {
      if (path === `/instances/${sourceId}` && ++sourceReads === 2)
        await f.patchMetadata(sourceId, { StartedAt: "2026-02-01T00:00:00Z" });
    });
    await expect(
      f.companion.install({ source: { instanceId: sourceId }, targetId }),
    ).rejects.toMatchObject({ code: "ROOTFS_SOURCE_CHANGED" });
    expect(await fs.readFile(f.path(targetId))).toEqual(emptyTarget);
    await fs.unlink(f.journalPath);
    let targetReads = 0;
    f.before(async (path) => {
      if (path === `/instances/${targetId}` && ++targetReads === 2)
        f.instances[targetId]!.state = "Running";
    });
    await expect(
      f.companion.install({ source: { snapshotId }, targetId }),
    ).rejects.toMatchObject({ code: "ROOTFS_INSTANCE_RUNNING" });
    expect(await fs.readFile(f.path(targetId))).toEqual(emptyTarget);
  });

  test("recovers a rename committed before its completion journal without recopying", async () => {
    const f = await fixture();
    const request = { source: { snapshotId }, targetId };
    await f.companion.install(request);
    const intent = JSON.parse(await fs.readFile(f.journalPath, "utf8"));
    intent.status = "cloned";
    await fs.writeFile(f.journalPath, JSON.stringify(intent));
    await fs.unlink(f.snapshotPath("guest/overlay.raw"));
    const restarted = await rootfsCompanion(f.options);
    await restarted.install(request);
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
    expect(JSON.parse(await fs.readFile(f.journalPath, "utf8")).status).toBe(
      "installed",
    );
  });

  test("missing capture cannot be mistaken for a committed install into a different inode", async () => {
    const f = await fixture();
    const request = { source: { snapshotId }, targetId };
    await f.companion.install(request);
    const intent = JSON.parse(await fs.readFile(f.journalPath, "utf8"));
    intent.status = "cloned";
    await fs.writeFile(f.journalPath, JSON.stringify(intent));
    await fs.rename(f.path(targetId), f.path(targetId, "different.raw"));
    await fs.writeFile(f.path(targetId), emptyTarget);
    await expect(f.companion.install(request)).rejects.toMatchObject({
      code: "ROOTFS_RECOVERY_REQUIRED",
    });
    expect(await fs.readFile(f.path(targetId))).toEqual(emptyTarget);
  });

  test("concurrent independent companion instances serialize a target installation", async () => {
    const f = await fixture();
    const second = await rootfsCompanion(f.options);
    const request = { source: { snapshotId }, targetId };
    const results = await Promise.all([
      f.companion.install(request),
      second.install(request),
    ]);
    expect(results).toEqual([
      { id: targetId, sizeBytes: original.length },
      { id: targetId, sizeBytes: original.length },
    ]);
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
    expect(JSON.parse(await fs.readFile(f.journalPath, "utf8")).status).toBe(
      "installed",
    );
  });

  test("authenticated HTTP routes expose pinned info and install snapshots through the companion", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.root, "volumes"));
    const token = "host-rootfs-route-test-token";
    const host = await startHostServer({
      ...f.options,
      token,
      hostname: "127.0.0.1",
      port: 0,
    });
    cleanup.push(async () => {
      await host.stop(true);
    });
    const url = `${host.url}v1/rootfs/instances/${sourceId}`;
    expect((await fetch(url)).status).toBe(401);
    expect(f.requests).toEqual([]);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const info = await fetch(url, { headers });
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({
      resolvedImage: image,
      platform: "linux/arm64",
      sizeBytes: original.length,
    });
    const result = await fetch(`${host.url}v1/rootfs/install`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: { snapshotId }, targetId }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      id: targetId,
      sizeBytes: original.length,
    });
    expect(await fs.readFile(f.path(targetId))).toEqual(original);
  });
});
