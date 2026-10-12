import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, BackendExec, Execution } from "../src/backend.ts";
import { SboxError } from "../src/errors.ts";
import type {
  DriveRecord,
  SandboxRecord,
  SessionRecord,
  SnapshotRecord,
} from "../src/types.ts";
import { SandboxService, startServer, Store } from "../src/server/index.ts";
import type { ServiceOptions } from "../src/server/service.ts";
import { TestBackend } from "./test-backend.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledExecution() {
  const completion = deferred<{ exitCode: number }>();
  const signals: string[] = [];
  const execution: Execution = {
    output: {
      async *[Symbol.asyncIterator]() {
        await completion.promise;
      },
    },
    exited: completion.promise,
    async write() {},
    async closeStdin() {},
    async resize() {},
    async kill(signal = "SIGTERM") {
      signals.push(signal);
      completion.resolve({ exitCode: 137 });
    },
  };
  return {
    execution,
    signals,
    finish: (exitCode = 0) => completion.resolve({ exitCode }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: ServiceOptions = {}) {
  const backend = await new TestBackend().initialize();
  const store = new Store(":memory:");
  const service = new SandboxService(backend, store, options);
  cleanups.push(async () => {
    await service.close();
    store.close();
    await backend.dispose();
  });
  return { backend, store, service };
}

const execOptions: BackendExec = {
  cmd: "true",
  args: [],
  cwd: "/vercel/sandbox",
  env: {},
  user: "sandbox",
};

describe("concurrent admission and shutdown", () => {
  test("an in-flight restore reserves its drive writer before native allocation returns", async () => {
    const { backend, service } = await fixture();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const drive = await service.getOrCreateDrive("exclusive-restore");
    const mount = { "/mnt/data": { driveId: drive.driveId, readOnly: false } };
    const first = (await service.create({ mounts: mount })).sandbox;
    await service.stop(first.sandboxId);
    const second = (await service.create({ mounts: mount })).sandbox;
    await service.stop(second.sandboxId);
    const entered = deferred<void>(),
      finish = deferred<void>();
    const restore = backend.restore.bind(backend);
    backend.restore = async (snapshotId, options) => {
      entered.resolve();
      await finish.promise;
      return restore(snapshotId, options);
    };
    const resuming = service.resume(first.sandboxId);
    await entered.promise;
    try {
      await expect(service.resume(second.sandboxId)).rejects.toMatchObject({
        code: "DRIVE_IN_USE",
      });
      expect(service.get(second.sandboxId).status).toBe("stopped");
    } finally {
      finish.resolve();
      await resuming;
    }
    expect(backend.restoreCalls).toBe(1);
  });

  test("pending provider exec reserves command capacity across separate sandboxes", async () => {
    const { backend, service } = await fixture({ maxCommands: 1 });
    const first = (await service.create({ name: "first" })).sandbox;
    const second = (await service.create({ name: "second" })).sandbox;
    const entered = deferred<void>(),
      release = deferred<void>();
    const child = controlledExecution();
    let attempts = 0;
    backend.exec = async () => {
      attempts++;
      if (attempts > 1)
        throw Error("Provider must not receive a second concurrent exec");
      entered.resolve();
      await release.promise;
      return child.execution;
    };
    const pending = service.run(first.sandboxId, { cmd: "true" });
    await entered.promise;
    try {
      await expect(
        service.run(second.sandboxId, { cmd: "true" }),
      ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
      expect(attempts).toBe(1);
    } finally {
      release.resolve();
    }
    const command = await pending;
    child.finish(7);
    expect((await service.wait(command.commandId)).exitCode).toBe(7);

    const next = controlledExecution();
    backend.exec = async () => next.execution;
    const admitted = await service.run(second.sandboxId, { cmd: "true" });
    next.finish();
    expect((await service.wait(admitted.commandId)).exitCode).toBe(0);
  });

  test("pending resume reserves sandbox capacity before provider start finishes", async () => {
    const { backend, service } = await fixture({ maxSandboxes: 1 });
    const first = (await service.create({ name: "first" })).sandbox;
    await service.stop(first.sandboxId);
    const second = (await service.create({ name: "second" })).sandbox;
    await service.stop(second.sandboxId);
    const entered = deferred<void>(),
      release = deferred<void>();
    const start = backend.start.bind(backend);
    let attempts = 0;
    backend.start = async (id) => {
      attempts++;
      if (attempts > 1)
        throw Error("Provider must not receive a second concurrent start");
      entered.resolve();
      await release.promise;
      return start(id);
    };
    const pending = service.resume(first.sandboxId);
    await entered.promise;
    try {
      await expect(service.resume(second.sandboxId)).rejects.toMatchObject({
        code: "CAPACITY_EXCEEDED",
      });
      expect(attempts).toBe(1);
      expect(service.get(second.sandboxId).status).toBe("stopped");
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe("running");
    expect(
      [...backend.instances.values()].filter(
        (instance) => instance.state === "Running",
      ),
    ).toHaveLength(1);
  });

  test("exec returned by the provider after service shutdown is killed immediately", async () => {
    const { backend, service } = await fixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    const child = controlledExecution();
    backend.exec = async () => {
      entered.resolve();
      await release.promise;
      return child.execution;
    };
    const pending = service.execute("late-instance", execOptions);
    await entered.promise;
    await service.close();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "SERVER_CLOSING" });
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(await child.execution.exited).toEqual({ exitCode: 137 });
    await expect(
      service.execute("late-instance", execOptions),
    ).rejects.toMatchObject({ code: "SERVER_CLOSING" });
  });
});

describe("ownership recovery after uncertain provider outcomes", () => {
  test("lost create response retains the exact native instance when cleanup fails", async () => {
    const { backend, store, service } = await fixture();
    const create = backend.create.bind(backend),
      get = backend.get.bind(backend),
      destroy = backend.delete.bind(backend);
    let allocatedId = "";
    backend.create = async (options) => {
      allocatedId = (await create(options)).id;
      throw Error("Create response was lost");
    };
    backend.get = async (ref) => {
      const match = [...backend.instances].find(
        ([, instance]) => instance.options.name === ref,
      );
      return get(match?.[0] ?? ref);
    };
    backend.delete = async () => {
      throw Error("Provider temporarily unreachable during cleanup");
    };
    await expect(service.create({ name: "recoverable" })).rejects.toThrow(
      "Create response was lost",
    );
    const record = service.get("recoverable");
    expect(record.status).toBe("failed");
    expect(record.instanceId).toBe(allocatedId);
    expect(backend.instances.get(allocatedId)?.options.name).toBe(
      record.sandboxId,
    );
    expect(store.all("sandbox")).toHaveLength(1);
    await expect(service.create({ name: "recoverable" })).rejects.toMatchObject(
      { code: "ALREADY_EXISTS" },
    );
    expect(backend.createCalls).toBe(1);
    backend.delete = destroy;
    await service.delete(record.sandboxId);
    expect(backend.instances.size).toBe(0);
    expect(store.all("sandbox")).toHaveLength(0);
  });

  test("failed volume response journals the exact provider name and prevents duplicate creation", async () => {
    const { backend, store, service } = await fixture();
    const provider: Backend = backend;
    const createVolume = backend.createVolume.bind(backend),
      deleteVolume = backend.deleteVolume.bind(backend);
    let attemptedName = "",
      allocatedId = "",
      attempts = 0;
    provider.createVolume = async (name, sizeBytes) => {
      attempts++;
      attemptedName = name;
      expect(sizeBytes).toBe(2 * 1024 ** 3);
      allocatedId = (await createVolume()).id;
      throw Error("Volume response was lost");
    };
    provider.deleteVolume = async (ref) => {
      expect(ref).toBe(attemptedName);
      await deleteVolume(allocatedId);
    };
    await expect(
      service.getOrCreateDrive("cache", 1024 ** 3 + 1),
    ).rejects.toThrow("Volume response was lost");
    const record = store.all<DriveRecord>("drive")[0]!;
    expect(record).toMatchObject({
      name: "cache",
      status: "failed",
      nativeId: attemptedName,
      driveId: attemptedName,
    });
    expect(attemptedName).toMatch(/^drv-/);
    expect(backend.volumes.has(allocatedId)).toBe(true);
    await expect(service.getOrCreateDrive("cache")).rejects.toMatchObject({
      code: "DRIVE_NOT_READY",
    });
    expect(attempts).toBe(1);
    await service.deleteDrive("cache");
    expect(backend.volumes.size).toBe(0);
    expect(store.all("drive")).toHaveLength(0);
  });

  test("snapshot response recovery uses the journaled source and unique name", async () => {
    const { backend, store, service } = await fixture();
    const { sandbox } = await service.create({ name: "recover-snapshot" });
    const provider: Backend = backend,
      capture = backend.snapshot.bind(backend);
    let nativeId = "",
      attemptedName = "";
    provider.snapshot = async (source, name) => {
      attemptedName = name;
      const pending = store.get<SnapshotRecord>("snapshot", name)!;
      expect(pending).toMatchObject({
        status: "creating",
        sourceInstanceId: sandbox.instanceId,
      });
      nativeId = (await capture(source)).id;
      throw Error("Snapshot response was lost");
    };
    provider.findSnapshot = async (source, name) => {
      expect(source).toBe(sandbox.instanceId!);
      expect(name).toBe(attemptedName);
      return { id: nativeId };
    };
    const snapshot = await service.makeSnapshot(sandbox.sandboxId);
    expect(snapshot).toMatchObject({
      snapshotId: attemptedName,
      nativeId,
      status: "ready",
    });
    expect(store.all("snapshot")).toHaveLength(1);
    await expect(
      service.deleteSnapshot(snapshot.snapshotId),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_IN_USE",
    });
    await service.delete(sandbox.sandboxId);
    await service.deleteSnapshot(snapshot.snapshotId);
    expect(backend.snapshots.size).toBe(0);
  });
});

