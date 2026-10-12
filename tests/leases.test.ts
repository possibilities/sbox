import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import {
  LeaseSupervisor,
  runLeaseSupervisor,
  spawnLeaseSupervisor,
  withLeaseGuard,
  type LeaseSupervisorConfig,
} from "../src/server/leases.ts";
import type { SandboxRecord } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sbox-leases-"));
  const dbPath = join(directory, "state.sqlite");
  const store = new Store(dbPath);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: LeaseSupervisorConfig = {
    dbPath,
    dataDir: directory,
    parentPid: process.pid,
    baseUrl: "http://hypeman.invalid",
    apiKey: "private-test-token",
    intervalMs: 10,
    requestTimeoutMs: 1000,
  };
  return { directory, store, config };
}

function record(patch: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    sandboxId: "sbx-one",
    instanceId: "native-one",
    sessionId: "ses-one",
    name: "private-name",
    status: "running",
    deadline: 900,
    persistent: true,
    image: "test",
    resources: { vcpus: 2, memoryMb: 1024, diskMb: 1024 },
    timeout: 1000,
    networkPolicy: "allow-all",
    env: {},
    tags: {},
    ports: [],
    routes: [],
    mounts: {},
    createdAt: 1,
    updatedAt: 1,
    snapshotExpiration: 0,
    keepLastSnapshots: { count: 1 },
    ...patch,
  };
}

function fakeProvider() {
  const states = new Map<string, { name: string; state: string }>();
  const actions: Array<{ method: string; id: string; suffix: string }> = [];
  let failures = 0;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe(
      "Bearer private-test-token",
    );
    expect(request.redirect).toBe("error");
    const match = new URL(request.url).pathname.match(
      /^\/instances\/([^/]+)(.*)$/,
    )!;
    const id = decodeURIComponent(match[1]!),
      suffix = match[2]!;
    actions.push({ method: request.method, id, suffix });
    if (failures) {
      failures--;
      return new Response(null, { status: 503 });
    }
    const nativeId = states.has(id)
      ? id
      : [...states].find(([, value]) => value.name === id)?.[0];
    const native = nativeId ? states.get(nativeId) : undefined;
    if (!native) return new Response(null, { status: 404 });
    if (request.method === "DELETE") {
      states.delete(nativeId!);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && suffix === "/stop") {
      native.state = "Stopped";
      return Response.json({ id: nativeId, ...native });
    }
    return Response.json({ id: nativeId, ...native });
  }) as unknown as typeof fetch;
  return {
    states,
    actions,
    fetch: fetcher,
    fail(count: number) {
      failures = count;
    },
  };
}

