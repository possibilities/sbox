/** TEST ONLY. Production has no local-process fallback. All paths belong to this fixture. */
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Backend,
  BackendCreate,
  BackendExec,
  Execution,
  Instance,
} from "../src/backend.ts";
import type { Capabilities } from "../src/types.ts";
import { SboxError } from "../src/errors.ts";

export class TestBackend implements Backend {
  readonly instances = new Map<
    string,
    { options: BackendCreate; dir: string; state: string }
  >();
  readonly snapshots = new Map<string, string>();
  readonly snapshotOrigins = new Map<
    string,
    { sourceId: string; name?: string }
  >();
  readonly volumes = new Set<string>();
  readonly volumeClones: Array<{
    sourceId: string;
    name: string;
    sizeBytes: number;
  }> = [];
  readonly executions = new Map<string, Set<Execution>>();
  readonly deadlines = new Map<string, number>();
  createCalls = 0;
  restoreCalls = 0;
  deleteCalls = 0;
  root = "";
  async initialize() {
    this.root = await mkdtemp(join(tmpdir(), "sbox-test-"));
    return this;
  }
  async dispose() {
    for (const set of this.executions.values())
      for (const e of set) await e.kill("SIGKILL").catch(() => {});
    await rm(this.root, { recursive: true, force: true });
  }
  async capabilities(): Promise<Capabilities> {
    return {
      backend: "test",
      snapshots: true,
      volumes: true,
      terminal: true,
      networkPolicies: ["allow-all", "deny-all"],
      liveNetworkPolicy: false,
      credentialBrokering: false,
    };
  }
  async create(options: BackendCreate): Promise<Instance> {
    this.createCalls++;
    const id = crypto.randomUUID(),
      dir = join(this.root, id);
    await mkdir(dir);
    this.instances.set(id, { options, dir, state: "Running" });
    return { id, state: "Running" };
  }
  async get(id: string): Promise<Instance> {
    const entry = this.instances.get(id);
    if (!entry)
      throw new SboxError("NOT_FOUND", "Test instance not found", 404);
    return { id, state: entry.state };
  }
  async start(id: string) {
    this.instances.get(id)!.state = "Running";
    return this.get(id);
  }
  async stop(id: string) {
    this.instances.get(id)!.state = "Stopped";
    for (const e of this.executions.get(id) ?? [])
      await e.kill("SIGKILL").catch(() => {});
  }
  async delete(id: string) {
    this.deleteCalls++;
    await this.stop(id);
    await rm(this.instances.get(id)!.dir, { recursive: true, force: true });
    this.instances.delete(id);
  }
  async setDeadline(id: string, deadline: number) {
    this.deadlines.set(id, deadline);
  }
  async exec(id: string, options: BackendExec): Promise<Execution> {
    const entry = this.instances.get(id);
    if (!entry || entry.state !== "Running")
      throw Error("Test instance not running");
    const cwd = options.cwd === "/vercel/sandbox" ? entry.dir : options.cwd;
    const child = Bun.spawn(
      [options.cmd === "bun" ? process.execPath : options.cmd, ...options.args],
      {
        cwd,
        env: { ...process.env, ...options.env },
        stdin: options.stdin ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let finish!: () => void;
    let wake: (() => void) | undefined;
    let done = false;
    const queue: Array<{ stream: "stdout" | "stderr"; data: Uint8Array }> = [];
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = async (
      stream: ReadableStream<Uint8Array>,
      name: "stdout" | "stderr",
    ) => {
      const reader = stream.getReader();
      for (;;) {
        const { done, value: data } = await reader.read();
        if (done) break;
        queue.push({ stream: name, data });
        wake?.();
        wake = undefined;
      }
    };
    void Promise.all([
      read(child.stdout, "stdout"),
      read(child.stderr, "stderr"),
    ]).then(() => {
      done = true;
      wake?.();
      finish();
    });
    const fsInput: Buffer[] = [];
    const isUpload = options.args.some((x) => x.includes("SBOX_BINARY_UPLOAD"));
    let uploadHeader = isUpload;
    const isFs =
      !isUpload &&
      options.args.some((x) => x.includes("const request = JSON.parse"));
    const result: Execution = {
      output: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length) yield queue.shift()!;
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      },
      exited: child.exited.then(async (exitCode) => {
        await completed;
        return { exitCode };
      }),
      async write(data) {
        if (uploadHeader) {
          const header = JSON.parse(Buffer.from(data).toString());
          header.path = header.path.replaceAll("/vercel/sandbox", entry.dir);
          data = Buffer.from(JSON.stringify(header) + "\n");
          uploadHeader = false;
        }
        if (isFs) {
          fsInput.push(Buffer.from(data));
          return;
        }
        if (typeof child.stdin === "object" && child.stdin) {
          child.stdin.write(data);
          await child.stdin.flush();
        }
      },
      async closeStdin() {
        if (typeof child.stdin === "object" && child.stdin) {
          if (isFs) {
            const payload = Buffer.concat(fsInput)
              .toString()
              .replaceAll("/vercel/sandbox", entry.dir);
            child.stdin.write(payload);
            await child.stdin.flush();
          }
          await child.stdin.end();
        }
      },
      async kill(signal = "SIGTERM") {
        child.kill(signal as NodeJS.Signals);
      },
      async resize() {},
    };
    const set = this.executions.get(id) ?? new Set();
    set.add(result);
    this.executions.set(id, set);
    void result.exited.finally(() => set.delete(result));
    return result;
  }
  async snapshot(id: string, name?: string) {
    const snapshotId = crypto.randomUUID(),
      dir = join(this.root, `snapshot-${snapshotId}`);
    await cp(this.instances.get(id)!.dir, dir, { recursive: true });
    this.snapshots.set(snapshotId, dir);
    this.snapshotOrigins.set(snapshotId, { sourceId: id, name });
    return { id: snapshotId };
  }
  async findSnapshot(sourceId: string, name: string) {
    const existing = [...this.snapshotOrigins].find(
      ([, origin]) => origin.sourceId === sourceId && origin.name === name,
    );
    return existing ? { id: existing[0] } : null;
  }
  async restore(snapshotId: string, options: BackendCreate) {
    this.restoreCalls++;
    const instance = await this.create(options);
    await cp(
      this.snapshots.get(snapshotId)!,
      this.instances.get(instance.id)!.dir,
      { recursive: true },
    );
    return instance;
  }
  async deleteSnapshot(id: string) {
    await rm(this.snapshots.get(id)!, { recursive: true, force: true });
    this.snapshots.delete(id);
    this.snapshotOrigins.delete(id);
  }
  async createVolume() {
    const id = crypto.randomUUID();
    this.volumes.add(id);
    return { id };
  }
  async deleteVolume(id: string) {
    this.volumes.delete(id);
  }
  async cloneVolume(sourceId: string, name: string, sizeBytes: number) {
    if (!this.volumes.has(sourceId))
      throw new SboxError("NOT_FOUND", "Test source volume not found", 404);
    this.volumeClones.push({ sourceId, name, sizeBytes });
    this.volumes.add(name);
    return { id: name };
  }
}
