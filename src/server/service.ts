import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import type {
  Backend,
  BackendCreate,
  BackendExec,
  Execution,
} from "../backend.ts";
import { SboxError, errorMessage, invariant } from "../errors.ts";
import type {
  CommandRecord,
  CreateOptions,
  DriveRecord,
  ExecOptions,
  ListOptions,
  LogRecord,
  Page,
  SandboxRecord,
  SessionRecord,
  SnapshotRecord,
} from "../types.ts";
import { Locks, Store } from "./store.ts";
import * as v from "./validation.ts";
import { FS_GUEST_SCRIPT } from "../sdk/fs-guest.ts";
import {
  READ_FILE_SCRIPT,
  WRITE_FILE_SCRIPT,
  fileResponse,
} from "./file-stream.ts";
import {
  MediatedNetwork,
  redactPolicy,
  CompiledPolicy,
  type NetworkConfiguration,
  type NetworkSession,
} from "../network/index.ts";
import {
  credentialEnvironment,
  normalizeCredentials,
  nativeCredentialSecrets,
} from "../hypeman/credentials.ts";
import { withLeaseGuard } from "./leases.ts";

const id = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;
const WORKDIR = "/vercel/sandbox";
const MAX_OUTPUT = 16 * 1024 * 1024;
const BASE_ENV = { LANG: "C.UTF-8", TERM: "xterm-256color" };
export interface ServiceOptions {
  defaultImage?: string;
  previewUrl?: (sandboxId: string, port: number) => string;
  maxSandboxes?: number;
  maxCommands?: number;
  maxOutputBytes?: number;
  leaseDataDir?: string;
  network?: MediatedNetwork;
}
interface ActiveCommand {
  execution: Execution;
  done: Promise<void>;
  bytes: number;
  retained: Array<{ sequence: number; bytes: number }>;
  retainedBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface LogSubscriber {
  queue: LogRecord[];
  bytes: number;
  error?: SboxError;
}
interface SnapshotDeletion {
  snapshotId: string;
  requestedAt: number;
}

export class SandboxService {
  readonly locks = new Locks();
  readonly active = new Map<string, ActiveCommand>();
  private listeners = new Map<string, Set<() => void>>();
  private logSubscribers = new Map<string, Set<LogSubscriber>>();
  private driveReservations = new Map<string, string>();
  private snapshotReservations = new Map<string, number>();
  private networks = new Map<string, NetworkSession>();
  private networkPending = new Map<string, Promise<NetworkSession>>();
  private reaping = false;
  private executionCount = 0;
  private executions = new Set<Execution>();
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly backend: Backend,
    readonly store: Store,
    readonly options: ServiceOptions = {},
  ) {}
  private leaseGuard<T>(sandboxId: string, work: () => Promise<T>): Promise<T> {
    return this.options.leaseDataDir
      ? withLeaseGuard(this.options.leaseDataDir, sandboxId, work)
      : work();
  }
  private hasVolumeOverlays(s: SandboxRecord): boolean {
    return Object.values(s.sessionConfig?.mounts ?? s.mounts).some(
      (mount) => mount.overlay === true,
    );
  }
  private async automaticSnapshotSupported(s: SandboxRecord): Promise<boolean> {
    if (this.hasVolumeOverlays(s)) return false;
    const capabilities = await this.backend.capabilities();
    return (
      capabilities.snapshots &&
      (!Object.keys(s.sessionConfig?.mounts ?? s.mounts).length ||
        capabilities.rootfsTransplant === true)
    );
  }