describe("independent lease enforcement", () => {
  test("stops persistent leases, deletes ephemeral leases, and never edits sandbox metadata", async () => {
    const { store, config } = await fixture();
    const provider = fakeProvider();
    const persistent = record(),
      ephemeral = record({
        sandboxId: "sbx-two",
        instanceId: "native-two",
        sessionId: "ses-two",
        persistent: false,
      });
    for (const entry of [persistent, ephemeral]) {
      store.put(
        "sandbox",
        entry.sandboxId,
        entry,
        entry.name + entry.sandboxId,
      );
      provider.states.set(entry.instanceId!, {
        name: entry.sandboxId,
        state: "Running",
      });
    }
    const before = store.all("sandbox");
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      const result = await supervisor.tick();
      expect(result).toEqual({ parentAlive: false, pending: 0, completed: 2 });
      expect(provider.states.get("native-one")?.state).toBe("Stopped");
      expect(provider.states.has("native-two")).toBe(false);
      expect(
        provider.actions.filter((action) => action.method === "DELETE"),
      ).toEqual([{ method: "DELETE", id: "native-two", suffix: "" }]);
      expect(store.all("sandbox")).toEqual(before);
      const calls = provider.actions.length;
      await supervisor.tick();
      expect(provider.actions).toHaveLength(calls);
    } finally {
      supervisor.close();
    }
  });

  test("an extension that wins the shared guard invalidates an already-observed expired lease", async () => {
    const { directory, store, config } = await fixture();
    const original = record();
    store.put("sandbox", original.sandboxId, original);
    const provider = fakeProvider();
    provider.states.set(original.instanceId!, {
      name: original.sandboxId,
      state: "Running",
    });
    const entered = deferred<void>(),
      release = deferred<void>();
    const mutation = withLeaseGuard(directory, original.sandboxId, async () => {
      entered.resolve();
      await release.promise;
      store.put("sandbox", original.sandboxId, { ...original, deadline: 2000 });
    });
    await entered.promise;
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      const tick = supervisor.tick();
      release.resolve();
      await mutation;
      expect((await tick).pending).toBe(1);
      expect(provider.actions).toEqual([]);
      expect(
        store.get<SandboxRecord>("sandbox", original.sandboxId)?.deadline,
      ).toBe(2000);
    } finally {
      release.resolve();
      await mutation;
      supervisor.close();
    }
  });

  test("a new instance and session cannot be stopped by a stale observation", async () => {
    const { directory, store, config } = await fixture();
    const original = record();
    store.put("sandbox", original.sandboxId, original);
    const provider = fakeProvider();
    const release = deferred<void>(),
      entered = deferred<void>();
    const mutation = withLeaseGuard(directory, original.sandboxId, async () => {
      entered.resolve();
      await release.promise;
      store.put(
        "sandbox",
        original.sandboxId,
        record({
          instanceId: "native-replacement",
          sessionId: "ses-new",
          deadline: 5000,
        }),
      );
    });
    await entered.promise;
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      const tick = supervisor.tick();
      release.resolve();
      await mutation;
      await tick;
      expect(provider.actions).toEqual([]);
    } finally {
      release.resolve();
      await mutation;
      supervisor.close();
    }
  });

  test("provider failures are retried and future deadlines are observed without premature stopping", async () => {
    const { store, config } = await fixture();
    let now = 1000;
    const entry = record({ deadline: 1100 });
    store.put("sandbox", entry.sandboxId, entry);
    const provider = fakeProvider();
    provider.states.set(entry.instanceId!, {
      name: entry.sandboxId,
      state: "Running",
    });
    provider.fail(1);
    const supervisor = new LeaseSupervisor(config, {
      now: () => now,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      expect((await supervisor.tick()).pending).toBe(1);
      expect(provider.actions).toEqual([]);
      now = 1200;
      expect((await supervisor.tick()).pending).toBe(1);
      expect(
        provider.actions.filter((action) => action.method === "POST"),
      ).toHaveLength(0);
      expect((await supervisor.tick()).pending).toBe(0);
      expect(
        provider.actions.filter((action) => action.method === "POST"),
      ).toHaveLength(1);
    } finally {
      supervisor.close();
    }
  });

  test("parent loss completes stopping records and expired creation/resume failures", async () => {
    const { store, config } = await fixture();
    let parentAlive = true;
    const stopping = record({ status: "stopping", deadline: undefined });
    const creating = record({
      sandboxId: "sbx-create",
      instanceId: "native-create",
      status: "creating",
      sessionId: undefined,
    });
    const failed = record({
      sandboxId: "sbx-failed",
      instanceId: "native-failed",
      status: "failed",
    });
    const provider = fakeProvider();
    for (const entry of [stopping, creating, failed]) {
      store.put("sandbox", entry.sandboxId, entry);
      provider.states.set(entry.instanceId!, {
        name: entry.sandboxId,
        state: "Running",
      });
    }
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => parentAlive,
      fetch: provider.fetch,
    });
    try {
      await supervisor.tick();
      expect(provider.states.get("native-one")?.state).toBe("Running");
      expect(provider.states.get("native-create")?.state).toBe("Stopped");
      expect(provider.states.get("native-failed")?.state).toBe("Stopped");
      parentAlive = false;
      expect((await supervisor.tick()).pending).toBe(0);
      expect(provider.states.get("native-one")?.state).toBe("Stopped");
    } finally {
      supervisor.close();
    }
  });

  test("unrelated native ownership and invalid identifiers are never mutated", async () => {
    const { store, config } = await fixture();
    const provider = fakeProvider();
    store.put("sandbox", "sbx-one", record());
    store.put(
      "sandbox",
      "sbx-bad",
      record({ sandboxId: "sbx-bad", instanceId: ".." }),
    );
    provider.states.set("native-one", {
      name: "another-application",
      state: "Running",
    });
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      await supervisor.tick();
      expect(provider.actions).toEqual([
        { method: "GET", id: "native-one", suffix: "" },
      ]);
    } finally {
      supervisor.close();
    }
  });

  test("parentless worker exits after all recorded leases have been enforced", async () => {
    const { store, config } = await fixture();
    const entry = record();
    store.put("sandbox", entry.sandboxId, entry);
    const provider = fakeProvider();
    provider.states.set(entry.instanceId!, {
      name: entry.sandboxId,
      state: "Running",
    });
    await runLeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    expect(provider.states.get(entry.instanceId!)?.state).toBe("Stopped");
  });

  test("guest shutdown still receives a host stop so hypervisor resources are released", async () => {
    const { store, config } = await fixture();
    const entry = record();
    store.put("sandbox", entry.sandboxId, entry);
    const provider = fakeProvider();
    provider.states.set(entry.instanceId!, {
      name: entry.sandboxId,
      state: "Shutdown",
    });
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      expect((await supervisor.tick()).pending).toBe(0);
      expect(
        provider.actions.filter((action) => action.method === "POST"),
      ).toEqual([{ method: "POST", id: entry.instanceId!, suffix: "/stop" }]);
      expect(provider.states.get(entry.instanceId!)?.state).toBe("Stopped");
    } finally {
      supervisor.close();
    }
  });
});

