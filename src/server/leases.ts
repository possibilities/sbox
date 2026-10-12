import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface LeaseSupervisorConfig {
  dbPath: string;
  dataDir: string;
  baseUrl: string;
  apiKey?: string;
  parentPid: number;
  /** An ownership marker, removed when the server shuts down gracefully. */
  ownerFile?: string;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

interface LeaseRecord {
  sandboxId: string;
  instanceId?: string;
  updatedAt?: number;
  sessionId?: string;
  status: string;
  persistent: boolean;
  deadline?: number;
}

export interface LeaseTickResult {
  parentAlive: boolean;
  pending: number;
  completed: number;
}

export interface LeaseSupervisorDependencies {
  now?: () => number;
  parentAlive?: (pid: number) => boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function leaseSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A separate SQLite file is only an OS-managed advisory mutex. It contains no
 * sandbox state. Its transaction releases on process death, unlike PID files.
 * All deadline/resume mutations must use this same guard as the observer.
 */
export async function withLeaseGuard<T>(
  dataDir: string,
  sandboxId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const directory = join(resolve(dataDir), "lease-locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${createHash("sha256").update(sandboxId).digest("hex")}.sqlite`,
  );
  const lock = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  lock.exec("PRAGMA busy_timeout = 0");
  let acquired = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        lock.exec("BEGIN IMMEDIATE");
        acquired = true;
        break;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (
          !code.startsWith("SQLITE_BUSY") &&
          !code.startsWith("SQLITE_LOCKED")
        )
          throw error;
        await leaseSleep(20, signal);
      }
    }
    signal?.throwIfAborted();
    return await work();
  } finally {
    try {
      if (acquired) lock.exec("ROLLBACK");
    } finally {
      lock.close();
    }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function leaseKey(record: LeaseRecord): string {
  return JSON.stringify([
    record.sandboxId,
    record.instanceId,
    record.sessionId ?? null,
    record.deadline ?? null,
    record.persistent,
    record.status,
    record.updatedAt ?? null,
  ]);
}

function parseLease(id: string, json: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(json) as Partial<LeaseRecord>;
    if (
      value.sandboxId !== id ||
      !/^sbx-[A-Za-z0-9][A-Za-z0-9_-]{0,250}$/.test(id) ||
      (value.instanceId !== undefined &&
        (typeof value.instanceId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(value.instanceId))) ||
      (value.instanceId === undefined &&
        !["creating", "failed"].includes(value.status ?? "")) ||
      typeof value.persistent !== "boolean" ||
      typeof value.status !== "string"
    )
      return undefined;
    if (
      value.updatedAt !== undefined &&
      (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)
    )
      return undefined;
    if (value.sessionId !== undefined && typeof value.sessionId !== "string")
      return undefined;
    if (
      value.deadline !== undefined &&
      (!Number.isSafeInteger(value.deadline) || value.deadline <= 0)
    )
      return undefined;
    return value as LeaseRecord;
  } catch {
    return undefined;
  }
}

function trackedLease(record: LeaseRecord, parentAlive: boolean): boolean {
  if (["running", "creating", "failed"].includes(record.status))
    return record.deadline !== undefined;
  if (record.status === "stopping")
    return record.deadline !== undefined || !parentAlive;
  // An ephemeral instance may be deliberately retained while its snapshot is captured.
  return false;
}

function dueLease(
  record: LeaseRecord,
  parentAlive: boolean,
  now: number,
): boolean {
  return (
    (!parentAlive && record.status === "stopping") ||
    (record.deadline !== undefined && record.deadline <= now)
  );
}

/** Reads the control-plane database without ever mutating it. */
export class LeaseSupervisor {
  private readonly db: Database;
  private readonly completed = new Set<string>();
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(
    readonly config: LeaseSupervisorConfig,
    private readonly dependencies: LeaseSupervisorDependencies = {},
  ) {
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid supervisor connection configuration");
    if (
      !Number.isSafeInteger(config.parentPid) ||
      config.parentPid <= 0 ||
      config.dbPath === ":memory:"
    )
      throw new Error("Invalid supervisor state configuration");
    for (const value of [
      config.intervalMs ?? 1000,
      config.requestTimeoutMs ?? 10000,
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > 60000)
        throw new Error("Invalid supervisor timing configuration");
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.now = dependencies.now ?? Date.now;
    this.alive = dependencies.parentAlive ?? processAlive;
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
    this.db = new Database(config.dbPath, { readonly: true, strict: true });
    this.db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 0");
  }

  private parentIsAlive(): boolean {
    return (
      this.alive(this.config.parentPid) &&
      (!this.config.ownerFile || existsSync(this.config.ownerFile))
    );
  }

  private records(): LeaseRecord[] {
    const rows = this.db
      .query("SELECT id,value FROM records WHERE kind='sandbox'")
      .all() as Array<{ id: string; value: string }>;
    return rows.flatMap((row) => {
      const record = parseLease(row.id, row.value);
      return record ? [record] : [];
    });
  }

  private current(sandboxId: string): LeaseRecord | undefined {
    const row = this.db
      .query("SELECT value FROM records WHERE kind='sandbox' AND id=?")
      .get(sandboxId) as { value: string } | null;
    return row ? parseLease(sandboxId, row.value) : undefined;
  }

  private async request(
    method: string,
    instanceId: string,
    suffix = "",
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 10000);
    const signal = this.dependencies.signal
      ? AbortSignal.any([timeout, this.dependencies.signal])
      : timeout;
    const headers = new Headers({ accept: "application/json" });
    if (this.config.apiKey)
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    return this.fetcher(
      `${this.baseUrl}/instances/${encodeURIComponent(instanceId)}${suffix}`,
      { method, headers, signal, redirect: "error" },
    );
  }

