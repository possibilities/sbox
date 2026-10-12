import type {
  DriveRecord,
  ListOptions,
  Page,
  SnapshotRecord,
  SnapshotTreePage,
} from "../types.ts";
import {
  Client,
  paginate,
  type ClientOptions,
  type SignalOptions,
} from "./client.ts";

export class Snapshot {
  private deleted = false;
  constructor(
    private readonly client: Client,
    private readonly record: SnapshotRecord,
  ) {}
  get snapshotId() {
    return this.record.snapshotId;
  }
  get sourceSandboxId() {
    return this.record.sandboxId;
  }
  get sourceSessionId() {
    return this.record.sourceSessionId;
  }
  get sizeBytes() {
    return this.record.sizeBytes;
  }
  get createdAt() {
    return new Date(this.record.createdAt);
  }
  get updatedAt() {
    return new Date(this.record.updatedAt ?? this.record.createdAt);
  }
  get expiresAt() {
    return this.record.expiresAt === null
      ? undefined
      : new Date(this.record.expiresAt);
  }
  get parentId() {
    return this.record.parentId;
  }
  get status(): "creating" | "created" | "failed" | "deleted" {
    if (this.deleted) return "deleted";
    return !this.record.status || this.record.status === "ready"
      ? "created"
      : this.record.status;
  }
  get error() {
    return this.record.error;
  }
  toJSON() {
    return structuredClone(this.record);
  }
  static async get(
    options: ClientOptions & SignalOptions & { snapshotId: string },
  ): Promise<Snapshot> {
    const client = new Client(options);
    return new Snapshot(
      client,
      await client.rpc("snapshot.get", { id: options.snapshotId }, options),
    );
  }
  static async list(
    options: ClientOptions &
      SignalOptions &
      ListOptions & { name?: string } = {},
  ) {
    const client = new Client(options);
    const fetchPage = (cursor?: string) =>
      client.rpc<Page<SnapshotRecord>>(
        "snapshot.list",
        { ...listParams(options), cursor, name: options.name },
        options,
      );
    return paginate(
      await fetchPage(options.cursor),
      "snapshots",
      fetchPage,
      options.signal,
    );
  }
  static async tree(
    options: ClientOptions &
      SignalOptions & {
        snapshotId: string;
        sortOrder?: "asc" | "desc";
        limit?: number;
        cursor?: string;
      },
  ) {
    const client = new Client(options);
    const fetchPage = (cursor?: string) =>
      client.rpc<SnapshotTreePage>(
        "snapshot.tree",
        {
          snapshotId: options.snapshotId,
          sortOrder: options.sortOrder,
          limit: options.limit,
          cursor,
        },
        options,
      );
    const first = await fetchPage(options.cursor);
    return Object.assign(
      paginate(first, "snapshots", fetchPage, options.signal),
      { anchor: first.anchor },
    );
  }
  async delete(options: SignalOptions = {}): Promise<void> {
    await this.client.rpc("snapshot.delete", { id: this.snapshotId }, options);
    this.deleted = true;
  }
}

export class Drive {
  constructor(
    private readonly client: Client,
    private readonly record: DriveRecord,
  ) {}
  get driveId() {
    return this.record.driveId;
  }
  get name() {
    return this.record.name;
  }
  get maxSize() {
    return this.record.sizeBytes;
  }
  get sizeBytes() {
    return this.record.sizeBytes;
  }
  get createdAt() {
    return new Date(this.record.createdAt);
  }
  get updatedAt() {
    return new Date(this.record.updatedAt ?? this.record.createdAt);
  }
  get parentDriveId() {
    return this.record.parentDriveId;
  }
  get rootDriveId() {
    return this.record.rootDriveId;
  }
  get currentSessionId() {
    return this.record.currentSessionId;
  }
  get currentSandboxName() {
    return this.record.currentSandboxName;
  }
  get status() {
    return this.record.status ?? "ready";
  }
  get error() {
    return this.record.error;
  }
  toJSON() {
    return { ...this.record };
  }
  static async getOrCreate(
    options: ClientOptions &
      SignalOptions & { name: string; maxSize?: number; sizeBytes?: number },
  ): Promise<Drive> {
    const client = new Client(options);
    return new Drive(
      client,
      await client.rpc(
        "drive.getOrCreate",
        { name: options.name, sizeBytes: options.sizeBytes ?? options.maxSize },
        options,
      ),
    );
  }
  static async get(
    options: ClientOptions &
      SignalOptions & { name?: string; driveId?: string; id?: string },
  ): Promise<Drive> {
    const id = options.driveId ?? options.name ?? options.id;
    if (!id) throw new TypeError("Drive.get requires name or driveId");
    const client = new Client(options);
    return new Drive(client, await client.rpc("drive.get", { id }, options));
  }
  static async list(options: ClientOptions & SignalOptions & ListOptions = {}) {
    const client = new Client(options);
    const fetchPage = async (cursor?: string) => {
      const page = await client.rpc<Page<DriveRecord>>(
        "drive.list",
        { ...listParams(options), cursor },
        options,
      );
      return {
        ...page,
        items: page.items.map((record) => new Drive(client, record)),
      };
    };
    return paginate(
      await fetchPage(options.cursor),
      "drives",
      fetchPage,
      options.signal,
    );
  }
  /** The immutable view is captured when this descriptor is mounted. */
  snapshot(): { drive: string; mode: "snapshot" } {
    return { drive: this.name, mode: "snapshot" };
  }
  /** A read-only live mount, explicitly distinct from a point-in-time snapshot. */
  readOnly() {
    return { driveId: this.driveId, readOnly: true as const };
  }
  async fork(options: { name: string } & SignalOptions): Promise<Drive> {
    return new Drive(
      this.client,
      await this.client.rpc(
        "drive.fork",
        { id: this.driveId, name: options.name },
        options,
      ),
    );
  }
  async delete(options: SignalOptions = {}): Promise<void> {
    await this.client.rpc("drive.delete", { id: this.driveId }, options);
  }
}

export function listParams(options: ListOptions): ListOptions {
  return {
    limit: options.limit,
    cursor: options.cursor,
    tags: options.tags,
    namePrefix: options.namePrefix,
    name: options.name,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
  };
}