describe("lease guard process lifetime", () => {
  test("supervisor credentials use private stdin and unrelated parent secrets are not inherited", async () => {
    const { directory, config } = await fixture();
    const previous = process.env.SBOX_LEASE_TEST_PARENT_SECRET;
    process.env.SBOX_LEASE_TEST_PARENT_SECRET =
      "ambient-parent-secret-must-not-be-inherited";
    const source = `import { join } from "node:path";const config=JSON.parse(await Bun.stdin.text());await Bun.write(join(config.dataDir,"worker-report.json"),JSON.stringify({argv:process.argv,env:process.env,receivedSecret:typeof config.apiKey==="string"&&config.apiKey.length>0}));process.stdout.write("ready\\n");await Bun.sleep(60000);`;
    let worker: Awaited<ReturnType<typeof spawnLeaseSupervisor>> | undefined;
    try {
      worker = await spawnLeaseSupervisor(config, {
        executable: process.execPath,
        workerArgs: ["-e", source],
      });
      const report = JSON.parse(
        await readFile(join(directory, "worker-report.json"), "utf8"),
      );
      expect(report.receivedSecret).toBe(true);
      expect(report.env.SBOX_LEASE_TEST_PARENT_SECRET).toBeUndefined();
      expect(JSON.stringify(report.argv)).not.toContain(config.apiKey!);
      expect(JSON.stringify(report.env)).not.toContain(config.apiKey!);
    } finally {
      if (previous === undefined)
        delete process.env.SBOX_LEASE_TEST_PARENT_SECRET;
      else process.env.SBOX_LEASE_TEST_PARENT_SECRET = previous;
      worker?.release();
      if (worker) {
        try {
          process.kill(worker.pid, "SIGKILL");
        } catch {}
      }
    }
  });

  test("guards are independent by sandbox and cancellation releases a waiting connection", async () => {
    const { directory } = await fixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    const first = withLeaseGuard(directory, "one", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      expect(await withLeaseGuard(directory, "two", async () => 42)).toBe(42);
      const abort = new AbortController();
      const blocked = withLeaseGuard(
        directory,
        "one",
        async () => {
          throw Error("must not run");
        },
        abort.signal,
      );
      abort.abort(new Error("cancel waiting"));
      await expect(blocked).rejects.toThrow("cancel waiting");
    } finally {
      release.resolve();
      await first;
    }
    expect(await withLeaseGuard(directory, "one", async () => "released")).toBe(
      "released",
    );
  });

  test("a killed process cannot leave a stale mutex behind", async () => {
    const { directory } = await fixture();
    const source = `import { withLeaseGuard } from ${JSON.stringify(import.meta.resolve("../src/server/leases.ts"))}; const input=JSON.parse(await Bun.stdin.text()); await withLeaseGuard(input.directory,"one",async()=>{process.stdout.write("locked\\n");await Bun.sleep(60000);});`;
    const child = Bun.spawn([process.execPath, "-e", source], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ directory }));
    await child.stdin.end();
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "locked",
      );
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
      expect(
        await withLeaseGuard(directory, "one", async () => "recovered"),
      ).toBe("recovered");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("detached supervisor survives its API parent being killed and expires only owned leases", async () => {
    const { store, config } = await fixture();
    const entry = record({ deadline: Date.now() + 350 });
    store.put("sandbox", entry.sandboxId, entry);
    let state = "Running",
      stopped = deferred<void>();
    const native = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer private-test-token",
        );
        const path = new URL(request.url).pathname;
        expect(path).toMatch(/^\/instances\/native-one(?:\/stop)?$/);
        if (request.method === "POST") {
          state = "Stopped";
          stopped.resolve();
        }
        return Response.json({
          id: entry.instanceId,
          name: entry.sandboxId,
          state,
        });
      },
    });
    const source = `import { spawnLeaseSupervisor } from ${JSON.stringify(import.meta.resolve("../src/server/leases.ts"))}; const config=JSON.parse(await Bun.stdin.text()); const child=await spawnLeaseSupervisor(config,{executable:process.execPath});process.stdout.write(JSON.stringify({pid:child.pid})+"\\n");await Bun.sleep(60000);`;
    const parent = Bun.spawn([process.execPath, "-e", source], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    parent.stdin.write(
      JSON.stringify({
        ...config,
        baseUrl: `http://127.0.0.1:${native.port}`,
        intervalMs: 10,
      }),
    );
    await parent.stdin.end();
    let workerPid: number | undefined;
    try {
      const reader = parent.stdout.getReader();
      workerPid = JSON.parse(
        new TextDecoder().decode((await reader.read()).value),
      ).pid;
      reader.releaseLock();
      expect(workerPid).toBeGreaterThan(0);
      parent.kill("SIGKILL");
      await parent.exited;
      await Promise.race([
        stopped.promise,
        Bun.sleep(2500).then(() => {
          throw Error("Orphaned lease was not stopped");
        }),
      ]);
      expect(state).toBe("Stopped");
      expect(store.get<SandboxRecord>("sandbox", entry.sandboxId)?.status).toBe(
        "running",
      );
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      }
      await native.stop(true);
    }
  }, 5000);
});