  private async enforce(candidate: LeaseRecord): Promise<void> {
    await withLeaseGuard(
      this.config.dataDir,
      candidate.sandboxId,
      async () => {
        // An extension, resume, or replacement that won the guard invalidates this observation.
        const current = this.current(candidate.sandboxId);
        const parentAlive = this.parentIsAlive();
        if (
          !current ||
          leaseKey(current) !== leaseKey(candidate) ||
          !trackedLease(current, parentAlive) ||
          !dueLease(current, parentAlive, this.now())
        )
          return;
        const inspected = await this.request(
          "GET",
          current.instanceId ?? current.sandboxId,
        );
        if (inspected.status === 404) {
          await inspected.body?.cancel();
          // An uncertain create may still be accepted but not yet visible by name.
          // Keep watching until it appears or the control plane reconciles the record.
          if (current.instanceId) this.completed.add(leaseKey(current));
          return;
        }
        if (!inspected.ok) {
          await inspected.body?.cancel();
          return;
        }
        const native = (await inspected.json()) as {
          id?: unknown;
          name?: unknown;
          state?: unknown;
        };
        // A provider name lookup or corrupt record must not redirect cleanup to another instance.
        if (
          typeof native.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(native.id) ||
          (current.instanceId !== undefined &&
            native.id !== current.instanceId) ||
          native.name !== current.sandboxId
        )
          return;
        const instanceId = native.id;
        // The provider lookup is asynchronous; do not act on a replaced or extended record.
        const checked = this.current(current.sandboxId);
        const parentStillAlive = this.parentIsAlive();
        if (
          !checked ||
          leaseKey(checked) !== leaseKey(current) ||
          !trackedLease(checked, parentStillAlive) ||
          !dueLease(checked, parentStillAlive, this.now())
        )
          return;
        const state =
          typeof native.state === "string" ? native.state.toLowerCase() : "";
        // Hypeman's Shutdown state still retains its hypervisor process/resources.
        if (current.persistent && state === "stopped") {
          this.completed.add(leaseKey(current));
          return;
        }
        if (current.persistent && state === "stopping") return;
        const response = await this.request(
          current.persistent ? "POST" : "DELETE",
          instanceId,
          current.persistent ? "/stop" : "",
        );
        const accepted = response.ok || response.status === 404;
        await response.body?.cancel();
        if (!accepted) return;
        if (!current.persistent || response.status === 404) {
          this.completed.add(leaseKey(current));
          return;
        }
        // Never treat an accepted asynchronous stop as proof the VM has stopped.
        const verified = await this.request("GET", instanceId);
        if (verified.status === 404) {
          await verified.body?.cancel();
          this.completed.add(leaseKey(current));
          return;
        }
        if (!verified.ok) {
          await verified.body?.cancel();
          return;
        }
        const result = (await verified.json()) as {
          id?: unknown;
          state?: unknown;
        };
        if (
          result.id === instanceId &&
          typeof result.state === "string" &&
          result.state.toLowerCase() === "stopped"
        )
          this.completed.add(leaseKey(current));
      },
      this.dependencies.signal,
    );
  }

  async tick(): Promise<LeaseTickResult> {
    this.dependencies.signal?.throwIfAborted();
    const parentAlive = this.parentIsAlive();
    const records = this.records();
    const keys = new Set(records.map(leaseKey));
    for (const key of this.completed)
      if (!keys.has(key)) this.completed.delete(key);
    const due = records.filter(
      (record) =>
        trackedLease(record, parentAlive) &&
        dueLease(record, parentAlive, this.now()) &&
        !this.completed.has(leaseKey(record)),
    );
    // One unavailable instance should not delay every other expired lease.
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, due.length) }, async () => {
        while (index < due.length) {
          const record = due[index++]!;
          try {
            await this.enforce(record);
          } catch {
            this.dependencies.signal?.throwIfAborted(); /* Retry uncertain or transient outcomes on the next observation. */
          }
        }
      }),
    );
    const parentStillAlive = this.parentIsAlive();
    const pending = this.records().filter(
      (record) =>
        trackedLease(record, parentStillAlive) &&
        !this.completed.has(leaseKey(record)),
    ).length;
    return {
      parentAlive: parentStillAlive,
      pending,
      completed: this.completed.size,
    };
  }

  close(): void {
    this.db.close();
  }
}