describe("snapshot deletion and new filesystem references", () => {
  async function unreferencedSnapshot(service: SandboxService) {
    const source = (await service.create({ persistent: false })).sandbox;
    const snapshot = await service.makeSnapshot(source.sandboxId);
    await service.delete(source.sandboxId);
    return snapshot;
  }

  test("source reservation covers capabilities before sandbox publication and ephemeral restoration", async () => {
    const { backend, store, service } = await fixture();
    const snapshot = await unreferencedSnapshot(service);
    const entered = deferred<void>(),
      release = deferred<void>();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => {
      entered.resolve();
      await release.promise;
      return capabilities();
    };
    const creating = service.create({
      persistent: false,
      source: { type: "snapshot", snapshotId: snapshot.snapshotId },
    });
    await entered.promise;
    try {
      expect(store.all("sandbox")).toHaveLength(0);
      await expect(
        service.deleteSnapshot(snapshot.snapshotId),
      ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
      expect(store.all("snapshot-deletion")).toHaveLength(0);
      expect(backend.snapshots.has(snapshot.nativeId)).toBe(true);
    } finally {
      release.resolve();
    }
    const created = (await creating).sandbox;
    expect(created.status).toBe("running");
    await service.deleteSnapshot(snapshot.snapshotId);
    expect(backend.instances.has(created.instanceId!)).toBe(true);
    expect(backend.snapshots.has(snapshot.nativeId)).toBe(false);
  });

  test("concurrent queued source reservations survive a failed caller and release when both finish", async () => {
    const { backend, service } = await fixture();
    const snapshot = await unreferencedSnapshot(service);
    const entered = deferred<void>(),
      release = deferred<void>();
    const capabilities = backend.capabilities.bind(backend);
    let attempt = 0;
    backend.capabilities = async () => {
      if (++attempt === 1) throw Error("capabilities unavailable");
      entered.resolve();
      await release.promise;
      return capabilities();
    };
    const options = {
      persistent: false,
      source: { type: "snapshot" as const, snapshotId: snapshot.snapshotId },
    };
    const first = service.create(options);
    const failed = expect(first).rejects.toThrow("capabilities unavailable");
    const second = service.create(options);
    await failed;
    await entered.promise;
    try {
      await expect(
        service.deleteSnapshot(snapshot.snapshotId),
      ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
    } finally {
      release.resolve();
    }
    await second;
    await service.deleteSnapshot(snapshot.snapshotId);
    expect(backend.snapshots.size).toBe(0);
  });

  test("rollback reserves the selected snapshot before provider validation and publishes its durable reference", async () => {
    const { backend, store, service } = await fixture();
    const snapshot = await unreferencedSnapshot(service);
    const target = (await service.create()).sandbox;
    await service.stop(target.sandboxId);
    const entered = deferred<void>(),
      release = deferred<void>();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => {
      entered.resolve();
      await release.promise;
      return { ...(await capabilities()), rootfsTransplant: true };
    };
    const updating = service.update(target.sandboxId, {
      currentSnapshotId: snapshot.snapshotId,
    });
    await entered.promise;
    try {
      expect(
        store.get<SandboxRecord>("sandbox", target.sandboxId)!.snapshotId,
      ).not.toBe(snapshot.snapshotId);
      await expect(
        service.deleteSnapshot(snapshot.snapshotId),
      ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
    } finally {
      release.resolve();
    }
    expect((await updating).snapshotId).toBe(snapshot.snapshotId);
    await expect(
      service.deleteSnapshot(snapshot.snapshotId),
    ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
    await service.delete(target.sandboxId);
    await service.deleteSnapshot(snapshot.snapshotId);
  });

  test("deletion intent blocks create and rollback while concurrent deletes share one native operation", async () => {
    const { backend, store, service } = await fixture();
    const snapshot = await unreferencedSnapshot(service);
    const target = (await service.create()).sandbox;
    await service.stop(target.sandboxId);
    const entered = deferred<void>(),
      release = deferred<void>();
    const remove = backend.deleteSnapshot.bind(backend);
    let calls = 0;
    backend.deleteSnapshot = async (nativeId) => {
      calls++;
      expect(store.get("snapshot-deletion", snapshot.snapshotId)).toBeDefined();
      entered.resolve();
      await release.promise;
      await remove(nativeId);
    };
    const deleting = service.deleteSnapshot(snapshot.snapshotId);
    await entered.promise;
    const duplicate = service.deleteSnapshot(snapshot.snapshotId);
    try {
      await expect(
        service.create({
          source: { type: "snapshot", snapshotId: snapshot.snapshotId },
        }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_DELETING" });
      await expect(
        service.update(target.sandboxId, {
          currentSnapshotId: snapshot.snapshotId,
        }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_DELETING" });
      expect(calls).toBe(1);
    } finally {
      release.resolve();
    }
    await Promise.all([deleting, duplicate]);
    expect(calls).toBe(1);
    expect(store.get("snapshot", snapshot.snapshotId)).toBeUndefined();
    expect(store.get("snapshot-deletion", snapshot.snapshotId)).toBeUndefined();
  });

  test("restart retries a lost deletion response from durable intent before allowing new references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbox-snapshot-delete-"));
    const backend = await new TestBackend().initialize();
    const path = join(directory, "state.sqlite");
    let store = new Store(path);
    let service = new SandboxService(backend, store);
    cleanups.push(async () => {
      await service.close();
      store.close();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const snapshot = await unreferencedSnapshot(service);
    const remove = backend.deleteSnapshot.bind(backend);
    let calls = 0;
    backend.deleteSnapshot = async (nativeId) => {
      calls++;
      expect(nativeId).toBe(snapshot.nativeId);
      if (!backend.snapshots.has(nativeId))
        throw new SboxError("NOT_FOUND", "Already removed", 404);
      await remove(nativeId);
      throw Error("DELETE response lost");
    };
    await expect(service.deleteSnapshot(snapshot.snapshotId)).rejects.toThrow(
      "DELETE response lost",
    );
    expect(store.get("snapshot-deletion", snapshot.snapshotId)).toBeDefined();
    expect(backend.snapshots.has(snapshot.nativeId)).toBe(false);
    await service.close();
    store.close();
    store = new Store(path);
    service = new SandboxService(backend, store);
    await expect(
      service.create({
        source: { type: "snapshot", snapshotId: snapshot.snapshotId },
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_DELETING" });
    await service.initialize();
    expect(calls).toBe(2);
    expect(store.get("snapshot", snapshot.snapshotId)).toBeUndefined();
    expect(store.get("snapshot-deletion", snapshot.snapshotId)).toBeUndefined();
    expect(
      store.get("snapshot-network-policy", snapshot.snapshotId),
    ).toBeUndefined();
  });

  test("a restarted failed ephemeral restoration keeps its source until uncertain ownership is cleared", async () => {
    const { backend, store, service } = await fixture();
    const snapshot = await unreferencedSnapshot(service);
    backend.restore = async () => {
      throw Error("restore response lost");
    };
    await expect(
      service.create({
        persistent: false,
        source: { type: "snapshot", snapshotId: snapshot.snapshotId },
      }),
    ).rejects.toThrow("restore response lost");
    const failed = store.all<SandboxRecord>("sandbox")[0]!;
    expect(failed).toMatchObject({
      status: "failed",
      persistent: false,
      snapshotId: snapshot.snapshotId,
    });
    await service.close();
    const restarted = new SandboxService(backend, store);
    cleanups.push(() => restarted.close());
    await restarted.initialize();
    await expect(
      restarted.deleteSnapshot(snapshot.snapshotId),
    ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
    expect(store.get("snapshot-deletion", snapshot.snapshotId)).toBeUndefined();
    await restarted.delete(failed.sandboxId);
    await restarted.deleteSnapshot(snapshot.snapshotId);
    expect(backend.snapshots.size).toBe(0);
  });
});

describe("durable snapshot completion", () => {
  test("resume restores a committed snapshot after native deletion completed before its metadata write", async () => {
    const { backend, store, service } = await fixture();
    const sandbox = (await service.create()).sandbox;
    await service.fs(sandbox.sandboxId, "writeFile", {
      path: "recovery",
      data: Buffer.from("durable").toString("base64"),
    });
    await service.stop(sandbox.sandboxId);
    const stopped = service.get(sandbox.sandboxId);
    expect(stopped.snapshotId).toBeDefined();
    const deletedId = stopped.instanceId!;
    await backend.delete(deletedId);
    expect(
      store.get<SandboxRecord>("sandbox", sandbox.sandboxId)!.instanceId,
    ).toBe(deletedId);
    const resumed = await service.resume(sandbox.sandboxId);
    expect(resumed.status).toBe("running");
    expect(resumed.instanceId).not.toBe(deletedId);
    expect(
      await service.fs(sandbox.sandboxId, "readFile", { path: "recovery" }),
    ).toEqual({ data: Buffer.from("durable").toString("base64") });
  });

  test("a failed native delete retries cleanup without duplicating the committed snapshot", async () => {
    const { backend, store, service } = await fixture();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const sandbox = (await service.create()).sandbox;
    const remove = backend.delete.bind(backend);
    let failures = 1;
    backend.delete = async (id) => {
      if (failures--) throw Error("temporary delete failure");
      await remove(id);
    };
    await expect(service.stop(sandbox.sandboxId)).rejects.toThrow(
      "temporary delete failure",
    );
    const pending = service.get(sandbox.sandboxId);
    expect(pending.status).toBe("stopped");
    expect(pending.snapshotPending).toBe(true);
    expect(pending.pendingSnapshotId).toBe(pending.snapshotId);
    expect(backend.snapshots.size).toBe(1);
    const completed = await service.stop(sandbox.sandboxId);
    expect(completed.instanceId).toBeUndefined();
    expect(completed.snapshotPending).toBe(false);
    expect(completed.pendingSnapshotId).toBeUndefined();
    expect(completed.snapshotId).toBe(pending.snapshotId);
    expect(store.all("snapshot")).toHaveLength(1);
    expect(backend.snapshots.size).toBe(1);
  });

  test("startup recovers a lost capture response and binds that exact capture to the sandbox", async () => {
    const { backend, store, service } = await fixture();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const sandbox = (await service.create()).sandbox;
    const capture = backend.snapshot.bind(backend),
      find = backend.findSnapshot.bind(backend);
    let captures = 0;
    backend.snapshot = async (id, name) => {
      captures++;
      await capture(id, name);
      throw Error("lost capture response");
    };
    backend.findSnapshot = async () => {
      throw Error("provider temporarily unreachable");
    };
    await expect(service.stop(sandbox.sandboxId)).rejects.toThrow(
      "lost capture response",
    );
    const pendingId = service.get(sandbox.sandboxId).pendingSnapshotId;
    expect(pendingId).toBeTruthy();
    await service.close();
    backend.findSnapshot = find;
    const restarted = new SandboxService(backend, store);
    cleanups.push(async () => {
      await restarted.close();
    });
    await restarted.initialize();
    const recovered = restarted.get(sandbox.sandboxId);
    expect(recovered.snapshotId).toBe(pendingId);
    expect(recovered.instanceId).toBeUndefined();
    expect(recovered.snapshotPending).toBe(false);
    expect(store.all("snapshot")).toHaveLength(1);
    expect(captures).toBe(1);
    expect((await restarted.resume(sandbox.sandboxId)).status).toBe("running");
  });

  test("repeated failed captures preserve one durable operation and one snapshot record", async () => {
    const { backend, store, service } = await fixture();
    const sandbox = (await service.create()).sandbox;
    const names: string[] = [];
    backend.snapshot = async (_id, name) => {
      names.push(name!);
      throw Error("provider unavailable");
    };
    for (let i = 0; i < 3; i++)
      await expect(service.stop(sandbox.sandboxId)).rejects.toThrow(
        "provider unavailable",
      );
    expect(new Set(names).size).toBe(1);
    expect(store.all("snapshot")).toHaveLength(1);
    expect(store.all("snapshot-network-policy")).toHaveLength(1);
    expect(service.get(sandbox.sandboxId).snapshotPending).toBe(true);
  });

  test("expiration cannot delete the only persistent filesystem and resume renews its lease", async () => {
    const { backend, store, service } = await fixture();
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const sandbox = (await service.create({ snapshotExpiration: 60000 }))
      .sandbox;
    const stopped = await service.stop(sandbox.sandboxId);
    const snapshot = store.get<SnapshotRecord>(
      "snapshot",
      stopped.snapshotId!,
    )!;
    snapshot.expiresAt = Date.now() - 1;
    store.put("snapshot", snapshot.snapshotId, snapshot);
    await expect(
      service.deleteSnapshot(snapshot.snapshotId),
    ).rejects.toMatchObject({ code: "SNAPSHOT_IN_USE" });
    await service.close();
    const restarted = new SandboxService(backend, store);
    cleanups.push(async () => {
      await restarted.close();
    });
    await restarted.initialize();
    expect(store.get("snapshot", snapshot.snapshotId)).toBeDefined();
    await restarted.resume(sandbox.sandboxId);
    expect(
      store.get<SnapshotRecord>("snapshot", snapshot.snapshotId)!.expiresAt!,
    ).toBeGreaterThan(Date.now());
  });

  test("invalid mixed configuration does not delete stopped state or extend the live deadline", async () => {
    const { backend, store, service } = await fixture();
    const sandbox = (await service.create({ timeout: 60000 })).sandbox;
    const before = service.get(sandbox.sandboxId);
    await expect(
      service.update(sandbox.sandboxId, {
        timeout: 120000,
        credentialSecrets: { UNBOUND: "secret" },
      }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });
    expect(service.get(sandbox.sandboxId).deadline).toBe(before.deadline);
    expect(backend.deadlines.get(sandbox.instanceId!)).toBe(before.deadline);
    const stopped = await service.stop(sandbox.sandboxId);
    const capabilities = backend.capabilities.bind(backend);
    backend.capabilities = async () => ({
      ...(await capabilities()),
      rootfsTransplant: true,
    });
    const stored = store.get<SandboxRecord>("sandbox", sandbox.sandboxId);
    await expect(
      service.update(sandbox.sandboxId, {
        resources: { vcpus: 4 },
        credentialSecrets: { UNBOUND: "secret" },
      }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });
    expect(store.get<SandboxRecord>("sandbox", sandbox.sandboxId)).toEqual(
      stored,
    );
    expect(backend.instances.has(stopped.instanceId!)).toBe(true);
  });
});

describe("ephemeral instance cleanup", () => {
  test("snapshot preserves contents while deleting the ephemeral source instance", async () => {
    const { backend, service } = await fixture();
    const { sandbox } = await service.create({ persistent: false });
    const native = backend.instances.get(sandbox.instanceId!)!;
    const contents = Buffer.from([0, 255, 192, 128, 42]);
    await Bun.write(join(native.dir, "state.bin"), contents);
    const snapshot = await service.makeSnapshot(sandbox.sandboxId);
    expect(backend.instances.size).toBe(0);
    expect(service.get(sandbox.sandboxId)).toMatchObject({
      status: "stopped",
      persistent: false,
      snapshotId: snapshot.snapshotId,
    });
    expect(service.get(sandbox.sandboxId).instanceId).toBeUndefined();
    expect(backend.snapshots.size).toBe(1);
    expect(
      Buffer.from(
        await Bun.file(
          join(backend.snapshots.get(snapshot.nativeId)!, "state.bin"),
        ).arrayBuffer(),
      ),
    ).toEqual(contents);
    const restored = (
      await service.create({
        source: { type: "snapshot", snapshotId: snapshot.snapshotId },
      })
    ).sandbox;
    expect(restored.persistent).toBe(false);
    expect(
      Buffer.from(
        await Bun.file(
          join(backend.instances.get(restored.instanceId!)!.dir, "state.bin"),
        ).arrayBuffer(),
      ),
    ).toEqual(contents);
  });

  test("snapshot never temporarily changes persistent:false in durable metadata", async () => {
    const { backend, store, service } = await fixture();
    const { sandbox } = await service.create({ persistent: false });
    const stop = backend.stop.bind(backend),
      snapshot = backend.snapshot.bind(backend);
    const observed: Array<{ stage: string; persistent: boolean }> = [];
    backend.stop = async (id) => {
      observed.push({
        stage: "stop",
        persistent: store.get<SandboxRecord>("sandbox", sandbox.sandboxId)!
          .persistent,
      });
      await stop(id);
    };
    backend.snapshot = async (id) => {
      observed.push({
        stage: "snapshot",
        persistent: store.get<SandboxRecord>("sandbox", sandbox.sandboxId)!
          .persistent,
      });
      return snapshot(id);
    };
    await service.makeSnapshot(sandbox.sandboxId);
    expect(observed.some((value) => value.stage === "stop")).toBe(true);
    expect(observed.some((value) => value.stage === "snapshot")).toBe(true);
    expect(observed.every((value) => value.persistent === false)).toBe(true);
  });

  test("startup deletes an expired ephemeral instance already stopped by its watchdog", async () => {
    const { backend, store, service } = await fixture();
    const { sandbox } = await service.create({ persistent: false });
    await backend.stop(sandbox.instanceId!);
    sandbox.deadline = Date.now() - 1;
    store.put("sandbox", sandbox.sandboxId, sandbox, sandbox.name);
    await service.initialize();
    expect(backend.instances.size).toBe(0);
    expect(service.get(sandbox.sandboxId).status).toBe("stopped");
    expect(service.get(sandbox.sandboxId).instanceId).toBeUndefined();
    expect(
      store.get<SessionRecord>("session", sandbox.sessionId!)?.status,
    ).toBe("stopped");
    expect(backend.deleteCalls).toBe(1);
  });

  test("cleanup failure after successful snapshot retains both ownership records for retry", async () => {
    const { backend, store, service } = await fixture();
    const { sandbox } = await service.create({ persistent: false });
    const destroy = backend.delete.bind(backend);
    backend.delete = async () => {
      throw Error("Disk deletion temporarily failed");
    };
    await expect(service.makeSnapshot(sandbox.sandboxId)).rejects.toThrow(
      "Disk deletion temporarily failed",
    );
    expect(service.get(sandbox.sandboxId).instanceId).toBe(sandbox.instanceId);
    const snapshot = store.all<SnapshotRecord>("snapshot")[0]!;
    expect(snapshot.status).toBe("ready");
    expect(backend.snapshots.has(snapshot.nativeId)).toBe(true);
    backend.delete = destroy;
    await service.stop(sandbox.sandboxId);
    expect(backend.instances.size).toBe(0);
    expect(backend.snapshots.has(snapshot.nativeId)).toBe(true);
  });
});

test("failed listener binding releases the data directory lock so startup can be retried", async () => {
  const backend = await new TestBackend().initialize();
  const dataDir = await mkdtemp(join(tmpdir(), "sbox-bind-recovery-"));
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("occupied"),
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await expect(
      startServer({
        backend,
        dataDir,
        hostname: "127.0.0.1",
        port: occupied.port,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(join(dataDir, "server.lock")).exists()).toBe(false);
    server = await startServer({
      backend,
      dataDir,
      hostname: "127.0.0.1",
      port: 0,
    });
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
      200,
    );
    expect(await Bun.file(join(dataDir, "server.lock")).exists()).toBe(true);
    await server.stop(true);
    server = undefined;
    expect(await Bun.file(join(dataDir, "server.lock")).exists()).toBe(false);
  } finally {
    await server?.stop(true);
    await occupied.stop(true);
    await backend.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
