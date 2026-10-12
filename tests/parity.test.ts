import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Sandbox, Snapshot, Drive } from "../src/index.ts";
import { startServer, Store } from "../src/server/index.ts";
import { TestBackend } from "./test-backend.ts";
import type { Backend } from "../src/backend.ts";
import type { SnapshotRecord } from "../src/types.ts";

let backend: TestBackend,
  store: Store,
  server: Awaited<ReturnType<typeof startServer>>,
  baseUrl: string;
const token = "sdk-parity-test-token-32-characters";
beforeEach(async () => {
  backend = await new TestBackend().initialize();
  store = new Store(":memory:");
  server = await startServer({
    backend,
    store,
    hostname: "127.0.0.1",
    port: 0,
    token,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server.stop(true);
  store.close();
  await backend.dispose();
});
const connection = () => ({ baseUrl, token });

describe("SDK parity through the HTTP service", () => {
  test("the built-in Bun runtime works without an explicit image and survives snapshots", async () => {
    const sandbox = await Sandbox.create({ ...connection(), runtime: "bun" });
    expect(sandbox.runtime).toBe("bun");
    expect(
      backend.instances.get(sandbox.toJSON().instanceId!)!.options.image,
    ).toBe("oven/bun:1-debian");
    const snapshot = await sandbox.snapshot();
    const fork = await Sandbox.create({
      ...connection(),
      source: { type: "snapshot", snapshotId: snapshot.snapshotId },
    });
    expect(fork.runtime).toBe("bun");
  });

  test("per-instance drive overlays retain their native VM across stop and reject root-only snapshotting", async () => {
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const drive = await Drive.getOrCreate({
      ...connection(),
      name: "overlay-base",
    });
    const sandbox = await Sandbox.create({
      ...connection(),
      mounts: {
        "/mnt/overlay": {
          driveId: drive.driveId,
          readOnly: true,
          overlay: true,
        },
      },
    });
    const instanceId = sandbox.toJSON().instanceId!;
    await sandbox.writeFiles([
      { path: "preserved", content: "same native filesystem" },
    ]);
    await expect(sandbox.snapshot()).rejects.toMatchObject({
      code: "OVERLAY_TRANSPLANT_UNAVAILABLE",
    });
    expect(backend.instances.get(instanceId)!.state).toBe("Running");
    await sandbox.stop();
    expect(sandbox.toJSON().instanceId).toBe(instanceId);
    expect(sandbox.toJSON().snapshotPending).toBe(false);
    expect(store.all("snapshot")).toHaveLength(0);
    await expect(
      sandbox.update({ resources: { vcpus: 4 } }),
    ).rejects.toMatchObject({ code: "OVERLAY_TRANSPLANT_UNAVAILABLE" });
    await sandbox.resume();
    expect(sandbox.toJSON().instanceId).toBe(instanceId);
    expect(
      (await sandbox.readFileToBuffer({ path: "preserved" }))?.toString(),
    ).toBe("same native filesystem");
    expect(backend.deleteCalls).toBe(0);
  });

  test("binary uploads and streamed reads exceed the former JSON/base64 size ceiling", async () => {
    const sandbox = await Sandbox.create(connection());
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const path = "nested/20 MiB & newline\n'file.bin";
    await sandbox.writeFiles([{ path, content: bytes, mode: 0o640 }]);
    const stream = await sandbox.readFile({ path });
    expect(stream).not.toBeNull();
    let offset = 0;
    for await (const chunk of stream!) {
      const data = Buffer.from(chunk);
      expect(data).toEqual(bytes.subarray(offset, offset + data.length));
      offset += data.length;
    }
    expect(offset).toBe(bytes.length);
    expect((await sandbox.fs.stat(path)).mode & 0o777).toBe(0o640);
    expect(await sandbox.fs.readFile(path)).toEqual(bytes);
    expect(await sandbox.readFile({ path: "missing" })).toBeNull();
  });

  test("static fork produces an independent filesystem without leaking sourceSandbox options", async () => {
    const original = await Sandbox.create({
      ...connection(),
      name: "original",
    });
    await original.writeFiles([{ path: "state", content: "before" }]);
    const fork = await Sandbox.fork({
      ...connection(),
      sourceSandbox: original.name,
      name: "fork",
    });
    expect((await fork.readFileToBuffer({ path: "state" }))?.toString()).toBe(
      "before",
    );
    await fork.writeFiles([{ path: "state", content: "after" }]);
    expect(
      (await original.readFileToBuffer({ path: "state" }))?.toString(),
    ).toBe("before");
    expect(fork.name).toBe("fork");
  });

  test("historical session methods cannot mutate or open a terminal in a resumed session", async () => {
    const sandbox = await Sandbox.create(connection());
    const old = sandbox.currentSession();
    await old.stop();
    expect(old.status).toBe("stopped");
    await sandbox.resume();
    expect(sandbox.currentSession().sessionId).not.toBe(old.sessionId);
    const before = sandbox.toJSON();
    for (const operation of [
      () => old.stop(),
      () => old.update({ networkPolicy: "allow-all" }),
      () => old.extendTimeout(1000),
      () => old.snapshot(),
      () => old.openInteractive(),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: "SESSION_ENDED",
      });
    await sandbox.refresh();
    expect(sandbox.status).toBe("running");
    expect(sandbox.sessionId).toBe(before.sessionId);
    expect(sandbox.toJSON().deadline).toBe(before.deadline);
    expect((await sandbox.runCommand("true")).exitCode).toBe(0);
  });

  test("current session timeout, snapshot and terminal operations retain session metadata", async () => {
    const sandbox = await Sandbox.create(connection());
    const session = sandbox.currentSession();
    const previousTimeout = session.timeout;
    await session.extendTimeout(2500);
    expect(session.timeout).toBe(previousTimeout + 2500);
    await session.update({ networkPolicy: "allow-all" });
    expect((await session.openInteractive()).url).toContain("/v1/terminals/");
    const snapshot = await session.snapshot({ expiration: 0 });
    expect(snapshot.sourceSessionId).toBe(session.sessionId);
    expect(snapshot.status).toBe("created");
    expect(snapshot.expiresAt).toBeUndefined();
    expect(session.status).toBe("stopped");
  });

  test("port and timeout updates change active behavior without starting another session", async () => {
    const sandbox = await Sandbox.create({
      ...connection(),
      timeout: 60000,
      ports: [3000],
    });
    const before = sandbox.toJSON();
    await sandbox.update({
      ports: [3001],
      timeout: 65000,
      tags: { purpose: "updated" },
    });
    expect(sandbox.sessionId).toBe(before.sessionId);
    expect(sandbox.toJSON().deadline).toBe(before.deadline! + 5000);
    expect(backend.deadlines.get(before.instanceId!)).toBe(
      before.deadline! + 5000,
    );
    expect(sandbox.domain(3001)).toContain("3001");
    expect(() => sandbox.domain(3000)).toThrow();
    expect(sandbox.tags).toEqual({ purpose: "updated" });
  });

  test("sorting and snapshot name filters reach the server", async () => {
    const zebra = await Sandbox.create({ ...connection(), name: "zebra" });
    const alpha = await Sandbox.create({ ...connection(), name: "alpha" });
    const listed = await Sandbox.list({
      ...connection(),
      sortBy: "name",
      sortOrder: "asc",
      limit: 1,
    });
    expect((await listed.toArray()).map((item) => item.name)).toEqual([
      "alpha",
      "zebra",
    ]);
    await zebra.snapshot();
    await alpha.snapshot();
    const snapshots = await Snapshot.list({ ...connection(), name: "alpha" });
    const records = await snapshots.toArray();
    expect(records).toHaveLength(1);
    expect(records[0]!.sandboxId).toBe(alpha.sandboxId);
  });

  test("deleteOrphanSnapshots removes owned snapshots while preserving a fork's source", async () => {
    const source = await Sandbox.create({
      ...connection(),
      name: "owner",
      keepLastSnapshots: { count: 10 },
    });
    const first = await source.snapshot();
    const fork = await Sandbox.create({
      ...connection(),
      name: "dependent",
      source: { type: "snapshot", snapshotId: first.snapshotId },
    });
    await source.runCommand("true");
    const second = await source.snapshot();
    await source.delete({ deleteOrphanSnapshots: true });
    await expect(
      Snapshot.get({ ...connection(), snapshotId: second.snapshotId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await Snapshot.get({ ...connection(), snapshotId: first.snapshotId }))
        .snapshotId,
    ).toBe(first.snapshotId);
    expect((await fork.runCommand("true")).exitCode).toBe(0);
  });

  test("stopping creates one restorable snapshot per session and applies retention to later stops", async () => {
    const sandbox = await Sandbox.create({
      ...connection(),
      keepLastSnapshots: { count: 1 },
    });
    await sandbox.writeFiles([{ path: "state", content: "first session" }]);
    const firstSessionId = sandbox.sessionId;
    const first = await sandbox.stop();
    expect(first.status).toBe("stopped");
    expect(first.snapshot?.sourceSessionId).toBe(firstSessionId);
    expect(first.snapshot?.status).toBe("ready");
    expect(backend.instances.get(first.instanceId!)?.state).toBe("Stopped");
    expect(backend.snapshots.size).toBe(1);
    expect((await sandbox.stop()).snapshot?.snapshotId).toBe(
      first.snapshot!.snapshotId,
    );
    expect(backend.snapshots.size).toBe(1);
    const restored = await Sandbox.create({
      ...connection(),
      source: { type: "snapshot", snapshotId: first.snapshot!.snapshotId },
    });
    expect(
      (await restored.readFileToBuffer({ path: "state" }))?.toString(),
    ).toBe("first session");
    await restored.delete();
    await sandbox.writeFiles([{ path: "state", content: "second session" }]);
    expect(sandbox.sessionId).not.toBe(firstSessionId);
    const second = await sandbox.stop();
    expect(second.snapshot?.snapshotId).not.toBe(first.snapshot!.snapshotId);
    expect(second.snapshot?.parentId).toBe(first.snapshot!.snapshotId);
    expect(backend.snapshots.size).toBe(1);
    await expect(
      Snapshot.get({ ...connection(), snapshotId: first.snapshot!.snapshotId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const resumedCopy = await Sandbox.create({
      ...connection(),
      source: { type: "snapshot", snapshotId: second.snapshot!.snapshotId },
    });
    expect(
      (await resumedCopy.readFileToBuffer({ path: "state" }))?.toString(),
    ).toBe("second session");
  });

  test("retention may retain evicted snapshots with their ordinary expiration", async () => {
    const sandbox = await Sandbox.create({
      ...connection(),
      snapshotExpiration: 90000,
      keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: false },
    });
    const first = (await sandbox.stop()).snapshot!;
    expect(first.expiresAt).toBeNull();
    await sandbox.resume();
    const second = (await sandbox.stop()).snapshot!;
    expect(second.expiresAt).toBeNull();
    const evicted = await Snapshot.get({
      ...connection(),
      snapshotId: first.snapshotId,
    });
    expect(evicted.toJSON().expiration).toBe(90000);
    expect(evicted.expiresAt!.getTime()).toBe(first.updatedAt! + 90000);
    expect(backend.snapshots.size).toBe(2);
  });

  test("brokered credential values stay outside public records and guest environments across stop, rotation, and restore", async () => {
    const originalCapabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await originalCapabilities()),
      credentialBrokering: true,
    });
    const rotations: Array<{ id: string; secrets: Record<string, string> }> =
      [];
    (backend as Backend).rotateCredentials = async (id, secrets) => {
      rotations.push({ id, secrets });
    };
    const secret = "private-credential-value-never-in-public-json",
      rotated = "rotated-credential-value-never-in-guest-env";
    const sandbox = await Sandbox.create({
      ...connection(),
      credentials: {
        SERVICE_TOKEN: {
          source: { env: "BROKER_SOURCE" },
          inject: [
            {
              hosts: ["api.example.test"],
              as: { header: "Authorization", format: "Bearer ${value}" },
            },
          ],
        },
      },
      credentialSecrets: { BROKER_SOURCE: secret },
    });
    const native = backend.instances.get(sandbox.toJSON().instanceId!)!;
    expect(native.options.credentialSecrets).toEqual({ BROKER_SOURCE: secret });
    expect(native.options.env.BROKER_SOURCE).toBeUndefined();
    expect(native.options.env.SERVICE_TOKEN).toBeUndefined();
    const command = await sandbox.runCommand("bun", [
      "-e",
      "process.stdout.write(JSON.stringify([process.env.BROKER_SOURCE,process.env.SERVICE_TOKEN]))",
    ]);
    expect(await command.stdout()).toBe("[null,null]");
    const stopped = await sandbox.stop();
    const publicRecords = JSON.stringify([
      sandbox.toJSON(),
      stopped,
      await Sandbox.list(connection()),
      await Snapshot.list(connection()),
      await sandbox.listCommands(),
    ]);
    expect(publicRecords).not.toContain(secret);
    expect(
      store.get<Record<string, string>>(
        "snapshot-credentials",
        stopped.snapshot!.snapshotId,
      ),
    ).toEqual({ BROKER_SOURCE: secret });
    await sandbox.update({ credentialSecrets: { BROKER_SOURCE: rotated } });
    expect(rotations).toHaveLength(0);
    await sandbox.resume();
    expect(rotations).toEqual([
      { id: sandbox.toJSON().instanceId!, secrets: { BROKER_SOURCE: rotated } },
    ]);
    const restored = await Sandbox.create({
      ...connection(),
      source: { type: "snapshot", snapshotId: stopped.snapshot!.snapshotId },
    });
    expect(
      backend.instances.get(restored.toJSON().instanceId!)!.options
        .credentialSecrets,
    ).toEqual({ BROKER_SOURCE: secret });
    expect(JSON.stringify([sandbox.toJSON(), restored.toJSON()])).not.toContain(
      rotated,
    );
    await restored.delete();
    expect(store.get("credentials", restored.sandboxId)).toBeUndefined();
    await sandbox.delete({ deleteOrphanSnapshots: true });
    expect(store.get("credentials", sandbox.sandboxId)).toBeUndefined();
    expect(store.all<SnapshotRecord>("snapshot")).toEqual([]);
    expect(store.all("snapshot-credentials")).toEqual([]);
  });

  test("missing and guest-exposed brokered credential secrets are rejected before instance creation", async () => {
    const credentials = {
      SERVICE_TOKEN: {
        source: { env: "BROKER_SOURCE" },
        inject: [
          {
            hosts: ["api.example.test"],
            as: { header: "Authorization", format: "Bearer ${value}" },
          },
        ],
      },
    };
    await expect(
      Sandbox.create({ ...connection(), credentials }),
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIAL_SECRET" });
    await expect(
      Sandbox.create({
        ...connection(),
        credentials,
        credentialSecrets: { BROKER_SOURCE: "secret" },
        env: { SERVICE_TOKEN: "secret" },
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ENV_CONFLICT" });
    await expect(
      Sandbox.create({
        ...connection(),
        credentialSecrets: { BROKER_SOURCE: "secret" },
      }),
    ).rejects.toMatchObject({ code: "UNBOUND_CREDENTIAL_SECRET" });
    expect(backend.createCalls).toBe(0);
    expect(store.all("credentials")).toEqual([]);
  });

  test("running configuration changes are staged while current commands and attachments retain session configuration", async () => {
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const firstDrive = await Drive.getOrCreate({
      ...connection(),
      name: "first-drive",
    });
    const nextDrive = await Drive.getOrCreate({
      ...connection(),
      name: "next-drive",
    });
    const sandbox = await Sandbox.create({
      ...connection(),
      resources: { vcpus: 1, memoryMb: 512 },
      env: { SESSION_VALUE: "before" },
      mounts: { "/mnt/cache": firstDrive },
      keepLastSnapshots: { count: 10 },
    });
    const firstInstance = sandbox.toJSON().instanceId!,
      firstSession = sandbox.sessionId;
    await sandbox.writeFiles([
      { path: "root-file", content: "retained root filesystem" },
    ]);
    await sandbox.update({
      resources: { vcpus: 2, memoryMb: 768 },
      env: { SESSION_VALUE: "after" },
      mounts: { "/mnt/next": nextDrive },
    });
    expect(sandbox.sessionId).toBe(firstSession);
    expect(sandbox.currentSession().vcpus).toBe(1);
    expect(sandbox.currentSession().memory).toBe(512);
    expect(sandbox.toJSON().instanceId).toBe(firstInstance);
    expect(
      backend.instances.get(firstInstance)!.options.resources,
    ).toMatchObject({ vcpus: 1, memoryMb: 512 });
    expect(
      backend.instances.get(firstInstance)!.options.mounts[0]?.volumeId,
    ).toBe(firstDrive.toJSON().nativeId);
    expect(
      await (
        await sandbox.runCommand("bun", [
          "-e",
          "process.stdout.write(process.env.SESSION_VALUE)",
        ])
      ).stdout(),
    ).toBe("before");
    await expect(
      Sandbox.create({ ...connection(), mounts: { "/mnt/old": firstDrive } }),
    ).rejects.toMatchObject({ code: "DRIVE_IN_USE" });
    const stopped = await sandbox.stop();
    expect(backend.instances.has(firstInstance)).toBe(false);
    expect(stopped.snapshot!.config.resources).toMatchObject({
      vcpus: 1,
      memoryMb: 512,
    });
    expect(stopped.snapshot!.config.env).toEqual({ SESSION_VALUE: "before" });
    expect(stopped.snapshot!.config.mounts!["/mnt/cache"]?.driveId).toBe(
      firstDrive.driveId,
    );
    const reassigned = await Sandbox.create({
      ...connection(),
      mounts: { "/mnt/old": firstDrive },
    });
    await sandbox.resume();
    const resumed = backend.instances.get(sandbox.toJSON().instanceId!)!;
    expect(resumed.options.resources).toMatchObject({
      vcpus: 2,
      memoryMb: 768,
    });
    expect(sandbox.currentSession().vcpus).toBe(2);
    expect(sandbox.currentSession().memory).toBe(768);
    const historical = (await (await sandbox.listSessions()).toArray()).find(
      (session) => session.sessionId === firstSession,
    )!;
    expect(historical.resources).toMatchObject({ vcpus: 1, memoryMb: 512 });
    expect(resumed.options.mounts.map((mount) => mount.volumeId)).toEqual([
      nextDrive.toJSON().nativeId,
    ]);
    expect(
      (await sandbox.readFileToBuffer({ path: "root-file" }))?.toString(),
    ).toBe("retained root filesystem");
    expect(
      await (
        await sandbox.runCommand("bun", [
          "-e",
          "process.stdout.write(process.env.SESSION_VALUE)",
        ])
      ).stdout(),
    ).toBe("after");
    const fork = await Sandbox.create({
      ...connection(),
      source: { type: "snapshot", snapshotId: stopped.snapshot!.snapshotId },
    });
    expect(fork.mounts).toEqual({});
    expect(
      backend.instances.get(fork.toJSON().instanceId!)!.options.mounts,
    ).toEqual([]);
    await reassigned.delete();
  });

  test("stopped rollback restores the selected filesystem without retaining later writes", async () => {
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const sandbox = await Sandbox.create({
      ...connection(),
      keepLastSnapshots: { count: 10 },
    });
    await sandbox.writeFiles([{ path: "state", content: "first" }]);
    const first = (await sandbox.stop()).snapshot!;
    await sandbox.writeFiles([{ path: "state", content: "second" }]);
    await expect(
      sandbox.update({ currentSnapshotId: first.snapshotId }),
    ).rejects.toMatchObject({ code: "SANDBOX_RUNNING" });
    await sandbox.stop();
    await sandbox.update({
      currentSnapshotId: first.snapshotId,
      resources: { vcpus: 4 },
    });
    expect(sandbox.currentSnapshotId).toBe(first.snapshotId);
    expect(sandbox.memory).toBe(8192);
    await sandbox.resume();
    expect(
      (await sandbox.readFileToBuffer({ path: "state" }))?.toString(),
    ).toBe("first");
    expect(
      backend.instances.get(sandbox.toJSON().instanceId!)!.options.resources
        .vcpus,
    ).toBe(4);
  });

  test("null retention removes count eviction and keeps existing snapshots", async () => {
    const sandbox = await Sandbox.create({
      ...connection(),
      keepLastSnapshots: { count: 1 },
    });
    await sandbox.update({ keepLastSnapshots: null });
    expect(sandbox.keepLastSnapshots).toBeNull();
    const first = await sandbox.stop();
    await sandbox.resume();
    await sandbox.stop();
    expect(
      (
        await Snapshot.get({
          ...connection(),
          snapshotId: first.snapshot!.snapshotId,
        })
      ).status,
    ).toBe("created");
    expect(backend.snapshots.size).toBe(2);
  });

  test("drive snapshots mount immutable generations and drive forks retain independent ancestry", async () => {
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
      atomicVolumeClone: true,
    });
    const drive = await Drive.getOrCreate({
      ...connection(),
      name: "base-drive",
    });
    const owner = await Sandbox.create({
      ...connection(),
      mounts: { "/mnt/writer": drive },
    });
    const reader = await Sandbox.create({
      ...connection(),
      mounts: { "/mnt/reader": drive.snapshot() },
    });
    const generation = reader.toJSON().mounts["/mnt/reader"]!;
    expect(generation.driveId).not.toBe(drive.driveId);
    expect(generation.readOnly).toBe(true);
    const immutable = await Drive.get({
      ...connection(),
      driveId: generation.driveId,
    });
    expect(immutable.toJSON().immutable).toBe(true);
    expect(immutable.toJSON().sourceDriveId).toBe(drive.driveId);
    expect(backend.volumeClones).toHaveLength(1);
    const fork = await drive.fork({ name: "drive-fork" });
    expect(fork.parentDriveId).toBe(drive.driveId);
    expect(fork.rootDriveId).toBe(drive.driveId);
    expect(fork.toJSON().immutable).toBe(false);
    expect(fork.toJSON().nativeId).not.toBe(drive.toJSON().nativeId);
    await reader.delete({ deleteOrphanSnapshots: true });
    await expect(
      Drive.get({ ...connection(), driveId: immutable.driveId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(backend.volumes.has(drive.toJSON().nativeId)).toBe(true);
    expect(backend.volumes.has(fork.toJSON().nativeId)).toBe(true);
    expect((await owner.runCommand("true")).exitCode).toBe(0);
  });

  test("a staged snapshot drive is captured when the next session mounts it", async () => {
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
      atomicVolumeClone: true,
    });
    const drive = await Drive.getOrCreate({
      ...connection(),
      name: "staged-base",
    });
    const sandbox = await Sandbox.create(connection());
    await sandbox.update({ mounts: { "/mnt/later": drive.snapshot() } });
    expect(backend.volumeClones).toHaveLength(0);
    expect(sandbox.toJSON().mounts["/mnt/later"]?.driveId).toBe(drive.driveId);
    await sandbox.stop();
    expect(backend.volumeClones).toHaveLength(0);
    await sandbox.resume();
    expect(backend.volumeClones).toHaveLength(1);
    const generation = sandbox.toJSON().mounts["/mnt/later"]!.driveId;
    expect(generation).not.toBe(drive.driveId);
    expect(
      (await Drive.get({ ...connection(), driveId: generation })).toJSON()
        .immutable,
    ).toBe(true);
    expect(
      backend.instances.get(sandbox.toJSON().instanceId!)!.options.mounts[0]!
        .readOnly,
    ).toBe(true);
  });
});