export async function runLeaseSupervisor(
  config: LeaseSupervisorConfig,
  dependencies: LeaseSupervisorDependencies = {},
  ready?: () => void,
): Promise<void> {
  const supervisor = new LeaseSupervisor(config, dependencies);
  try {
    ready?.();
    for (;;) {
      try {
        const result = await supervisor.tick();
        if (!result.parentAlive && result.pending === 0) return;
      } catch {
        dependencies.signal?.throwIfAborted();
      }
      await leaseSleep(config.intervalMs ?? 1000, dependencies.signal);
    }
  } finally {
    supervisor.close();
  }
}

/** Entry point for the compiled CLI's internal worker mode as well as Bun -e. */
export async function runLeaseSupervisorFromStdin(): Promise<void> {
  const input = await Bun.stdin.text();
  if (input.length > 1024 * 1024)
    throw new Error("Invalid supervisor configuration");
  const config = JSON.parse(input) as LeaseSupervisorConfig;
  process.stdout.on("error", () => {});
  await runLeaseSupervisor(config, {}, () => {
    process.stdout.write("ready\n");
  });
}

/** Standalone worker source has no dependency on the repository at execution time. */
export const LEASE_WORKER_SOURCE = [
  'import { Database } from "bun:sqlite";',
  'import { createHash } from "node:crypto";',
  'import { chmodSync, existsSync, mkdirSync } from "node:fs";',
  'import { join, resolve } from "node:path";',
  leaseSleep.toString(),
  withLeaseGuard.toString(),
  processAlive.toString(),
  leaseKey.toString(),
  parseLease.toString(),
  trackedLease.toString(),
  dueLease.toString(),
  LeaseSupervisor.toString(),
  runLeaseSupervisor.toString(),
  runLeaseSupervisorFromStdin.toString(),
  "runLeaseSupervisorFromStdin().catch(() => { process.exitCode = 1; });",
].join("\n");

export interface LeaseSupervisorHandle {
  pid: number;
  /** Relinquishes the parent role; outstanding leases remain protected. */
  release(): void;
}

export async function spawnLeaseSupervisor(
  config: Omit<LeaseSupervisorConfig, "parentPid" | "ownerFile">,
  options: {
    executable?: string;
    workerArgs?: string[];
    startupTimeoutMs?: number;
  } = {},
): Promise<LeaseSupervisorHandle> {
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ownerFile = join(dataDir, `.lease-owner-${randomUUID()}`);
  writeFileSync(ownerFile, String(process.pid), { mode: 0o600, flag: "wx" });
  const executable = options.executable ?? Bun.which("bun");
  if (!executable) {
    unlinkSync(ownerFile);
    throw new Error("Bun is required for the lease supervisor");
  }
  let child: ChildProcess | undefined;
  const release = () => {
    try {
      unlinkSync(ownerFile);
    } catch {}
  };
  try {
    child = spawn(
      executable,
      options.workerArgs ?? ["-e", LEASE_WORKER_SOURCE],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
    await new Promise<void>((resolveReady, reject) => {
      let output = "";
      const timer = setTimeout(
        () => failed(),
        options.startupTimeoutMs ?? 10000,
      );
      const clean = () => {
        clearTimeout(timer);
        child!.off("error", failed);
        child!.off("exit", failed);
        child!.stdout!.off("data", data);
      };
      const failed = () => {
        clean();
        reject(new Error("Lease supervisor failed to start"));
      };
      const data = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 1024) {
          failed();
          return;
        }
        if (output.includes("ready\n")) {
          clean();
          resolveReady();
        }
      };
      child!.on("error", failed);
      child!.on("exit", failed);
      child!.stdout!.on("data", data);
      child!.stdin!.on("error", failed);
      child!.stdin!.end(
        JSON.stringify({
          ...config,
          dataDir,
          dbPath: resolve(config.dbPath),
          parentPid: process.pid,
          ownerFile,
        }),
      );
    });
    child.stdout?.destroy();
    child.unref();
    return { pid: child.pid!, release };
  } catch (error) {
    release();
    child?.kill("SIGKILL");
    child?.stdout?.destroy();
    child?.stdin?.destroy();
    throw error;
  }
}