  async capabilities() {
    const native = await this.backend.capabilities();
    return this.options.network
      ? {
          ...native,
          liveNetworkPolicy: true,
          credentialBrokering: true,
          networkPolicyRules: [
            "domains",
            "subnets",
            "http-match",
            "transform",
            "response",
            "forwardURL",
          ],
          networkIsolation: "no-native-interface",
          networkTransport: "tun-socks-tcp-udp-dns-over-exec",
          credentialBrokeringDetails: {
            protocol: "https-header-injection",
            rotation: true,
            hostEnforcement: "nic-less",
            destinationFirewall: true,
          },
        }
      : native;
  }
  private networkConfiguration(s: SandboxRecord): NetworkConfiguration {
    return {
      sandboxId: s.sandboxId,
      sandboxName: s.name,
      policy:
        this.store.get<NetworkConfiguration["policy"]>(
          "network-policy",
          s.sandboxId,
        ) ?? s.networkPolicy,
      credentials: s.credentials,
      credentialSecrets: this.store.get<Record<string, string>>(
        "credentials",
        s.sandboxId,
      ),
    };
  }
  private async attachNetwork(
    s: SandboxRecord,
  ): Promise<NetworkSession | undefined> {
    if (!this.options.network || !s.instanceId) return;
    const instanceId = s.instanceId;
    const existing = this.networks.get(instanceId);
    if (existing) return existing;
    const pending = this.networkPending.get(instanceId);
    if (pending) return pending;
    const attaching = this.options.network
      .attach(this.backend, instanceId, this.networkConfiguration(s))
      .then((session) => {
        this.networks.set(instanceId, session);
        void session.closed.then(() => {
          if (this.networks.get(instanceId) === session)
            this.networks.delete(instanceId);
        });
        return session;
      })
      .finally(() => this.networkPending.delete(instanceId));
    this.networkPending.set(instanceId, attaching);
    return attaching;
  }
  private async detachNetwork(instanceId?: string) {
    if (!instanceId) return;
    const session = this.networks.get(instanceId);
    this.networks.delete(instanceId);
    await session?.close();
  }
  async initialize(): Promise<void> {
    // A broken exec transport cannot be safely replayed: mark it interrupted, never run it twice.
    for (const c of this.store.all<CommandRecord>("command"))
      if (c.status === "running") {
        c.status = "failed";
        c.finishedAt = Date.now();
        c.error = {
          code: "SERVER_RESTARTED",
          message: "Control plane restarted while this command was running",
        };
        this.saveCommand(c);
      }
    for (const existing of this.store.all<SandboxRecord>("sandbox")) {
      await this.leaseGuard(existing.sandboxId, async () => {
        const s = this.get(existing.sandboxId);
        if (s.status === "creating") {
          s.status = "failed";
          s.error =
            "Creation was interrupted; delete this sandbox before retrying its name";
          this.save(s);
        }
        if (s.status === "failed" && !s.instanceId) {
          try {
            s.instanceId = (await this.backend.get(s.sandboxId)).id;
            this.save(s);
          } catch {
            /* The unique provider name is retained for recovery after uncertain creation. */
          }
        }
        if (!s.instanceId || !["running", "stopping"].includes(s.status))
          return;
        try {
          const instance = await this.backend.get(s.instanceId);
          if (["stopped", "shutdown"].includes(instance.state.toLowerCase())) {
            if (instance.state.toLowerCase() === "shutdown")
              await this.backend.stop(s.instanceId);
            if (!s.persistent) {
              await this.detachNetwork(s.instanceId);
              await this.backend.delete(s.instanceId);
              s.instanceId = undefined;
            }
            this.markStopped(s);
            if (
              s.persistent &&
              s.instanceId &&
              (await this.automaticSnapshotSupported(s))
            ) {
              s.snapshotPending = true;
              this.save(s);
            }
          }
        } catch (e) {
          // An unreachable host is not evidence of deletion. Keep the ID for recovery/cleanup.
          s.error = `Reconciliation pending: ${errorMessage(e)}`;
          this.save(s);
        }
      });
    }
    for (const snap of this.store.all<SnapshotRecord>("snapshot"))
      if (snap.status && snap.status !== "ready" && snap.sourceInstanceId) {
        try {
          const native = await this.backend.findSnapshot?.(
            snap.sourceInstanceId,
            snap.snapshotId,
          );
          if (native) {
            snap.nativeId = native.id;
            snap.sizeBytes = native.sizeBytes;
            snap.status = "ready";
            snap.error = undefined;
            this.store.put("snapshot", snap.snapshotId, snap);
          }
        } catch {}
      }
    await this.reap();
    await this.cleanupDriveGenerations();
    this.timer = setInterval(() => {
      void this.reap();
    }, 1000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(
      [...this.networks.values()].map((session) => session.close()),
    );
    this.networks.clear();
    await Promise.allSettled(
      [...this.executions].map((execution) => execution.kill("SIGKILL")),
    );
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
  async execute(instanceId: string, options: BackendExec): Promise<Execution> {
    invariant(
      !this.closed,
      "SERVER_CLOSING",
      "The control plane is shutting down",
      503,
    );
    invariant(
      this.executionCount < (this.options.maxCommands ?? 256),
      "CAPACITY_EXCEEDED",
      "Execution concurrency limit reached",
      429,
    );
    this.executionCount++;
    try {
      const sandbox = this.options.network
        ? this.store
            .all<SandboxRecord>("sandbox")
            .find((s) => s.instanceId === instanceId)
        : undefined;
      const network = sandbox ? await this.attachNetwork(sandbox) : undefined;
      const execution = await this.backend.exec(
        instanceId,
        network
          ? { ...options, env: network.environment(options.env) }
          : options,
      );
      if (this.closed) {
        void execution.exited.catch(() => {});
        await execution.kill("SIGKILL").catch(() => {});
        throw new SboxError(
          "SERVER_CLOSING",
          "The control plane is shutting down",
          503,
        );
      }
      this.executions.add(execution);
      void execution.exited
        .finally(() => {
          this.executionCount--;
          this.executions.delete(execution);
        })
        .catch(() => {});
      return execution;
    } catch (error) {
      this.executionCount--;
      throw error;
    }
  }
  private save(s: SandboxRecord): SandboxRecord {
    s.updatedAt = Date.now();
    this.store.put("sandbox", s.sandboxId, s, s.name);
    return s;
  }
  private saveCommand(c: CommandRecord): void {
    this.store.put("command", c.commandId, c);
    this.notify(c.commandId);
  }
  get(ref: string): SandboxRecord {
    v.string(ref, "sandbox id");
    const s = this.store.get<SandboxRecord>("sandbox", ref);
    invariant(s, "NOT_FOUND", `Sandbox ${ref} not found`, 404);
    if (this.options.previewUrl) {
      s.routes = s.ports.map((port) => ({
        port,
        url: this.options.previewUrl!(s.sandboxId, port),
      }));
    }
    return s;
  }
  command(ref: string): CommandRecord {
    v.string(ref, "command id");
    const c = this.store.get<CommandRecord>("command", ref);
    invariant(c, "NOT_FOUND", `Command ${ref} not found`, 404);
    return c;
  }
  snapshot(ref: string): SnapshotRecord {
    v.string(ref, "snapshot id");
    const s = this.store.get<SnapshotRecord>("snapshot", ref);
    invariant(s, "NOT_FOUND", `Snapshot ${ref} not found`, 404);
    return s;
  }
  private async withSnapshotReservation<T>(
    ref: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (ref === undefined) return work();
    const snapshot = this.snapshot(ref);
    invariant(
      !this.store.get("snapshot-deletion", snapshot.snapshotId),
      "SNAPSHOT_DELETING",
      "Snapshot deletion has started; its filesystem cannot be used for a new sandbox or rollback",
      409,
    );
    const snapshotId = snapshot.snapshotId;
    // Reserve synchronously, before a caller can yield to catalog locks, native
    // capabilities, mount allocation, or restoration.
    this.snapshotReservations.set(
      snapshotId,
      (this.snapshotReservations.get(snapshotId) ?? 0) + 1,
    );
    try {
      return await work();
    } finally {
      const remaining = this.snapshotReservations.get(snapshotId)! - 1;
      if (remaining) this.snapshotReservations.set(snapshotId, remaining);
      else this.snapshotReservations.delete(snapshotId);
    }
  }
  private snapshotReferenced(snapshotId: string): boolean {
    return (
      this.snapshotReservations.has(snapshotId) ||
      this.store
        .all<SandboxRecord>("sandbox")
        .some(
          (sandbox) =>
            sandbox.pendingSnapshotId === snapshotId ||
            (sandbox.snapshotId === snapshotId &&
              (sandbox.persistent ||
                ["creating", "failed"].includes(sandbox.status))),
        )
    );
  }
  drive(ref: string): DriveRecord {
    v.string(ref, "drive id");
    const d = this.store.get<DriveRecord>("drive", ref);
    invariant(d, "NOT_FOUND", `Drive ${ref} not found`, 404);
    return d;
  }
  page<
    T extends {
      createdAt?: number;
      startedAt?: number;
      name?: string;
      updatedAt?: number;
      statusUpdatedAt?: number;
      tags?: Record<string, string>;
    },
  >(items: T[], opts: ListOptions = {}): Page<T> {
    v.list(opts);
    const filtered = items
      .filter(
        (x) =>
          (!opts.namePrefix || x.name?.startsWith(opts.namePrefix)) &&
          (!opts.name || x.name === opts.name) &&
          (!opts.tags ||
            Object.entries(opts.tags).every(([k, val]) => x.tags?.[k] === val)),
      )
      .sort((a, b) => {
        const key = opts.sortBy ?? "createdAt";
        const av =
          key === "createdAt"
            ? (a.createdAt ?? a.startedAt ?? 0)
            : (a[key] ?? 0);
        const bv =
          key === "createdAt"
            ? (b.createdAt ?? b.startedAt ?? 0)
            : (b[key] ?? 0);
        const compared =
          typeof av === "string" && typeof bv === "string"
            ? av.localeCompare(bv)
            : Number(av) - Number(bv);
        return (
          (compared || JSON.stringify(a).localeCompare(JSON.stringify(b))) *
          (opts.sortOrder === "asc" ? 1 : -1)
        );
      });
    let offset = 0;
    if (opts.cursor) {
      try {
        offset = Number(Buffer.from(opts.cursor, "base64url").toString());
      } catch {}
      invariant(
        Number.isSafeInteger(offset) && offset >= 0,
        "INVALID_CURSOR",
        "Invalid pagination cursor",
      );
    }
    const limit = opts.limit ?? 100;
    return {
      items: filtered.slice(offset, offset + limit),
      nextCursor:
        offset + limit < filtered.length
          ? Buffer.from(String(offset + limit)).toString("base64url")
          : null,
    };
  }
  list(opts: ListOptions = {}): Page<SandboxRecord> {
    return this.page(this.store.all<SandboxRecord>("sandbox"), opts);
  }
  private providerOptions(s: SandboxRecord): BackendCreate {
    const mounts = Object.entries(s.mounts).map(([path, m]) => ({
      volumeId: this.drive(m.driveId).nativeId,
      path,
      readOnly: m.readOnly ?? false,
      overlay: m.overlay,
      overlaySizeBytes: m.overlaySizeBytes,
    }));
    return {
      name: s.sandboxId,
      image: s.image,
      resources: s.resources,
      env: this.options.network
        ? credentialEnvironment(s.credentials ?? {}, { ...BASE_ENV, ...s.env })
        : { ...BASE_ENV, ...s.env },
      credentials: this.options.network ? undefined : s.credentials,
      credentialSecrets: this.options.network
        ? undefined
        : this.store.get<Record<string, string>>("credentials", s.sandboxId),
      networkPolicy: this.options.network ? "deny-all" : s.networkPolicy,
      mounts,
      deadline: s.deadline!,
    };
  }
  private async materializeMounts(s: SandboxRecord): Promise<void> {
    for (const [path, descriptor] of Object.entries(s.mounts)) {
      const source = this.drive(descriptor.driveId);
      if (descriptor.mode === "snapshot" && !source.immutable) {
        const generation = await this.cloneDriveUnlocked(
          source.driveId,
          undefined,
          true,
          s.sandboxId,
        );
        s.mounts[path] = {
          driveId: generation.driveId,
          mode: "snapshot",
          readOnly: true,
        };
      } else s.mounts[path] = { ...descriptor, driveId: source.driveId };
      this.save(s);
    }
  }
  private validateMounts(s: SandboxRecord, attachments = true): void {
    for (const m of Object.values(s.mounts)) {
      const drive = this.drive(m.driveId);
      invariant(
        !drive.immutable || m.readOnly,
        "IMMUTABLE_DRIVE",
        "A captured drive generation can only be mounted read-only",
        409,
      );
      invariant(
        !drive.status || drive.status === "ready",
        "DRIVE_NOT_READY",
        "Drive creation has not completed; inspect or delete it before reuse",
        409,
      );
      const conflicts = this.store
        .all<SandboxRecord>("sandbox")
        .filter(
          (other) =>
            other.sandboxId !== s.sandboxId &&
            attachments &&
            !(m.mode === "snapshot" && !drive.immutable) &&
            (other.instanceId || other.status === "creating") &&
            Object.values(
              other.status === "creating"
                ? other.mounts
                : (other.sessionConfig?.mounts ?? other.mounts),
            ).some(
              (om) => om.driveId === m.driveId && (!om.readOnly || !m.readOnly),
            ),
        );
      invariant(
        !conflicts.length,
        "DRIVE_IN_USE",
        "A drive writer requires exclusive attachment; delete the previous sandbox or use read-only mounts",
        409,
      );
    }
  }
  async create(
    opts: CreateOptions = {},
    getOrCreate = false,
  ): Promise<{ sandbox: SandboxRecord; created: boolean; resumed: boolean }> {
    v.create(opts);
    return this.withSnapshotReservation(
      opts.source?.type === "snapshot" ? opts.source.snapshotId : undefined,
      () =>
        this.locks.run("catalog", async () => {
          if (opts.name) {
            const existing = this.store.get<SandboxRecord>(
              "sandbox",
              opts.name,
            );
            if (existing) {
              invariant(
                getOrCreate,
                "ALREADY_EXISTS",
                `Sandbox ${opts.name} already exists`,
                409,
              );
              const resume =
                (opts as CreateOptions & { resume?: boolean }).resume &&
                existing.status === "stopped";
              return {
                sandbox: resume
                  ? await this.resume(existing.sandboxId)
                  : existing,
                created: false,
                resumed: !!resume,
              };
            }
          }
          const active = this.store
            .all<SandboxRecord>("sandbox")
            .filter(
              (s) =>
                ["creating", "running", "stopping"].includes(s.status) ||
                (s.status === "failed" && s.instanceId),
            );
          invariant(
            active.length < (this.options.maxSandboxes ?? 100),
            "CAPACITY_EXCEEDED",
            "Sandbox concurrency limit reached",
            429,
          );
          const sourceSnapshot =
            opts.source?.type === "snapshot"
              ? this.snapshot(opts.source.snapshotId)
              : undefined;
          if (sourceSnapshot)
            invariant(
              !sourceSnapshot.status || sourceSnapshot.status === "ready",
              "SNAPSHOT_NOT_READY",
              "Snapshot capture has not completed",
              409,
            );
          if (sourceSnapshot?.expiresAt)
            invariant(
              sourceSnapshot.expiresAt > Date.now(),
              "SNAPSHOT_EXPIRED",
              "Snapshot has expired",
              410,
            );
          const inherited = sourceSnapshot?.config ?? {};
          const transplant = sourceSnapshot
            ? (await this.backend.capabilities()).rootfsTransplant === true
            : false;
          if (sourceSnapshot)
            for (const key of [
              "image",
              "resources",
              "networkPolicy",
              "mounts",
            ] as const) {
              if (opts[key] !== undefined && (key === "image" || !transplant))
                invariant(
                  isDeepStrictEqual(opts[key], inherited[key]),
                  "UNSUPPORTED_FORK_OVERRIDE",
                  `Hypeman snapshot forks cannot change ${key}`,
                  422,
                );
            }
          const conf = {
            ...inherited,
            ...opts,
            resources: { ...inherited.resources, ...opts.resources },
            mounts: sourceSnapshot ? (opts.mounts ?? {}) : opts.mounts,
          };
          if (sourceSnapshot && opts.networkPolicy === undefined)
            conf.networkPolicy =
              this.store.get<NetworkConfiguration["policy"]>(
                "snapshot-network-policy",
                sourceSnapshot.snapshotId,
              ) ?? inherited.networkPolicy;
          invariant(
            this.options.network ||
              typeof (conf.networkPolicy ?? "allow-all") === "string",
            "UNSUPPORTED_NETWORK_POLICY",
            "Rule policies require the mediated network transport",
            422,
          );
          if (sourceSnapshot && conf.credentialSecrets === undefined)
            conf.credentialSecrets = this.store.get<Record<string, string>>(
              "snapshot-credentials",
              sourceSnapshot.snapshotId,
            );
          if (conf.credentials && Object.keys(conf.credentials).length) {
            const sources = new Set(
              Object.values(conf.credentials).map(
                (policy) => policy.source.env,
              ),
            );
            for (const [alias, policy] of Object.entries(conf.credentials)) {
              invariant(
                conf.credentialSecrets?.[policy.source.env] !== undefined,
                "MISSING_CREDENTIAL_SECRET",
                `Missing brokered credential value for ${policy.source.env}`,
                422,
              );
              invariant(
                conf.env?.[alias] === undefined &&
                  conf.env?.[policy.source.env] === undefined,
                "CREDENTIAL_ENV_CONFLICT",
                "Brokered credential aliases and sources must not be included in guest env",
                422,
              );
            }
            for (const source of Object.keys(conf.credentialSecrets ?? {}))
              invariant(
                sources.has(source),
                "UNBOUND_CREDENTIAL_SECRET",
                "Credential secrets must have a destination-scoped binding",
                422,
              );
            invariant(
              (await this.capabilities()).credentialBrokering,
              "CREDENTIALS_UNAVAILABLE",
              "The connected provider does not support credential brokering",
              422,
            );
          } else
            invariant(
              !Object.keys(conf.credentialSecrets ?? {}).length,
              "UNBOUND_CREDENTIAL_SECRET",
              "Credential secrets require destination-scoped bindings",
              422,
            );
          const sandboxId = id("sbx"),
            now = Date.now(),
            vcpus = conf.resources?.vcpus ?? 2;
          if (
            conf.runtime &&
            conf.runtime !== "bun" &&
            !conf.image &&
            !this.options.defaultImage
          )
            throw new SboxError(
              "RUNTIME_IMAGE_REQUIRED",
              "Select an image containing the requested runtime and Bun. Build images/Dockerfile for the universal development image.",
              422,
            );
          const s: SandboxRecord = {
            sandboxId,
            name: conf.name ?? sandboxId,
            status: "creating",
            image:
              conf.image ?? this.options.defaultImage ?? "oven/bun:1-debian",
            runtime:
              conf.runtime ??
              (!conf.image && !this.options.defaultImage ? "bun" : undefined),
            resources: {
              vcpus,
              memoryMb: conf.resources?.memoryMb ?? vcpus * 2048,
              diskMb: conf.resources?.diskMb ?? 10240,
            },
            timeout: conf.timeout ?? 300_000,
            persistent: conf.persistent ?? true,
            networkPolicy: redactPolicy(conf.networkPolicy ?? "allow-all"),
            env: conf.env ?? {},
            credentials: conf.credentials,
            tags: conf.tags ?? {},
            ports: conf.ports ?? [],
            routes: [],
            mounts: conf.mounts ?? {},
            createdAt: now,
            updatedAt: now,
            deadline: now + (conf.timeout ?? 300_000),
            snapshotId: sourceSnapshot?.snapshotId,
            snapshotExpiration: conf.snapshotExpiration ?? 30 * 86400_000,
            keepLastSnapshots:
              conf.keepLastSnapshots === undefined
                ? { count: 1 }
                : conf.keepLastSnapshots,
          };
          this.save(s);
          if (conf.credentialSecrets)
            this.store.put("credentials", s.sandboxId, conf.credentialSecrets);
          this.store.put(
            "network-policy",
            s.sandboxId,
            conf.networkPolicy ?? "allow-all",
          );
          try {
            await this.materializeMounts(s);
            this.validateMounts(s);
            if (Object.keys(s.mounts).length)
              invariant(
                (await this.backend.capabilities()).volumes,
                "UNSUPPORTED_FEATURE",
                "This Hypeman host does not support volumes",
                422,
              );
            this.save(s);
            await this.leaseGuard(s.sandboxId, async () => {
              const native = sourceSnapshot
                ? await this.backend.restore(
                    sourceSnapshot.nativeId,
                    this.providerOptions(s),
                  )
                : await this.backend.create(this.providerOptions(s));
              s.instanceId = native.id;
              this.save(s);
            });
            await this.attachNetwork(s);
            if (conf.source && conf.source.type !== "snapshot")
              await this.importSource(s, conf.source);
            return await this.leaseGuard(s.sandboxId, async () => {
              const prepared = this.get(s.sandboxId);
              invariant(
                prepared.status === "creating" &&
                  prepared.instanceId === s.instanceId &&
                  prepared.deadline! > Date.now(),
                "SANDBOX_TIMEOUT",
                "Sandbox creation deadline expired",
                408,
              );
              invariant(
                (await this.backend.get(s.instanceId!)).state.toLowerCase() ===
                  "running",
                "SANDBOX_STOPPED",
                "Sandbox stopped during initialization",
                409,
              );
              const startedAt = Date.now();
              s.deadline = startedAt + s.timeout;
              await this.backend.setDeadline(s.instanceId!, s.deadline!);
              this.startSession(s, startedAt);
              if (sourceSnapshot) {
                sourceSnapshot.updatedAt = startedAt;
                if (sourceSnapshot.expiration)
                  sourceSnapshot.expiresAt =
                    startedAt + sourceSnapshot.expiration;
                this.store.put(
                  "snapshot",
                  sourceSnapshot.snapshotId,
                  sourceSnapshot,
                );
              }
              s.routes = s.ports.map((port) => ({
                port,
                url:
                  this.options.previewUrl?.(sandboxId, port) ??
                  `http://${sandboxId}-${port}.localhost:7070`,
              }));
              this.releaseDriveReservations(s.sandboxId);
              return { sandbox: this.save(s), created: true, resumed: false };
            });
          } catch (e) {
            s.status = "failed";
            s.error = errorMessage(e);
            this.save(s);
            if (!s.instanceId) {
              try {
                s.instanceId = (await this.backend.get(s.sandboxId)).id;
                this.save(s);
              } catch {}
            }
            if (s.instanceId) {
              try {
                await this.detachNetwork(s.instanceId);
                await this.backend.delete(s.instanceId);
                s.instanceId = undefined;
                this.save(s);
              } catch {
                /* Retain exact ownership for retryable cleanup. */
              }
            }
            this.releaseDriveReservations(s.sandboxId);
            await this.cleanupDriveGenerations();
            throw e;
          }
        }),
    );
  }
  private startSession(s: SandboxRecord, now = Date.now()): void {
    s.status = "running";
    s.startedAt = now;
    s.stoppedAt = undefined;
    s.deadline = now + s.timeout;
    s.error = undefined;
    s.sessionId = id("ses");
    s.sessionConfig = structuredClone({
      resources: s.resources,
      mounts: s.mounts,
      env: s.env,
    });
    s.snapshotPending = false;
    const session: SessionRecord = {
      sessionId: s.sessionId,
      sandboxId: s.sandboxId,
      status: "running",
      startedAt: now,
      timeout: s.timeout,
      resources: structuredClone(s.resources),
    };
    this.store.put("session", session.sessionId, session);
    this.save(s);
  }
  private markStopped(s: SandboxRecord): void {
    s.status = "stopped";
    s.stoppedAt = Date.now();
    s.deadline = undefined;
    if (s.sessionId) {
      const session = this.store.get<SessionRecord>("session", s.sessionId);
      if (session) {
        session.status = "stopped";
        session.stoppedAt = s.stoppedAt;
        this.store.put("session", session.sessionId, session);
      }
    }
    this.save(s);
  }
  async resume(ref: string): Promise<SandboxRecord> {
    const s = this.get(ref);
    return this.locks.run(s.sandboxId, () =>
      this.ensureRunning(this.get(s.sandboxId)),
    );
  }
  assertSession(sandbox: SandboxRecord, expected?: string): void {
    if (expected !== undefined)
      invariant(
        expected === sandbox.sessionId && sandbox.status === "running",
        "SESSION_ENDED",
        "This session is no longer running",
        409,
      );
  }
  async openExecution(
    ref: string,
    options: BackendExec,
    sessionId?: string,
  ): Promise<Execution> {
    const original = this.get(ref);
    return this.locks.run(original.sandboxId, async () => {
      const sandbox = await this.ensureRunning(
        this.get(original.sandboxId),
        sessionId,
      );
      return this.execute(sandbox.instanceId!, {
        ...options,
        env: {
          ...BASE_ENV,
          ...(sandbox.sessionConfig?.env ?? sandbox.env),
          ...options.env,
        },
      });
    });
  }
  private async ensureRunning(
    s: SandboxRecord,
    sessionId?: string,
  ): Promise<SandboxRecord> {
    return this.leaseGuard(s.sandboxId, () =>
      this.ensureRunningGuarded(this.get(s.sandboxId), sessionId),
    );
  }
  private async ensureRunningGuarded(
    s: SandboxRecord,
    sessionId?: string,
  ): Promise<SandboxRecord> {
    if (sessionId)
      invariant(
        sessionId === s.sessionId && s.status === "running",
        "SESSION_ENDED",
        "This session is no longer running",
        409,
      );
    if (s.status === "running" && s.deadline! <= Date.now()) {
      await this.stopUnlocked(s, "SANDBOX_TIMEOUT");
      throw new SboxError("SANDBOX_TIMEOUT", "Sandbox session timed out", 408);
    }
    if (s.status === "running") return s;
    invariant(
      s.status === "stopped" && s.persistent && (s.instanceId || s.snapshotId),
      "SANDBOX_STOPPED",
      "Sandbox is not resumable",
      409,
    );
    if (s.snapshotPending && s.instanceId) await this.stopUnlocked(s);
    // Validate reservations before recording a native transition. A drive held
    // by another sandbox is a retryable admission failure, not a failed resume.
    this.validateMounts(s);
    if (s.instanceId && s.snapshotId) {
      try {
        await this.backend.get(s.instanceId);
      } catch (error) {
        if (!(error instanceof SboxError && error.status === 404)) throw error;
        // The host may have completed deletion just before the control plane
        // crashed. The committed snapshot remains the durable filesystem.
        s.instanceId = undefined;
        this.save(s);
      }
    }
    s.deadline = Date.now() + s.timeout;
    const active = this.store
      .all<SandboxRecord>("sandbox")
      .filter(
        (record) =>
          ["creating", "running", "stopping"].includes(record.status) ||
          (record.status === "failed" && record.instanceId),
      );
    invariant(
      active.length < (this.options.maxSandboxes ?? 100),
      "CAPACITY_EXCEEDED",
      "Sandbox concurrency limit reached",
      429,
    );
    s.status = "creating";
    this.save(s);
    try {
      await this.materializeMounts(s);
      this.validateMounts(s);
      if (s.instanceId) await this.backend.start(s.instanceId, s.deadline);
      else {
        const snapshot = this.snapshot(s.snapshotId!);
        invariant(
          snapshot.status === "ready",
          "SNAPSHOT_EXPIRED",
          "The current filesystem snapshot is unavailable",
          410,
        );
        s.instanceId = (
          await this.backend.restore(snapshot.nativeId, this.providerOptions(s))
        ).id;
        this.save(s);
        snapshot.updatedAt = Date.now();
        if (snapshot.expiration)
          snapshot.expiresAt = snapshot.updatedAt + snapshot.expiration;
        this.store.put("snapshot", snapshot.snapshotId, snapshot);
      }
      const secrets = this.store.get<Record<string, string>>(
        "credentials",
        s.sandboxId,
      );
      if (!this.options.network && secrets && this.backend.rotateCredentials)
        await this.backend.rotateCredentials(s.instanceId, secrets);
      await this.attachNetwork(s);
      this.startSession(s);
      await this.backend.setDeadline(s.instanceId!, s.deadline!);
      return s;
    } catch (error) {
      s.status = "failed";
      s.error = `Resume outcome requires inspection: ${errorMessage(error)}`;
      this.save(s);
      throw error;
    } finally {
      this.releaseDriveReservations(s.sandboxId);
      await this.cleanupDriveGenerations();
    }
  }
  async stop(
    ref: string,
    sessionId?: string,
  ): Promise<SandboxRecord & { snapshot?: SnapshotRecord }> {
    const s = this.get(ref);
    return this.locks.run(s.sandboxId, () =>
      this.leaseGuard(s.sandboxId, async () => {
        const current = this.get(s.sandboxId);
        this.assertSession(current, sessionId);
        const result = await this.stopUnlocked(current);
        const snapshot = result.snapshotId
          ? this.store.get<SnapshotRecord>("snapshot", result.snapshotId)
          : undefined;
        return { ...result, ...(snapshot ? { snapshot } : {}) };
      }),
    );
  }
  private async stopUnlocked(
    s: SandboxRecord,
    reason = "SANDBOX_STOPPED",
    retainInstance = false,
  ): Promise<SandboxRecord> {
    if (s.status === "stopped") {
      if (s.instanceId && s.snapshotPending && !retainInstance) {
        if (await this.automaticSnapshotSupported(s))
          await this.captureSnapshot(s);
        else {
          s.snapshotPending = false;
          this.save(s);
        }
      }
      if (!s.persistent && s.instanceId && !retainInstance) {
        await this.backend.delete(s.instanceId);
        s.instanceId = undefined;
        this.save(s);
      }
      return s;
    }
    invariant(
      s.instanceId,
      "SANDBOX_NOT_READY",
      "Sandbox does not have a running instance",
      409,
    );
    s.status = "stopping";
    this.save(s);
    for (const c of this.store.all<CommandRecord>("command"))
      if (c.sandboxId === s.sandboxId && c.status === "running") {
        c.status = "failed";
        c.finishedAt = Date.now();
        c.error = {
          code: reason,
          message:
            reason === "SANDBOX_TIMEOUT"
              ? "Sandbox deadline expired"
              : "Sandbox stopped while the command was running",
        };
        this.saveCommand(c);
        await this.active
          .get(c.commandId)
          ?.execution.kill("SIGKILL")
          .catch(() => {});
      }
    await this.detachNetwork(s.instanceId);
    if (s.persistent || retainInstance) await this.backend.stop(s.instanceId);
    else {
      await this.backend.delete(s.instanceId);
      s.instanceId = undefined;
    }
    if (s.persistent && !retainInstance)
      s.snapshotPending = !this.hasVolumeOverlays(s);
    this.markStopped(s);
    if (s.persistent && !retainInstance) {
      if (await this.automaticSnapshotSupported(s))
        await this.captureSnapshot(s);
      else {
        s.snapshotPending = false;
        this.save(s);
      }
    }
    return s;
  }
  async delete(ref: string, deleteOrphanSnapshots = false): Promise<void> {
    const s = this.get(ref);
    await this.locks.run("catalog", () =>
      this.locks.run(s.sandboxId, () =>
        this.leaseGuard(s.sandboxId, async () => {
          const current = this.get(s.sandboxId);
          if (current.status === "failed" && !current.instanceId) {
            try {
              current.instanceId = (
                await this.backend.get(current.sandboxId)
              ).id;
              this.save(current);
            } catch (error) {
              if (
                !(
                  error &&
                  typeof error === "object" &&
                  "status" in error &&
                  error.status === 404
                )
              )
                throw error;
            }
          }
          if (current.instanceId) {
            if (current.status !== "stopped")
              await this.stopUnlocked(current, "SANDBOX_STOPPED", true);
            if (current.instanceId)
              await this.backend.delete(current.instanceId);
          }
          this.store.transaction(() => {
            for (const c of this.store.all<CommandRecord>("command"))
              if (c.sandboxId === s.sandboxId) {
                this.store.deleteLogs(c.commandId);
                this.store.delete("command", c.commandId);
              }
            for (const ses of this.store.all<SessionRecord>("session"))
              if (ses.sandboxId === s.sandboxId)
                this.store.delete("session", ses.sessionId);
            this.store.delete("sandbox", s.sandboxId);
            this.store.delete("credentials", s.sandboxId);
            this.store.delete("network-policy", s.sandboxId);
          });
          if (deleteOrphanSnapshots) {
            for (const snapshot of this.store.all<SnapshotRecord>("snapshot")) {
              if (snapshot.sandboxId !== s.sandboxId) continue;
              const referenced =
                this.store
                  .all<SandboxRecord>("sandbox")
                  .some((other) => other.snapshotId === snapshot.snapshotId) ||
                this.store
                  .all<SnapshotRecord>("snapshot")
                  .some(
                    (other) =>
                      other.parentId === snapshot.snapshotId &&
                      other.sandboxId !== s.sandboxId,
                  );
              if (!referenced) await this.deleteSnapshot(snapshot.snapshotId);
            }
          }
          await this.cleanupDriveGenerations();
        }),
      ),
    );
  }
  async update(
    ref: string,
    patch: Record<string, unknown>,
    sessionId?: string,
  ): Promise<SandboxRecord> {
    const allowed = new Set([
      "env",
      "tags",
      "timeout",
      "networkPolicy",
      "snapshotExpiration",
      "keepLastSnapshots",
      "persistent",
      "ports",
      "credentialSecrets",
      "resources",
      "mounts",
      "currentSnapshotId",
    ]);
    for (const key of Object.keys(patch))
      invariant(
        allowed.has(key),
        "UNSUPPORTED_UPDATE",
        `Updating ${key} is not supported`,
        422,
      );
    const { currentSnapshotId, ...validated } = patch;
    if (currentSnapshotId !== undefined)
      v.string(currentSnapshotId, "currentSnapshotId", 128);
    v.create(validated);
    const original = this.get(ref);
    return this.withSnapshotReservation(
      currentSnapshotId as string | undefined,
      () =>
        this.locks.run("catalog", () =>
          this.locks.run(original.sandboxId, () =>
            this.leaseGuard(original.sandboxId, async () => {
              const s = this.get(original.sandboxId);
              this.assertSession(s, sessionId);
              try {
                if (patch.networkPolicy !== undefined && !this.options.network)
                  invariant(
                    isDeepStrictEqual(patch.networkPolicy, s.networkPolicy),
                    "UNSUPPORTED_NETWORK_POLICY_UPDATE",
                    "Live policies require the mediated network transport",
                    422,
                  );
                if (patch.env && s.credentials)
                  for (const [alias, policy] of Object.entries(s.credentials)) {
                    const env = patch.env as Record<string, string>;
                    invariant(
                      env[alias] === undefined &&
                        env[policy.source.env] === undefined,
                      "CREDENTIAL_ENV_CONFLICT",
                      "Brokered credential aliases and sources must not be included in guest env",
                      422,
                    );
                  }
                const {
                  credentialSecrets,
                  networkPolicy,
                  resources,
                  mounts,
                  currentSnapshotId: selectedSnapshot,
                  ...publicPatch
                } = patch;
                const configuration = this.networkConfiguration(s);
                if (credentialSecrets) {
                  invariant(
                    s.credentials &&
                      (this.options.network || this.backend.rotateCredentials),
                    "CREDENTIALS_UNAVAILABLE",
                    "Sandbox has no brokered credential bindings",
                    422,
                  );
                  configuration.credentialSecrets = {
                    ...configuration.credentialSecrets,
                    ...(credentialSecrets as Record<string, string>),
                  };
                  const sources = new Set(
                    Object.values(s.credentials!).map(
                      (policy) => policy.source.env,
                    ),
                  );
                  for (const key of Object.keys(
                    configuration.credentialSecrets,
                  ))
                    invariant(
                      sources.has(key),
                      "UNBOUND_CREDENTIAL_SECRET",
                      "Credential secrets must match an existing binding",
                      422,
                    );
                  nativeCredentialSecrets(
                    normalizeCredentials(s.credentials),
                    configuration.credentialSecrets,
                    true,
                  );
                }
                if (networkPolicy !== undefined) {
                  configuration.policy =
                    networkPolicy as NetworkConfiguration["policy"];
                  new CompiledPolicy(configuration.policy);
                }
                if (s.status === "running" && s.deadline! <= Date.now())
                  await this.stopUnlocked(s, "SANDBOX_TIMEOUT");
                const reconfigure =
                  patch.resources !== undefined ||
                  patch.mounts !== undefined ||
                  currentSnapshotId !== undefined;
                if (reconfigure) {
                  invariant(
                    !s.instanceId || !this.hasVolumeOverlays(s),
                    "OVERLAY_TRANSPLANT_UNAVAILABLE",
                    "Changing VM configuration would discard a per-instance drive overlay; keep this instance to preserve its writes",
                    422,
                  );
                  invariant(
                    ["running", "stopped"].includes(s.status),
                    "SANDBOX_NOT_READY",
                    "Sandbox must be running or stopped before staging its next configuration",
                    409,
                  );
                  if (currentSnapshotId !== undefined)
                    invariant(
                      s.status === "stopped",
                      "SANDBOX_RUNNING",
                      "Stop the sandbox before rolling back its filesystem snapshot",
                      409,
                    );
                  invariant(
                    (await this.backend.capabilities()).rootfsTransplant ===
                      true,
                    "ROOTFS_TRANSPLANT_UNAVAILABLE",
                    "Changing stopped sandbox configuration requires the host storage companion",
                    422,
                  );
                  if (
                    s.status === "stopped" &&
                    s.snapshotPending &&
                    s.instanceId
                  )
                    await this.stopUnlocked(s);
                  const desired = structuredClone(s);
                  if (currentSnapshotId !== undefined) {
                    const snapshot = this.snapshot(currentSnapshotId as string);
                    invariant(
                      snapshot.status === "ready" &&
                        (!snapshot.expiresAt ||
                          snapshot.expiresAt > Date.now()),
                      "SNAPSHOT_EXPIRED",
                      "The requested snapshot is unavailable or expired",
                      410,
                    );
                    invariant(
                      snapshot.config.image === s.image,
                      "SNAPSHOT_IMAGE_MISMATCH",
                      "Rollback requires the same base image",
                      422,
                    );
                    desired.snapshotId = snapshot.snapshotId;
                  }
                  if (patch.resources) {
                    const resources =
                      patch.resources as CreateOptions["resources"];
                    desired.resources = { ...s.resources, ...resources };
                    if (
                      resources?.vcpus !== undefined &&
                      resources.memoryMb === undefined
                    )
                      desired.resources.memoryMb = resources.vcpus * 2048;
                  }
                  const snapshot = desired.snapshotId
                    ? this.snapshot(desired.snapshotId)
                    : undefined;
                  invariant(
                    snapshot || s.status === "running",
                    "SNAPSHOT_REQUIRED",
                    "A filesystem snapshot is required before changing stopped VM configuration",
                    409,
                  );
                  invariant(
                    desired.resources.diskMb ===
                      (s.sessionConfig?.resources.diskMb ??
                        snapshot?.config.resources?.diskMb ??
                        s.resources.diskMb),
                    "SNAPSHOT_DISK_OVERRIDE",
                    "Changing snapshot disk capacity is not supported",
                    422,
                  );
                  if (patch.mounts) {
                    desired.mounts = structuredClone(
                      patch.mounts,
                    ) as SandboxRecord["mounts"];
                    for (const [path, mount] of Object.entries(
                      desired.mounts,
                    )) {
                      const source = this.drive(mount.driveId);
                      desired.mounts[path] = {
                        ...mount,
                        driveId: source.driveId,
                        ...(mount.mode === "snapshot"
                          ? { readOnly: true }
                          : {}),
                      };
                    }
                    this.validateMounts(desired, s.status === "stopped");
                  }
                  if (s.status === "stopped" && s.instanceId) {
                    await this.backend.delete(s.instanceId);
                    s.instanceId = undefined;
                  }
                  s.resources = desired.resources;
                  s.mounts = desired.mounts;
                  s.snapshotId = desired.snapshotId;
                }
                if (
                  typeof patch.timeout === "number" &&
                  patch.timeout > s.timeout &&
                  s.status === "running"
                ) {
                  const extension = patch.timeout - s.timeout;
                  invariant(
                    s.deadline! + extension - s.startedAt! <= 86_400_000,
                    "TIMEOUT_LIMIT",
                    "A session cannot exceed 24 hours",
                    400,
                  );
                  await this.backend.setDeadline(
                    s.instanceId!,
                    s.deadline! + extension,
                  );
                  s.deadline! += extension;
                  const session = this.store.get<SessionRecord>(
                    "session",
                    s.sessionId!,
                  );
                  if (session) {
                    session.timeout += extension;
                    this.store.put("session", session.sessionId, session);
                  }
                }
                if (
                  (networkPolicy !== undefined || credentialSecrets) &&
                  s.status === "running"
                ) {
                  if (this.options.network)
                    (await this.attachNetwork(s))!.update(configuration);
                  else if (credentialSecrets)
                    await this.backend.rotateCredentials!(
                      s.instanceId!,
                      configuration.credentialSecrets!,
                    );
                }
                if (credentialSecrets)
                  this.store.put(
                    "credentials",
                    s.sandboxId,
                    configuration.credentialSecrets,
                  );
                if (networkPolicy !== undefined) {
                  this.store.put(
                    "network-policy",
                    s.sandboxId,
                    configuration.policy,
                  );
                  s.networkPolicy = redactPolicy(configuration.policy);
                }
                Object.assign(s, publicPatch);
                if (patch.ports !== undefined)
                  s.routes = s.ports.map((port) => ({
                    port,
                    url:
                      this.options.previewUrl?.(s.sandboxId, port) ??
                      `http://${s.sandboxId}-${port}.localhost:7070`,
                  }));
                return this.save(s);
              } finally {
                this.releaseDriveReservations(s.sandboxId);
                await this.cleanupDriveGenerations();
              }
            }),
          ),
        ),
    );
  }
  async extendTimeout(
    ref: string,
    duration: number,
    sessionId?: string,
  ): Promise<SandboxRecord> {
    v.integer(duration, "duration", 1, 86_400_000);
    const original = this.get(ref);
    return this.locks.run(original.sandboxId, () =>
      this.leaseGuard(original.sandboxId, async () => {
        const s = this.get(original.sandboxId);
        this.assertSession(s, sessionId);
        invariant(
          s.status === "running" && s.instanceId && s.deadline! > Date.now(),
          "SANDBOX_STOPPED",
          "Session is not running",
          409,
        );
        invariant(
          s.deadline! + duration - s.startedAt! <= 86_400_000,
          "TIMEOUT_LIMIT",
          "A session cannot exceed 24 hours",
          400,
        );
        await this.backend.setDeadline(s.instanceId, s.deadline! + duration);
        s.deadline! += duration;
        s.timeout += duration;
        if (s.sessionId) {
          const session = this.store.get<SessionRecord>(
            "session",
            s.sessionId,
          )!;
          session.timeout = s.timeout;
          this.store.put("session", session.sessionId, session);
        }
        return this.save(s);
      }),
    );
  }
  async run(
    ref: string,
    opts: ExecOptions & { sessionId?: string },
  ): Promise<CommandRecord> {
    v.command(opts);
    const original = this.get(ref);
    return this.locks.run(original.sandboxId, async () => {
      const s = await this.ensureRunning(
        this.get(original.sandboxId),
        opts.sessionId,
      );
      invariant(
        this.active.size < (this.options.maxCommands ?? 256),
        "CAPACITY_EXCEEDED",
        "Command concurrency limit reached",
        429,
      );
      const c: CommandRecord = {
        commandId: id("cmd"),
        sandboxId: s.sandboxId,
        sessionId: s.sessionId!,
        cmd: opts.cmd,
        args: opts.args ?? [],
        cwd: opts.cwd ?? WORKDIR,
        status: "running",
        exitCode: null,
        startedAt: Date.now(),
      };
      this.saveCommand(c);
      try {
        const execution = await this.execute(s.instanceId!, {
          cmd: c.cmd,
          args: c.args,
          cwd: c.cwd,
          env: { ...BASE_ENV, ...(s.sessionConfig?.env ?? s.env), ...opts.env },
          user: opts.sudo ? "root" : (opts.user ?? "sandbox"),
          stdin: opts.stdin,
        });
        const active: ActiveCommand = {
          execution,
          done: Promise.resolve(),
          bytes: 0,
          retained: [],
          retainedBytes: 0,
        };
        this.active.set(c.commandId, active);
        active.done = this.consume(c, active);
        if (opts.timeoutMs) {
          active.timer = setTimeout(() => {
            const record = this.command(c.commandId);
            if (record.status !== "running") return;
            record.status = "failed";
            record.finishedAt = Date.now();
            record.error = {
              code: "COMMAND_TIMEOUT",
              message: "Command deadline expired",
            };
            this.saveCommand(record);
            void execution.kill("SIGKILL").catch(() => {});
          }, opts.timeoutMs);
          active.timer.unref();
        }
        return this.command(c.commandId);
      } catch (e) {
        c.status = "failed";
        c.finishedAt = Date.now();
        c.error = {
          code: e instanceof SboxError ? e.code : "EXEC_FAILED",
          message: errorMessage(e),
        };
        this.saveCommand(c);
        throw e;
      }
    });
  }
  private async consume(
    c: CommandRecord,
    active: ActiveCommand,
  ): Promise<void> {
    let sequence = 0;
    // Attach rejection handler before consuming to avoid unhandled socket failures.
    const result = active.execution.exited.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      for await (const event of active.execution.output) {
        const retention = Math.max(
          1,
          this.options.maxOutputBytes ?? MAX_OUTPUT,
        );
        const chunkSize = Math.min(64 * 1024, retention);
        for (
          let offset = 0;
          offset < event.data.byteLength;
          offset += chunkSize
        ) {
          const data = event.data.subarray(offset, offset + chunkSize);
          active.bytes += data.byteLength;
          const log: LogRecord = {
            sequence: ++sequence,
            stream: event.stream,
            data: Buffer.from(data).toString("base64"),
            timestamp: Date.now(),
          };
          this.store.appendLog(c.commandId, log);
          active.retained.push({ sequence, bytes: data.byteLength });
          active.retainedBytes += data.byteLength;
          let through = 0;
          while (
            active.retainedBytes > retention ||
            active.retained.length > 16384
          ) {
            const removed = active.retained.shift()!;
            active.retainedBytes -= removed.bytes;
            through = removed.sequence;
          }
          if (through) {
            this.store.pruneLogs(c.commandId, through);
            const record = this.command(c.commandId);
            if (!record.truncated) {
              record.truncated = true;
              this.saveCommand(record);
            }
          }
          for (const subscriber of this.logSubscribers.get(c.commandId) ?? []) {
            if (subscriber.error) continue;
            subscriber.bytes += log.data.length;
            if (
              subscriber.bytes > Math.max(32 * 1024 * 1024, retention * 2) ||
              subscriber.queue.length >= 32768
            ) {
              subscriber.error = new SboxError(
                "LOG_CONSUMER_TOO_SLOW",
                "The live log consumer exceeded its queue budget; reconnect with a retained cursor",
                409,
              );
              subscriber.queue = [];
              subscriber.bytes = 0;
            } else subscriber.queue.push(log);
          }
          this.notify(c.commandId);
        }
      }
      const outcome = await result;
      if ("error" in outcome) throw outcome.error;
      const record = this.command(c.commandId);
      if (record.status === "running") {
        record.status = "exited";
        record.exitCode = outcome.value.exitCode;
        record.finishedAt = Date.now();
        this.saveCommand(record);
      }
    } catch (e) {
      const record = this.store.get<CommandRecord>("command", c.commandId);
      if (record?.status === "running") {
        record.status = "failed";
        record.finishedAt = Date.now();
        const sandbox = this.store.get<SandboxRecord>("sandbox", c.sandboxId);
        const expired =
          sandbox?.deadline !== undefined && sandbox.deadline <= Date.now();
        record.error = {
          code: expired ? "SANDBOX_TIMEOUT" : "EXEC_FAILED",
          message: expired ? "Sandbox deadline expired" : errorMessage(e),
        };
        this.saveCommand(record);
      }
    } finally {
      if (active.timer) clearTimeout(active.timer);
      this.active.delete(c.commandId);
      this.notify(c.commandId);
    }
  }
  async wait(ref: string): Promise<CommandRecord> {
    const c = this.command(ref);
    await this.active.get(c.commandId)?.done;
    return this.command(ref);
  }
  async kill(ref: string, signal = "SIGTERM"): Promise<CommandRecord> {
    invariant(
      [
        "SIGTERM",
        "SIGKILL",
        "SIGINT",
        "SIGHUP",
        "SIGQUIT",
        "SIGUSR1",
        "SIGUSR2",
        "SIGSTOP",
        "SIGCONT",
      ].includes(signal),
      "INVALID_ARGUMENT",
      "Unsupported signal",
    );
    const c = this.command(ref);
    if (c.status !== "running") return c;
    const active = this.active.get(c.commandId);
    invariant(
      active,
      "COMMAND_UNAVAILABLE",
      "Command transport is unavailable",
      409,
    );
    await active.execution.kill(signal);
    return this.command(ref);
  }
  async stdin(ref: string, data?: string): Promise<void> {
    const c = this.command(ref);
    const active = this.active.get(c.commandId);
    invariant(
      c.status === "running" && active,
      "COMMAND_ENDED",
      "Command is no longer running",
      409,
    );
    if (data === undefined) await active.execution.closeStdin();
    else {
      v.base64(data);
      invariant(
        data.length <= 2 * 1024 * 1024,
        "PAYLOAD_TOO_LARGE",
        "stdin chunk exceeds 1.5 MiB",
        413,
      );
      await active.execution.write(Buffer.from(data, "base64"));
    }
  }
  private notify(ref: string): void {
    for (const fn of this.listeners.get(ref) ?? []) fn();
  }
  private changed(ref: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.listeners.get(ref) ?? new Set<() => void>();
      this.listeners.set(ref, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.listeners.delete(ref);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 250);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  async *logs(
    ref: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<LogRecord | { type: "done"; command: CommandRecord }> {
    this.command(ref);
    v.integer(after, "after", 0, Number.MAX_SAFE_INTEGER);
    this.assertLogCursor(ref, after);
    // Snapshot the bounded replay synchronously before subscribing. Future records
    // have an independent live queue, so retention pruning cannot drop live bytes.
    const replay = this.store.logs(ref, after, 16384);
    const subscriber: LogSubscriber = {
      queue: replay,
      bytes: replay.reduce((n, r) => n + r.data.length, 0),
    };
    const subscribers =
      this.logSubscribers.get(ref) ?? new Set<LogSubscriber>();
    subscribers.add(subscriber);
    this.logSubscribers.set(ref, subscribers);
    try {
      while (!signal?.aborted) {
        if (subscriber.error) throw subscriber.error;
        while (subscriber.queue.length) {
          const record = subscriber.queue.shift()!;
          subscriber.bytes -= record.data.length;
          if (record.sequence <= after) continue;
          invariant(
            record.sequence === after + 1,
            "LOGS_EXPIRED",
            "The requested log history is no longer retained",
            409,
          );
          after = record.sequence;
          yield record;
          if (signal?.aborted) return;
          if (subscriber.error) throw subscriber.error;
        }
        const command = this.command(ref);
        if (command.status !== "running" && !this.active.has(ref)) {
          yield { type: "done", command };
          return;
        }
        await this.changed(ref, signal);
      }
    } finally {
      subscribers.delete(subscriber);
      if (!subscribers.size) this.logSubscribers.delete(ref);
    }
  }
  private assertLogCursor(ref: string, after: number): void {
    const bounds = this.store.logBounds(ref);
    if (bounds.first !== null && after < bounds.first - 1)
      throw new SboxError(
        "LOGS_EXPIRED",
        "The requested log history is no longer retained; resume from firstSequence - 1",
        409,
        { firstSequence: bounds.first },
      );
    invariant(
      bounds.last === null ? after === 0 : after <= bounds.last,
      "INVALID_CURSOR",
      "Log cursor is beyond the available output",
      400,
    );
  }
  poll(ref: string, after = 0, limit = 128) {
    const command = this.command(ref);
    v.integer(after, "after", 0, Number.MAX_SAFE_INTEGER);
    v.integer(limit, "limit", 1, 1000);
    this.assertLogCursor(ref, after);
    const logs = this.store.logs(ref, after, limit + 1);
    const hasMore = logs.length > limit;
    if (hasMore) logs.pop();
    return {
      command,
      logs,
      nextCursor: logs.at(-1)?.sequence ?? after,
      hasMore,
      lastSequence: this.store.logBounds(ref).last ?? 0,
    };
  }
  private async raw(
    s: SandboxRecord,
    cmd: string,
    args: string[],
    options: {
      user?: string;
      env?: Record<string, string>;
      input?: Uint8Array;
      maxBytes?: number;
    } = {},
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const exec = await this.execute(s.instanceId!, {
      cmd,
      args,
      cwd: WORKDIR,
      user: options.user ?? "sandbox",
      env: { ...BASE_ENV, ...(s.sessionConfig?.env ?? s.env), ...options.env },
      stdin: options.input !== undefined,
      timeoutMs: 120_000,
    });
    const result = exec.exited.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let length = 0;
    try {
      if (options.input !== undefined) {
        for (let offset = 0; offset < options.input.length; offset += 64 * 1024)
          await exec.write(options.input.subarray(offset, offset + 64 * 1024));
        await exec.closeStdin();
      }
      for await (const event of exec.output) {
        length += event.data.byteLength;
        if (length > (options.maxBytes ?? MAX_OUTPUT)) {
          await exec.kill("SIGKILL");
          throw new SboxError(
            "OUTPUT_LIMIT",
            "Operation output exceeds the configured limit",
            413,
          );
        }
        (event.stream === "stdout" ? stdout : stderr).push(
          Buffer.from(event.data),
        );
      }
    } catch (e) {
      await exec.kill("SIGKILL").catch(() => {});
      throw e;
    }
    const outcome = await result;
    if ("error" in outcome) throw outcome.error;
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: outcome.value.exitCode,
    };
  }
  async fs(
    ref: string,
    op: string,
    args: Record<string, unknown>,
    user?: string,
    sessionId?: string,
  ): Promise<any> {
    v.string(op, "filesystem operation", 64);
    v.object(args);
    if (user !== undefined) v.command({ cmd: "bun", user });
    const s = this.get(ref);
    return this.locks.run(s.sandboxId, async () => {
      const current = await this.ensureRunning(
        this.get(s.sandboxId),
        sessionId,
      );
      const result = await this.raw(
        current,
        "bun",
        ["-e", FS_GUEST_SCRIPT, "--"],
        { user, input: Buffer.from(JSON.stringify({ op, args })) },
      );
      let parsed: any;
      try {
        parsed = JSON.parse(result.stdout.toString());
      } catch {
        throw new SboxError(
          "FILESYSTEM_FAILED",
          result.stderr.toString() || "Invalid filesystem response",
          502,
        );
      }
      if (parsed.error)
        throw new SboxError(
          parsed.error.code ?? "FILESYSTEM_FAILED",
          parsed.error.message,
          result.exitCode ? 400 : 500,
          parsed.error,
        );
      if (result.exitCode !== 0)
        throw new SboxError("FILESYSTEM_FAILED", result.stderr.toString(), 502);
      return parsed.result;
    });
  }
  async readFile(
    ref: string,
    path: string,
    user?: string,
    sessionId?: string,
  ): Promise<{ data: string } | null> {
    v.string(path, "path");
    try {
      return await this.fs(ref, "readFile", { path }, user, sessionId);
    } catch (e) {
      if (e instanceof SboxError && e.code === "ENOENT") return null;
      throw e;
    }
  }
  async readFileStream(
    ref: string,
    path: string,
    user?: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    v.string(path, "path");
    if (user !== undefined) v.command({ cmd: "bun", user });
    const original = this.get(ref);
    return this.locks.run(original.sandboxId, async () => {
      signal?.throwIfAborted();
      const sandbox = await this.ensureRunning(
        this.get(original.sandboxId),
        sessionId,
      );
      const execution = await this.execute(sandbox.instanceId!, {
        cmd: "bun",
        args: ["-e", READ_FILE_SCRIPT, "--"],
        cwd: WORKDIR,
        user: user ?? "sandbox",
        env: { ...BASE_ENV, ...sandbox.env },
        stdin: true,
      });
      void execution.exited.catch(() => {});
      try {
        await execution.write(Buffer.from(JSON.stringify({ path })));
        await execution.closeStdin();
        return await fileResponse(execution, signal);
      } catch (error) {
        await execution.kill("SIGKILL").catch(() => {});
        throw error;
      }
    });
  }
  async writeFileStream(
    ref: string,
    path: string,
    request: Request,
    user?: string,
    sessionId?: string,
    mode?: number,
  ): Promise<void> {
    v.string(path, "path");
    if (mode !== undefined) v.integer(mode, "mode", 0, 0o7777);
    if (user !== undefined) v.command({ cmd: "bun", user });
    const declared = request.headers.get("content-length");
    const size = declared === null ? undefined : Number(declared);
    if (size !== undefined) v.integer(size, "content-length", 0, 1024 ** 4);
    const original = this.get(ref);
    await this.locks.run(original.sandboxId, async () => {
      request.signal.throwIfAborted();
      const sandbox = await this.ensureRunning(
        this.get(original.sandboxId),
        sessionId,
      );
      const execution = await this.execute(sandbox.instanceId!, {
        cmd: "bun",
        args: ["-e", WRITE_FILE_SCRIPT, "--"],
        cwd: WORKDIR,
        user: user ?? "sandbox",
        env: { ...BASE_ENV, ...sandbox.env },
        stdin: true,
      });
      const result = execution.exited.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let output = Buffer.alloc(0);
      const read = (async () => {
        for await (const chunk of execution.output) {
          if (chunk.stream === "stdout")
            output = Buffer.concat([output, chunk.data]);
          if (output.length > 16384)
            throw new SboxError(
              "FILESYSTEM_FAILED",
              "Invalid upload response",
              502,
            );
        }
      })();
      void read.catch(() => {});
      const abort = () => {
        void execution.kill("SIGKILL").catch(() => {});
      };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        await execution.write(
          Buffer.from(JSON.stringify({ path, mode, size }) + "\n"),
        );
        let received = 0;
        if (request.body) {
          const reader = request.body.getReader();
          try {
            for (;;) {
              request.signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) break;
              received += next.value.byteLength;
              invariant(
                received <= 1024 ** 4,
                "PAYLOAD_TOO_LARGE",
                "File exceeds 1 TiB",
                413,
              );
              for (
                let offset = 0;
                offset < next.value.byteLength;
                offset += 64 * 1024
              )
                await execution.write(
                  next.value.subarray(offset, offset + 64 * 1024),
                );
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        await execution.closeStdin();
        await read;
        const outcome = await result;
        if ("error" in outcome) throw outcome.error;
        const response = JSON.parse(output.toString());
        if (response.error)
          throw new SboxError(response.error.code, response.error.message, 400);
        invariant(
          !outcome.value.exitCode && response.size === received,
          "FILESYSTEM_FAILED",
          "Upload did not complete",
          502,
        );
      } catch (error) {
        await execution.kill("SIGKILL").catch(() => {});
        throw error;
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
    });
  }
  async writeFiles(
    ref: string,
    files: Array<{ path: string; data: string; mode?: number }>,
    user?: string,
    sessionId?: string,
  ): Promise<void> {
    invariant(
      Array.isArray(files) && files.length <= 1000,
      "INVALID_ARGUMENT",
      "files must contain at most 1000 files",
    );
    for (const f of files) {
      v.object(f);
      v.string(f.path, "path");
      v.base64(f.data);
      if (f.mode !== undefined) v.integer(f.mode, "mode", 0, 0o7777);
    }
    // One guest operation validates/creates parents and preserves binary contents; filenames are JSON, never shell code.
    await this.fs(ref, "writeFiles", { files }, user, sessionId);
  }
  async makeSnapshot(
    ref: string,
    options: { expiration?: number; sessionId?: string } = {},
  ): Promise<SnapshotRecord> {
    if (options.expiration !== undefined)
      v.integer(options.expiration, "expiration", 0, 31_536_000_000);
    const s = this.get(ref);
    return this.locks.run(s.sandboxId, () =>
      this.leaseGuard(s.sandboxId, async () => {
        const current = this.get(s.sandboxId);
        this.assertSession(current, options.sessionId);
        invariant(
          !this.hasVolumeOverlays(current),
          "OVERLAY_TRANSPLANT_UNAVAILABLE",
          "Filesystem snapshots do not yet include per-instance drive overlays",
          422,
        );
        if (
          !current.instanceId &&
          current.status === "stopped" &&
          current.snapshotId
        )
          return this.snapshot(current.snapshotId);
        invariant(
          current.instanceId,
          "SANDBOX_STOPPED",
          "No instance is available to snapshot",
          409,
        );
        invariant(
          (await this.backend.capabilities()).snapshots,
          "UNSUPPORTED_FEATURE",
          "This Hypeman host does not support snapshots",
          422,
        );
        invariant(
          !Object.keys(current.mounts).length ||
            (await this.backend.capabilities()).rootfsTransplant === true,
          "SNAPSHOT_WITH_DRIVES",
          "Snapshots with mounted drives require the host storage companion",
          422,
        );
        if (current.status !== "stopped") {
          // Always retain the instance until the snapshot has been captured, including ephemeral sandboxes.
          await this.stopUnlocked(current, "SANDBOX_STOPPED", true);
        }
        return this.captureSnapshot(current, options);
      }),
    );
  }
  private async captureSnapshot(
    current: SandboxRecord,
    options: { expiration?: number } = {},
  ): Promise<SnapshotRecord> {
    const snapshotId = current.pendingSnapshotId ?? id("snp"),
      now = Date.now(),
      expiry =
        options.expiration ??
        current.keepLastSnapshots?.expiration ??
        current.snapshotExpiration;
    const previousCapture = this.store.get<SnapshotRecord>(
      "snapshot",
      snapshotId,
    );
    current.pendingSnapshotId = snapshotId;
    current.snapshotPending = true;
    this.save(current);
    const snap: SnapshotRecord = previousCapture ?? {
      snapshotId,
      nativeId: "",
      status: "creating",
      sourceInstanceId: current.instanceId,
      sourceSessionId: current.sessionId,
      updatedAt: now,
      sandboxId: current.sandboxId,
      name: current.name,
      createdAt: now,
      expiresAt: expiry ? now + expiry : null,
      expiration: expiry,
      parentId: current.snapshotId,
      config: {
        image: current.image,
        runtime: current.runtime,
        resources: current.sessionConfig?.resources ?? current.resources,
        networkPolicy: current.networkPolicy,
        env: current.sessionConfig?.env ?? current.env,
        credentials: current.credentials,
        ports: current.ports,
        persistent: current.persistent,
        timeout: current.timeout,
        tags: current.tags,
        mounts: current.sessionConfig?.mounts ?? current.mounts,
        snapshotExpiration: current.snapshotExpiration,
        keepLastSnapshots: current.keepLastSnapshots,
      },
    };
    this.store.put("snapshot", snapshotId, snap);
    if (!previousCapture) {
      const secrets = this.store.get<Record<string, string>>(
        "credentials",
        current.sandboxId,
      );
      if (secrets) this.store.put("snapshot-credentials", snapshotId, secrets);
      this.store.put(
        "snapshot-network-policy",
        snapshotId,
        this.networkConfiguration(current).policy,
      );
    }
    try {
      if (snap.status !== "ready") {
        let native: { id: string; sizeBytes?: number } | null = null;
        if (previousCapture) {
          invariant(
            this.backend.findSnapshot,
            "SNAPSHOT_OUTCOME_UNKNOWN",
            "The provider must resolve the previous capture before retrying its mutation",
            409,
          );
          native = await this.backend.findSnapshot(
            current.instanceId!,
            snapshotId,
          );
        }
        native ??= await this.backend.snapshot(current.instanceId!, snapshotId);
        snap.nativeId = native.id;
        snap.sizeBytes = native.sizeBytes;
        snap.status = "ready";
        snap.error = undefined;
      }
    } catch (error) {
      snap.status = "failed";
      snap.error = errorMessage(error);
      try {
        const native = await this.backend.findSnapshot?.(
          current.instanceId!,
          snapshotId,
        );
        if (native) {
          snap.nativeId = native.id;
          snap.sizeBytes = native.sizeBytes;
          snap.status = "ready";
          snap.error = undefined;
        }
      } catch {}
      this.store.put("snapshot", snapshotId, snap);
      if (snap.status !== "ready") throw error;
    }
    this.store.put("snapshot", snapshotId, snap);
    current.snapshotId = snapshotId;
    this.save(current);
    if (
      !current.persistent ||
      (await this.backend.capabilities()).rootfsTransplant === true
    ) {
      await this.backend.delete(current.instanceId!);
      current.instanceId = undefined;
      this.save(current);
    }
    current.snapshotPending = false;
    current.pendingSnapshotId = undefined;
    this.save(current);
    const previous = this.store
      .all<SnapshotRecord>("snapshot")
      .filter((x) => x.sandboxId === current.sandboxId)
      .sort((a, b) =>
        a.snapshotId === snap.snapshotId
          ? -1
          : b.snapshotId === snap.snapshotId
            ? 1
            : b.createdAt - a.createdAt,
      );
    for (const old of current.keepLastSnapshots
      ? previous.slice(current.keepLastSnapshots.count)
      : []) {
      if (current.keepLastSnapshots?.deleteEvicted === false) {
        old.expiration =
          old.config.snapshotExpiration ?? current.snapshotExpiration;
        old.expiresAt = old.expiration
          ? (old.updatedAt ?? old.createdAt) + old.expiration
          : null;
        this.store.put("snapshot", old.snapshotId, old);
        continue;
      }
      try {
        await this.deleteSnapshot(old.snapshotId);
      } catch {
        /* Retry expiry later; a failed cleanup must not invalidate a good snapshot. */
      }
    }
    return snap;
  }
  async fork(ref: string, options: CreateOptions): Promise<SandboxRecord> {
    const snap = await this.makeSnapshot(ref);
    return (
      await this.create({
        ...options,
        source: { type: "snapshot", snapshotId: snap.snapshotId },
      })
    ).sandbox;
  }
  async deleteSnapshot(ref: string): Promise<void> {
    const snapshotId = this.snapshot(ref).snapshotId;
    await this.locks.run(`snapshot-delete:${snapshotId}`, async () => {
      // Concurrent callers may have waited for an already successful delete.
      const s = this.store.get<SnapshotRecord>("snapshot", snapshotId);
      if (!s) return;
      invariant(
        !this.snapshotReferenced(snapshotId),
        "SNAPSHOT_IN_USE",
        "Snapshot holds a persistent filesystem or an in-flight restoration; release its references before deleting it",
        409,
      );
      if (!this.store.get("snapshot-deletion", snapshotId))
        this.store.put<SnapshotDeletion>("snapshot-deletion", snapshotId, {
          snapshotId,
          requestedAt: Date.now(),
        });
      // Intent is durable before the first provider await. A lost DELETE reply
      // must not permit any new filesystem references, including after restart.
      if (!s.nativeId && s.sourceInstanceId) {
        const native = await this.backend.findSnapshot?.(
          s.sourceInstanceId,
          s.snapshotId,
        );
        if (native) {
          s.nativeId = native.id;
          this.store.put("snapshot", s.snapshotId, s);
        }
      }
      invariant(
        s.nativeId,
        "SNAPSHOT_OUTCOME_UNKNOWN",
        "Snapshot creation outcome is still unknown; its ownership record has been retained for inspection",
        409,
      );
      try {
        await this.backend.deleteSnapshot(s.nativeId);
      } catch (error) {
        if (!(error instanceof SboxError && error.status === 404)) throw error;
      }
      this.store.transaction(() => {
        this.store.delete("snapshot", snapshotId);
        this.store.delete("snapshot-credentials", snapshotId);
        this.store.delete("snapshot-network-policy", snapshotId);
        this.store.delete("snapshot-deletion", snapshotId);
      });
      await this.cleanupDriveGenerations();
    });
  }
  async forkDrive(ref: string, name: string): Promise<DriveRecord> {
    v.string(name, "drive name", 63);
    invariant(
      /^[a-z0-9][a-z0-9-]*$/.test(name),
      "INVALID_ARGUMENT",
      "Drive names use lowercase letters, digits and hyphens",
    );
    return this.locks.run("catalog", () =>
      this.cloneDriveUnlocked(ref, name, false),
    );
  }
  private async cloneDriveUnlocked(
    ref: string,
    name?: string,
    immutable = false,
    reservationSandboxId?: string,
  ): Promise<DriveRecord> {
    const source = this.drive(ref);
    invariant(
      !source.status || source.status === "ready",
      "DRIVE_NOT_READY",
      "Source drive is not ready",
      409,
    );
    invariant(
      this.backend.cloneVolume,
      "VOLUME_CLONE_UNAVAILABLE",
      "Connected provider does not support volume copying",
      422,
    );
    if (name)
      invariant(
        !this.store.get("drive", name),
        "ALREADY_EXISTS",
        `Drive ${name} already exists`,
        409,
      );
    const capabilities = await this.backend.capabilities();
    const writer = this.store
      .all<SandboxRecord>("sandbox")
      .find(
        (s) =>
          s.instanceId &&
          Object.values(s.sessionConfig?.mounts ?? s.mounts).some(
            (m) => m.driveId === source.driveId && !m.readOnly,
          ),
      );
    invariant(
      !writer || capabilities.atomicVolumeClone === true,
      "DRIVE_IN_USE",
      "Capturing an attached writer requires the host storage companion; otherwise delete its sandbox to release the attachment",
      409,
    );
    const driveId = id(immutable ? "dgs" : "drv");
    const record: DriveRecord = {
      driveId,
      nativeId: driveId,
      name: name ?? driveId,
      sizeBytes: source.sizeBytes,
      createdAt: Date.now(),
      status: "creating",
      immutable,
      parentDriveId: source.driveId,
      rootDriveId: source.rootDriveId ?? source.driveId,
      sourceDriveId: immutable ? source.driveId : undefined,
      reservationSandboxId,
    };
    this.store.put("drive", driveId, record, record.name);
    if (reservationSandboxId)
      this.driveReservations.set(driveId, reservationSandboxId);
    try {
      const result = await this.backend.cloneVolume(
        source.nativeId,
        driveId,
        source.sizeBytes,
      );
      record.nativeId = result.id;
      record.status = "ready";
      record.updatedAt = Date.now();
      this.store.put("drive", driveId, record, record.name);
      return record;
    } catch (error) {
      record.status = "failed";
      record.error = errorMessage(error);
      this.store.put("drive", driveId, record, record.name);
      throw error;
    }
  }
  private releaseDriveReservations(owner: string) {
    for (const [drive, sandbox] of this.driveReservations)
      if (sandbox === owner) this.driveReservations.delete(drive);
  }
  private async cleanupDriveGenerations(): Promise<void> {
    const used = new Set<string>();
    for (const sandbox of this.store.all<SandboxRecord>("sandbox")) {
      if (sandbox.instanceId || sandbox.status !== "failed")
        for (const mount of [
          ...Object.values(sandbox.mounts),
          ...Object.values(
            sandbox.instanceId ? (sandbox.sessionConfig?.mounts ?? {}) : {},
          ),
        ])
          used.add(mount.driveId);
    }
    for (const snapshot of this.store.all<SnapshotRecord>("snapshot"))
      for (const mount of Object.values(snapshot.config.mounts ?? {}))
        used.add(mount.driveId);
    for (const drive of this.store.all<DriveRecord>("drive")) {
      const owner = drive.reservationSandboxId
        ? this.store.get<SandboxRecord>("sandbox", drive.reservationSandboxId)
        : undefined;
      if (
        this.driveReservations.has(drive.driveId) ||
        !drive.immutable ||
        drive.status !== "ready" ||
        used.has(drive.driveId) ||
        owner?.status === "creating"
      )
        continue;
      try {
        await this.backend.deleteVolume(drive.nativeId);
        this.store.delete("drive", drive.driveId);
      } catch {
        /* Retain the exact generation for retry after its provider attachment is released. */
      }
    }
  }
  async getOrCreateDrive(
    name: string,
    sizeBytes = 1024 ** 3,
  ): Promise<DriveRecord> {
    v.string(name, "drive name", 63);
    invariant(
      /^[a-z0-9][a-z0-9-]*$/.test(name),
      "INVALID_ARGUMENT",
      "Drive names use lowercase letters, digits and hyphens",
    );
    v.integer(sizeBytes, "sizeBytes", 1024 ** 3, 16 * 1024 ** 4);
    return this.locks.run("catalog", async () => {
      const existing = this.store.get<DriveRecord>("drive", name);
      if (existing) {
        invariant(
          !existing.status || existing.status === "ready",
          "DRIVE_NOT_READY",
          "Drive creation had an uncertain outcome; inspect or delete it before retrying",
          409,
        );
        return existing;
      }
      const driveId = id("drv"),
        rounded = Math.ceil(sizeBytes / 1024 ** 3) * 1024 ** 3;
      const drive: DriveRecord = {
        driveId,
        nativeId: driveId,
        name,
        sizeBytes: rounded,
        createdAt: Date.now(),
        status: "creating",
        rootDriveId: driveId,
      };
      this.store.put("drive", driveId, drive, name);
      try {
        const native = await this.backend.createVolume(driveId, rounded);
        drive.nativeId = native.id;
        drive.status = "ready";
        this.store.put("drive", driveId, drive, name);
        return drive;
      } catch (error) {
        drive.status = "failed";
        drive.error = errorMessage(error);
        this.store.put("drive", driveId, drive, name);
        throw error;
      }
    });
  }
  async deleteDrive(ref: string): Promise<void> {
    await this.locks.run("catalog", async () => {
      const d = this.drive(ref);
      invariant(
        !this.store
          .all<SandboxRecord>("sandbox")
          .some(
            (s) =>
              s.instanceId &&
              Object.values(s.sessionConfig?.mounts ?? s.mounts).some(
                (m) => m.driveId === d.driveId,
              ),
          ),
        "DRIVE_IN_USE",
        "Drive is attached to a sandbox",
        409,
      );
      invariant(
        !d.immutable ||
          !this.store
            .all<SnapshotRecord>("snapshot")
            .some((snapshot) =>
              Object.values(snapshot.config.mounts ?? {}).some(
                (m) => m.driveId === d.driveId,
              ),
            ),
        "DRIVE_IN_USE",
        "Captured drive is referenced by a snapshot",
        409,
      );
      if (d.status === "failed" && d.parentDriveId) {
        try {
          await this.backend.delete(
            (await this.backend.get(`${d.driveId}-copy`)).id,
          );
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "status" in error &&
              error.status === 404
            )
          )
            throw error;
        }
      }
      await this.backend.deleteVolume(d.nativeId);
      this.store.delete("drive", d.driveId);
    });
  }
  private async importSource(
    s: SandboxRecord,
    source: Exclude<NonNullable<CreateOptions["source"]>, { type: "snapshot" }>,
  ): Promise<void> {
    if (source.type === "git") {
      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
      // Extra HTTP header exists only in the exec environment and never in persisted git remotes.
      if (source.username || source.password) {
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.extraHeader";
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${source.username ?? "git"}:${source.password ?? ""}`).toString("base64")}`;
      }
      const args = [
        "clone",
        "--no-checkout",
        ...(source.depth ? ["--depth", String(source.depth)] : []),
        "--",
        source.url,
        WORKDIR,
      ];
      let result = await this.raw(s, "git", args, { env });
      if (result.exitCode !== 0)
        throw new SboxError(
          "SOURCE_FAILED",
          "Git source clone failed. Check repository access and the guest image's git installation.",
          422,
        );
      if (source.revision) {
        result = await this.raw(
          s,
          "git",
          [
            "fetch",
            "--depth",
            String(source.depth ?? 1),
            "origin",
            source.revision,
          ],
          { env },
        );
        if (result.exitCode !== 0)
          throw new SboxError(
            "SOURCE_FAILED",
            "Cannot fetch source revision",
            422,
          );
      }
      result = await this.raw(
        s,
        "git",
        ["checkout", "--detach", source.revision ? "FETCH_HEAD" : "HEAD"],
        { env },
      );
      if (result.exitCode !== 0)
        throw new SboxError(
          "SOURCE_FAILED",
          "Cannot check out source revision",
          422,
        );
    } else {
      const script = `const r=await fetch(process.argv[1]);if(!r.ok)throw Error('Source HTTP '+r.status);const path='/tmp/sbox-source-'+crypto.randomUUID()+'.tar';let n=0;const f=Bun.file(path).writer();try{for await(const c of r.body){n+=c.length;if(n>536870912)throw Error('Source exceeds 512 MiB');f.write(c)}await f.end();const p=Bun.spawn(['tar','--extract','--file',path,'--directory','/vercel/sandbox','--no-same-owner'],{stdout:'inherit',stderr:'inherit'});process.exitCode=await p.exited;}finally{await Bun.file(path).delete().catch(()=>{})}`;
      const result = await this.raw(s, "bun", ["-e", script, source.url]);
      if (result.exitCode !== 0)
        throw new SboxError(
          "SOURCE_FAILED",
          "Tarball import failed; tar is required in the guest image",
          422,
        );
    }
  }
  private async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      for (const s of this.store.all<SandboxRecord>("sandbox"))
        if (
          (s.status === "running" && s.deadline! <= Date.now()) ||
          s.status === "stopping" ||
          (s.status === "stopped" &&
            s.instanceId &&
            (!s.persistent || s.snapshotPending))
        ) {
          try {
            await this.locks.run(s.sandboxId, () =>
              this.leaseGuard(s.sandboxId, async () => {
                const current = this.get(s.sandboxId);
                if (
                  current.status === "stopping" ||
                  (current.status === "running" &&
                    current.deadline! <= Date.now()) ||
                  (current.status === "stopped" &&
                    (!current.persistent || current.snapshotPending) &&
                    current.instanceId)
                )
                  await this.stopUnlocked(current, "SANDBOX_TIMEOUT");
              }),
            );
          } catch {
            /* Keep transitional state and retry; never claim a VM was stopped on transport failure. */
          }
        }
      const deleting = new Set(
        this.store
          .all<SnapshotDeletion>("snapshot-deletion")
          .map((marker) => marker.snapshotId),
      );
      for (const snap of this.store.all<SnapshotRecord>("snapshot"))
        if (
          (deleting.has(snap.snapshotId) ||
            (snap.expiresAt && snap.expiresAt <= Date.now())) &&
          !this.snapshotReferenced(snap.snapshotId)
        ) {
          try {
            await this.deleteSnapshot(snap.snapshotId);
          } catch {
            /* Retry on next sweep. */
          }
        }
    } finally {
      this.reaping = false;
    }
  }
}