describe("uncertain native creation lease recovery", () => {
  test("expired creating and failed records without native IDs resolve exact names and enforce their leases", async () => {
    const { store, config } = await fixture();
    const provider = fakeProvider();
    const entries = [
      record({
        sandboxId: "sbx-unknown-persistent",
        instanceId: undefined,
        status: "creating",
      }),
      record({
        sandboxId: "sbx-unknown-ephemeral",
        instanceId: undefined,
        status: "failed",
        persistent: false,
      }),
    ];
    entries.forEach((entry, index) => {
      store.put("sandbox", entry.sandboxId, entry);
      provider.states.set(`recovered-${index}`, {
        name: entry.sandboxId,
        state: "Running",
      });
    });
    const before = entries.map((entry) =>
      store.get<SandboxRecord>("sandbox", entry.sandboxId),
    );
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      expect((await supervisor.tick()).pending).toBe(0);
      expect(provider.states.get("recovered-0")?.state).toBe("Stopped");
      expect(provider.states.has("recovered-1")).toBe(false);
      expect(
        provider.actions.filter((entry) => entry.method !== "GET"),
      ).toEqual(
        expect.arrayContaining([
          { method: "POST", id: "recovered-0", suffix: "/stop" },
          { method: "DELETE", id: "recovered-1", suffix: "" },
        ]),
      );
      expect(
        entries.map((entry) =>
          store.get<SandboxRecord>("sandbox", entry.sandboxId),
        ),
      ).toEqual(before);
    } finally {
      supervisor.close();
    }
  });

  test("a missing name remains pending so a late accepted create cannot escape enforcement", async () => {
    const { store, config } = await fixture();
    const entry = record({ instanceId: undefined, status: "creating" });
    store.put("sandbox", entry.sandboxId, entry);
    const provider = fakeProvider();
    let now = 800;
    const supervisor = new LeaseSupervisor(config, {
      now: () => now,
      parentAlive: () => false,
      fetch: provider.fetch,
    });
    try {
      expect((await supervisor.tick()).pending).toBe(1);
      expect(provider.actions).toEqual([]);
      now = 1000;
      expect((await supervisor.tick()).pending).toBe(1);
      expect(provider.actions).toEqual([
        { method: "GET", id: entry.sandboxId, suffix: "" },
      ]);
      provider.states.set("late-native", {
        name: entry.sandboxId,
        state: "Running",
      });
      expect((await supervisor.tick()).pending).toBe(0);
      expect(provider.states.get("late-native")?.state).toBe("Stopped");
    } finally {
      supervisor.close();
    }
  });

  test("name fallback cannot target prefix matches, missing ownership names, or malformed native IDs", async () => {
    const { store, config } = await fixture();
    const entry = record({ instanceId: undefined, status: "creating" });
    store.put("sandbox", entry.sandboxId, entry);
    let native: unknown;
    const mutations: string[] = [];
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method !== "GET") mutations.push(init?.method ?? "GET");
      return Response.json(native);
    }) as unknown as typeof fetch;
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: fetcher,
    });
    try {
      for (const value of [
        { id: "native-other", name: "sbx-one-extra", state: "Running" },
        { id: "native-other", state: "Running" },
        { id: "../../foreign", name: entry.sandboxId, state: "Running" },
      ]) {
        native = value;
        expect((await supervisor.tick()).pending).toBe(1);
      }
      expect(mutations).toEqual([]);
    } finally {
      supervisor.close();
    }
  });

  test("metadata version is rechecked after provider lookup and stopped snapshot sources remain untouched", async () => {
    const { store, config } = await fixture();
    const provider = fakeProvider();
    const entry = record({ instanceId: undefined, status: "creating" });
    store.put("sandbox", entry.sandboxId, entry);
    provider.states.set("unknown-native", {
      name: entry.sandboxId,
      state: "Running",
    });
    const retained = record({
      sandboxId: "sbx-snapshot-source",
      instanceId: "snapshot-native",
      persistent: false,
      status: "stopped",
    });
    store.put("sandbox", retained.sandboxId, retained);
    provider.states.set("snapshot-native", {
      name: retained.sandboxId,
      state: "Stopped",
    });
    let changeVersion = true;
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const response = await provider.fetch(input, init);
      if (changeVersion) {
        changeVersion = false;
        store.put("sandbox", entry.sandboxId, {
          ...entry,
          updatedAt: entry.updatedAt + 1,
        });
      }
      return response;
    }) as unknown as typeof fetch;
    const supervisor = new LeaseSupervisor(config, {
      now: () => 1000,
      parentAlive: () => false,
      fetch: fetcher,
    });
    try {
      await supervisor.tick();
      expect(
        provider.actions.filter((action) => action.method !== "GET"),
      ).toEqual([]);
      await supervisor.tick();
      expect(provider.states.get("unknown-native")?.state).toBe("Stopped");
      expect(provider.states.has("snapshot-native")).toBe(true);
      expect(
        provider.actions.some((action) => action.id === "snapshot-native"),
      ).toBe(false);
    } finally {
      supervisor.close();
    }
  });

  test("SIGKILL between provider acceptance and create response cannot orphan an unrecorded native ID", async () => {
    const { store, config, directory } = await fixture();
    const entry = record({
      sandboxId: "sbx-accepted-create",
      instanceId: undefined,
      status: "creating",
      deadline: Date.now() + 500,
      persistent: false,
    });
    store.put("sandbox", entry.sandboxId, entry);
    const accepted = deferred<void>(),
      respond = deferred<void>(),
      deleted = deferred<void>();
    let nativeExists = false;
    const nativeId = "native-accepted-create";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/instances" && request.method === "POST") {
          nativeExists = true;
          accepted.resolve();
          await respond.promise;
          return Response.json({
            id: nativeId,
            name: entry.sandboxId,
            state: "Running",
          });
        }
        if (
          !nativeExists ||
          ![`/instances/${entry.sandboxId}`, `/instances/${nativeId}`].includes(
            path,
          )
        )
          return new Response(null, { status: 404 });
        if (request.method === "DELETE") {
          expect(path).toBe(`/instances/${nativeId}`);
          nativeExists = false;
          deleted.resolve();
          return new Response(null, { status: 204 });
        }
        return Response.json({
          id: nativeId,
          name: entry.sandboxId,
          state: "Running",
        });
      },
    });
    const source = `import {spawnLeaseSupervisor,withLeaseGuard} from ${JSON.stringify(import.meta.resolve("../src/server/leases.ts"))}; const c=JSON.parse(await Bun.stdin.text());const worker=await spawnLeaseSupervisor(c.config,{executable:process.execPath});process.stdout.write(JSON.stringify({pid:worker.pid})+"\\n");await withLeaseGuard(c.directory,c.sandboxId,async()=>{await fetch(c.config.baseUrl+"/instances",{method:"POST"});process.stdout.write("response-received");});await Bun.sleep(60000);`;
    const parent = Bun.spawn([process.execPath, "-e", source], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    parent.stdin.write(
      JSON.stringify({
        config: { ...config, baseUrl: server.url.toString() },
        directory,
        sandboxId: entry.sandboxId,
      }),
    );
    await parent.stdin.end();
    let workerPid: number | undefined;
    try {
      const reader = parent.stdout.getReader();
      workerPid = JSON.parse(
        new TextDecoder().decode((await reader.read()).value),
      ).pid;
      reader.releaseLock();
      await accepted.promise;
      parent.kill("SIGKILL");
      await parent.exited;
      respond.resolve();
      await Promise.race([
        deleted.promise,
        Bun.sleep(2500).then(() => {
          throw Error("Uncertain create escaped lease enforcement");
        }),
      ]);
      expect(nativeExists).toBe(false);
      expect(store.get<SandboxRecord>("sandbox", entry.sandboxId)).toEqual(
        entry,
      );
      expect(
        store.get<SandboxRecord>("sandbox", entry.sandboxId)?.instanceId,
      ).toBeUndefined();
    } finally {
      respond.resolve();
      parent.kill("SIGKILL");
      await parent.exited;
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      }
      await server.stop(true);
    }
  }, 5000);
});
