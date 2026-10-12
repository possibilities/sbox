import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, posix } from "node:path";
import { APIError } from "../errors.ts";
import type {
  Capabilities,
  CreateOptions,
  DriveRecord,
  ListOptions,
  Mount,
  NetworkPolicy,
  Page,
  SandboxRecord,
  SessionRecord,
  SnapshotRecord,
  CommandRecord,
} from "../types.ts";
import {
  Client,
  paginate,
  type ClientOptions,
  type SignalOptions,
} from "./client.ts";
import {
  Command,
  CommandFinished,
  pipeInput,
  pipeOutput,
  type RunCommandParams,
} from "./command.ts";
import { FileSystem } from "./filesystem.ts";
import { Drive, Snapshot, listParams } from "./storage.ts";

export type SandboxMounts = Record<
  string,
  Drive | Mount | { drive: string; mode: "read-write" | "snapshot" }
>;
export interface CreateSandboxParams
  extends Omit<CreateOptions, "mounts">,
    ClientOptions,
    SignalOptions {
  mounts?: SandboxMounts;
  onResume?: (sandbox: Sandbox) => Promise<void>;
}
export interface GetSandboxParams extends ClientOptions, SignalOptions {
  name?: string;
  sandboxId?: string;
  id?: string;
  resume?: boolean;
  onResume?: (sandbox: Sandbox) => Promise<void>;
}
export interface GetOrCreateSandboxParams extends CreateSandboxParams {
  resume?: boolean;
  onCreate?: (sandbox: Sandbox) => Promise<void>;
}
export interface FileInput {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}
export interface FileLocation {
  path: string;
  cwd?: string;
}
export type UpdateSandboxParams = Partial<
  Omit<CreateOptions, "name" | "image" | "runtime" | "source" | "mounts">
> & { mounts?: SandboxMounts; currentSnapshotId?: string };

export interface ExecutionContext {
  readonly cwd: string;
  readonly fs: FileSystem;
  runCommand(
    command: string,
    args?: string[],
    options?: SignalOptions & { timeoutMs?: number },
  ): Promise<CommandFinished>;
  runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  readFile(
    file: FileLocation,
    options?: SignalOptions,
  ): Promise<Readable | null>;
  readFileToBuffer(
    file: FileLocation,
    options?: SignalOptions,
  ): Promise<Buffer | null>;
  writeFiles(files: FileInput[], options?: SignalOptions): Promise<void>;
  mkDir(path: string, options?: SignalOptions): Promise<void>;
  downloadFile(
    src: FileLocation,
    dst: FileLocation,
    options?: SignalOptions & { mkdirRecursive?: boolean },
  ): Promise<string | null>;
}

abstract class Context implements ExecutionContext {
  readonly fs = new FileSystem(this);
  abstract readonly cwd: string;
  constructor(protected readonly client: Client) {}
  protected abstract target(
    options?: SignalOptions,
  ): Promise<{ id: string; sessionId?: string; user?: string }>;

  async runCommand(
    command: string,
    args?: string[],
    options?: SignalOptions & { timeoutMs?: number },
  ): Promise<CommandFinished>;
  async runCommand(
    params: RunCommandParams & { detached: true },
  ): Promise<Command>;
  async runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    command: string | RunCommandParams,
    args: string[] = [],
    options: SignalOptions & { timeoutMs?: number } = {},
  ): Promise<Command | CommandFinished> {
    const params =
      typeof command === "string"
        ? { cmd: command, args, ...options }
        : command;
    if (!params.cmd || typeof params.cmd !== "string")
      throw new TypeError("A nonempty command is required");
    if (params.stdin === true && !params.detached)
      throw new TypeError("stdin: true requires detached: true");
    const target = await this.target(params);
    const { stdout, stderr, stdin, signal, ...exec } = params;
    const record = await this.client.rpc<CommandRecord>(
      "command.run",
      {
        ...target,
        ...exec,
        cwd: params.cwd ?? this.cwd,
        stdin: stdin instanceof Readable || stdin === true,
      },
      { signal },
    );
    const handle = new Command(this.client, record);
    const tasks: Promise<void>[] = [];
    if (stdin instanceof Readable) {
      const input = pipeInput(handle, stdin, signal);
      tasks.push(input.done);
      handle.stopInput = input.stop;
      // Stop reading an endless caller stream if the process exits first.
      this.client
        .rpc("command.wait", { id: handle.cmdId }, { signal })
        .then(input.stop, input.stop);
    }
    if (stdout || stderr)
      tasks.push(pipeOutput(handle, stdout, stderr, signal));
    if (tasks.length) {
      handle.ioCompletion = Promise.all(tasks).then(() => {});
      handle.ioFailure = handle.ioCompletion.then(
        () => new Promise<never>(() => {}),
      );
      handle.ioFailure.catch(() => {});
      handle.ioCompletion.catch(() => {
        handle.stopInput?.();
        if (!params.detached) void handle.kill().catch(() => {});
      });
    }
    if (params.detached) return handle;
    try {
      return await handle.wait({ signal });
    } catch (error) {
      handle.stopInput?.();
      if (signal?.aborted) await handle.kill().catch(() => {});
      throw error;
    }
  }

  async readFileToBuffer(
    file: FileLocation,
    options: SignalOptions = {},
  ): Promise<Buffer | null> {
    const stream = await this.readFile(file, options);
    if (stream === null) return null;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } finally {
      stream.destroy();
    }
  }
  async readFile(
    file: FileLocation,
    options: SignalOptions = {},
  ): Promise<Readable | null> {
    const target = await this.target(options);
    const stream = await this.client.readFile(target.id, this.filePath(file), {
      ...target,
      ...options,
    });
    return stream === null
      ? null
      : Readable.fromWeb(
          stream as unknown as Parameters<typeof Readable.fromWeb>[0],
          { signal: options.signal },
        );
  }
  async writeFiles(
    files: FileInput[],
    options: SignalOptions = {},
  ): Promise<void> {
    const prepared = files.map((file) => ({
      path: this.filePath(file),
      content: file.content,
      mode: file.mode,
    }));
    const target = await this.target(options);
    for (const file of prepared)
      await this.client.writeFile(
        target.id,
        file.path,
        Buffer.from(file.content),
        { ...target, ...options, mode: file.mode },
      );
  }
  async mkDir(path: string, options: SignalOptions = {}): Promise<void> {
    await this.client.rpc(
      "file.mkdir",
      { ...(await this.target(options)), path: this.filePath({ path }) },
      options,
    );
  }
  async downloadFile(
    src: FileLocation,
    dst: FileLocation,
    options: SignalOptions & { mkdirRecursive?: boolean } = {},
  ): Promise<string | null> {
    if (!dst?.path || dst.path.includes("\0"))
      throw new TypeError(
        "Destination path must be nonempty and contain no NUL characters",
      );
    const path = resolve(dst.cwd ?? process.cwd(), dst.path);
    const stream = await this.readFile(src, options);
    if (stream === null) return null;
    try {
      if (options.mkdirRecursive)
        await mkdir(dirname(path), { recursive: true });
      await pipeline(stream, createWriteStream(path), {
        signal: options.signal,
      });
      return path;
    } finally {
      stream.destroy();
    }
  }
  async fsOperation<T>(
    op: string,
    args: Record<string, unknown>,
    options: SignalOptions = {},
  ): Promise<T> {
    // Resolve destination paths, but preserve symlink targets as provided.
    const resolved = { ...args };
    for (const key of ["path", "dest", "prefix"])
      if (typeof resolved[key] === "string")
        resolved[key] = this.filePath({ path: resolved[key] as string });
    try {
      return await this.client.rpc(
        "fs",
        { ...(await this.target(options)), op, args: resolved },
        options,
      );
    } catch (error) {
      if (
        error instanceof APIError &&
        error.details &&
        typeof error.details === "object"
      ) {
        const details = error.details as { path?: unknown; syscall?: unknown };
        if (typeof details.path === "string")
          Object.assign(error, { path: details.path });
        if (typeof details.syscall === "string")
          Object.assign(error, { syscall: details.syscall });
      }
      throw error;
    }
  }
  private filePath(file: FileLocation): string {
    if (!file.path || file.path.includes("\0"))
      throw new TypeError(
        "File path must be nonempty and contain no NUL characters",
      );
    return posix.resolve(this.cwd, file.cwd ?? ".", file.path);
  }
}

export class Sandbox extends Context implements AsyncDisposable {
  readonly cwd = "/vercel/sandbox";
  private resumePromise?: Promise<void>;
  private deleted = false;
  private readonly resumeHookContext = new AsyncLocalStorage<boolean>();
  constructor(
    client: Client,
    private record: SandboxRecord,
    private readonly onResume?: (sandbox: Sandbox) => Promise<void>,
  ) {
    super(client);
  }
  get sandboxId() {
    return this.record.sandboxId;
  }
  get name() {
    return this.record.name;
  }
  get status() {
    return this.record.status;
  }
  get persistent() {
    return this.record.persistent;
  }
  get image() {
    return this.record.image;
  }
  get vcpus() {
    return this.record.resources.vcpus;
  }
  get runtime() {
    return this.record.runtime;
  }
  get memory() {
    return this.record.resources.memoryMb;
  }
  get resources() {
    return { ...this.record.resources };
  }
  get timeout() {
    return this.record.timeout;
  }
  get expiresAt() {
    return this.record.deadline === undefined
      ? undefined
      : new Date(this.record.deadline);
  }
  get tags() {
    return { ...this.record.tags };
  }
  get mounts() {
    return { ...this.record.mounts };
  }
  get routes() {
    return this.record.routes.map((route) => ({ ...route }));
  }
  get networkPolicy() {
    return this.record.networkPolicy;
  }
  get currentSnapshotId() {
    return this.record.snapshotId;
  }
  get snapshotExpiration() {
    return this.record.snapshotExpiration;
  }
  get keepLastSnapshots() {
    return this.record.keepLastSnapshots
      ? { ...this.record.keepLastSnapshots }
      : null;
  }
  get createdAt() {
    return new Date(this.record.createdAt);
  }
  get updatedAt() {
    return new Date(this.record.updatedAt);
  }
  get sessionId() {
    return this.record.sessionId;
  }
  toJSON(): SandboxRecord {
    return structuredClone(this.record);
  }

  static async create(options: CreateSandboxParams = {}): Promise<Sandbox> {
    const client = new Client(options);
    return new Sandbox(
      client,
      await client.rpc("sandbox.create", createParams(options), options),
      options.onResume,
    );
  }
  static async get(options: GetSandboxParams): Promise<Sandbox> {
    const id = options.name ?? options.sandboxId ?? options.id;
    if (!id) throw new TypeError("Sandbox.get requires name or sandboxId");
    const client = new Client(options);
    const record = await client.rpc<SandboxRecord>(
      "sandbox.get",
      { id, resume: false },
      options,
    );
    const sandbox = new Sandbox(client, record, options.onResume);
    if (options.resume) await sandbox.resume(options);
    return sandbox;
  }
  static async getOrCreate(
    options: GetOrCreateSandboxParams = {},
  ): Promise<Sandbox> {
    const client = new Client(options);
    const result = await client.rpc<{
      sandbox: SandboxRecord;
      created: boolean;
      resumed: boolean;
    }>(
      "sandbox.getOrCreate",
      { ...createParams(options), resume: options.resume },
      options,
    );
    const sandbox = new Sandbox(client, result.sandbox, options.onResume);
    if (result.created) await options.onCreate?.(sandbox);
    else if (result.resumed) await options.onResume?.(sandbox);
    else if (options.resume) await sandbox.resume(options);
    return sandbox;
  }
  static async list(options: ClientOptions & SignalOptions & ListOptions = {}) {
    const client = new Client(options);
    const fetchPage = (cursor?: string) =>
      client.rpc<Page<SandboxRecord>>(
        "sandbox.list",
        { ...listParams(options), cursor },
        options,
      );
    return paginate(
      await fetchPage(options.cursor),
      "sandboxes",
      fetchPage,
      options.signal,
    );
  }
  static async fork(
    options: CreateSandboxParams & { sourceSandbox: string },
  ): Promise<Sandbox> {
    const { sourceSandbox, ...createOptions } = options;
    const client = new Client(options);
    return new Sandbox(
      client,
      await client.rpc(
        "sandbox.fork",
        { ...createParams(createOptions), id: sourceSandbox },
        options,
      ),
      options.onResume,
    );
  }
  static async capabilities(
    options: ClientOptions & SignalOptions = {},
  ): Promise<Capabilities> {
    return new Client(options).rpc("capabilities", {}, options);
  }

  protected async target(
    options: SignalOptions = {},
  ): Promise<{ id: string; sessionId?: string }> {
    this.assertActive();
    if (!this.resumeHookContext.getStore()) await this.ensureRunning(options);
    return { id: this.sandboxId, sessionId: this.record.sessionId };
  }
  private assertActive() {
    if (this.deleted)
      throw new APIError(
        "SANDBOX_DELETED",
        "This sandbox has been deleted",
        410,
      );
  }
  private async ensureRunning(options: SignalOptions = {}): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    const resume = async () => {
      this.record = await this.client.rpc(
        "sandbox.get",
        { id: this.sandboxId },
        options,
      );
      if (this.record.status === "running") return;
      if (!this.persistent)
        throw new APIError(
          "SANDBOX_STOPPED",
          "An ephemeral sandbox cannot resume after it stops",
          409,
        );
      this.record = await this.client.rpc(
        "sandbox.resume",
        { id: this.sandboxId },
        options,
      );
      await this.resumeHookContext.run(true, async () => {
        await this.onResume?.(this);
      });
    };
    this.resumePromise = resume();
    try {
      await this.resumePromise;
    } finally {
      this.resumePromise = undefined;
    }
  }
  async resume(options: SignalOptions = {}): Promise<Sandbox> {
    this.assertActive();
    await this.ensureRunning(options);
    return this;
  }
  async refresh(options: SignalOptions = {}): Promise<Sandbox> {
    this.assertActive();
    this.record = await this.client.rpc(
      "sandbox.get",
      { id: this.sandboxId },
      options,
    );
    return this;
  }
  async stop(
    options: SignalOptions = {},
  ): Promise<SandboxRecord & { snapshot?: SnapshotRecord }> {
    this.assertActive();
    const record = await this.client.rpc<
      SandboxRecord & { snapshot?: SnapshotRecord }
    >("sandbox.stop", { id: this.sandboxId }, options);
    this.record = record;
    return structuredClone(record);
  }
  async delete(
    options: SignalOptions & { deleteOrphanSnapshots?: boolean } = {},
  ): Promise<void> {
    this.assertActive();
    await this.client.rpc(
      "sandbox.delete",
      {
        id: this.sandboxId,
        deleteOrphanSnapshots: options.deleteOrphanSnapshots,
      },
      options,
    );
    this.deleted = true;
  }
  async update(
    patch: UpdateSandboxParams,
    options: SignalOptions = {},
  ): Promise<void> {
    this.assertActive();
    this.record = await this.client.rpc(
      "sandbox.update",
      { id: this.sandboxId, ...patch, mounts: normalizeMounts(patch.mounts) },
      options,
    );
  }
  async extendTimeout(
    duration: number,
    options: SignalOptions = {},
  ): Promise<void> {
    await this.target(options);
    this.record = await this.client.rpc(
      "sandbox.extendTimeout",
      { id: this.sandboxId, duration },
      options,
    );
  }
  async updateNetworkPolicy(
    networkPolicy: NetworkPolicy,
    options: SignalOptions = {},
  ): Promise<NetworkPolicy> {
    await this.update({ networkPolicy }, options);
    return this.networkPolicy;
  }
  async snapshot(
    options: SignalOptions & { expiration?: number; name?: string } = {},
  ): Promise<Snapshot> {
    await this.target(options);
    const record = await this.client.rpc<SnapshotRecord>(
      "sandbox.snapshot",
      {
        id: this.sandboxId,
        expiration: options.expiration,
        name: options.name,
      },
      options,
    );
    await this.refresh(options);
    return new Snapshot(this.client, record);
  }
  async fork(options: CreateSandboxParams = {}): Promise<Sandbox> {
    this.assertActive();
    return new Sandbox(
      this.client,
      await this.client.rpc(
        "sandbox.fork",
        { ...createParams(options), id: this.sandboxId },
        options,
      ),
      options.onResume,
    );
  }
  domain(port: number): string {
    this.assertActive();
    const route = this.record.routes.find((route) => route.port === port);
    if (!route)
      throw new APIError(
        "PORT_NOT_EXPOSED",
        `Port ${port} is not exposed by this sandbox`,
        404,
      );
    return route.url;
  }
  async getCommand(id: string, options: SignalOptions = {}): Promise<Command> {
    this.assertActive();
    const record = await this.client.rpc<CommandRecord>(
      "command.get",
      { id },
      options,
    );
    if (record.sandboxId !== this.sandboxId)
      throw new APIError(
        "COMMAND_NOT_FOUND",
        "Command does not belong to this sandbox",
        404,
      );
    return record.exitCode === null
      ? new Command(this.client, record)
      : new CommandFinished(this.client, record);
  }
  async listCommands(options: ListOptions & SignalOptions = {}) {
    const fetchPage = (cursor?: string) =>
      this.client.rpc<Page<CommandRecord>>(
        "command.list",
        { id: this.sandboxId, ...listParams(options), cursor },
        options,
      );
    return paginate(
      await fetchPage(options.cursor),
      "commands",
      fetchPage,
      options.signal,
    );
  }
  currentSession(): Session {
    if (!this.record.sessionId || !this.record.startedAt)
      throw new APIError("NO_SESSION", "Sandbox has no session", 409);
    return new Session(
      this.client,
      {
        sessionId: this.record.sessionId,
        sandboxId: this.sandboxId,
        status: this.status,
        startedAt: this.record.startedAt,
        stoppedAt: this.record.stoppedAt,
        timeout: this.timeout,
        resources: structuredClone(
          this.record.sessionConfig?.resources ?? this.record.resources,
        ),
      },
      this.record,
    );
  }
  async listSessions(options: ListOptions & SignalOptions = {}) {
    const fetchPage = (cursor?: string) =>
      this.client.rpc<Page<SessionRecord>>(
        "sandbox.sessions",
        { id: this.sandboxId, ...listParams(options), cursor },
        options,
      );
    return paginate(
      await fetchPage(options.cursor),
      "sessions",
      fetchPage,
      options.signal,
    );
  }
  async listSnapshots(options: ListOptions & SignalOptions = {}) {
    const fetchPage = (cursor?: string) =>
      this.client.rpc<Page<SnapshotRecord>>(
        "sandbox.snapshots",
        { id: this.sandboxId, ...listParams(options), cursor },
        options,
      );
    return paginate(
      await fetchPage(options.cursor),
      "snapshots",
      fetchPage,
      options.signal,
    );
  }
  async openInteractive(
    options: SignalOptions &
      Partial<RunCommandParams> & { cols?: number; rows?: number } = {},
  ): Promise<{ url: string; token: string }> {
    const {
      signal,
      stdout: _stdout,
      stderr: _stderr,
      stdin: _stdin,
      ...exec
    } = options;
    return this.client.rpc(
      "sandbox.openInteractive",
      {
        ...(await this.target({ signal })),
        ...exec,
        cwd: exec.cwd ?? this.cwd,
      },
      { signal },
    );
  }
  asUser(username: string): SandboxUser {
    validateName(username);
    return new SandboxUser(this, username);
  }
  async createUser(
    username: string,
    options: SignalOptions = {},
  ): Promise<SandboxUser> {
    validateName(username);
    const result = await this.runCommand({
      cmd: "useradd",
      args: ["-m", "-s", "/bin/bash", "--", username],
      sudo: true,
      signal: options.signal,
    });
    if (result.exitCode === 9)
      throw new SandboxUserAlreadyExistsError(username);
    await requireSuccess(result, `Create user ${username}`);
    await requireSuccess(
      await this.runCommand({
        cmd: "chmod",
        args: ["700", `/home/${username}`],
        sudo: true,
        signal: options.signal,
      }),
      "Set user home permissions",
    );
    return this.asUser(username);
  }
  async createGroup(
    groupname: string,
    options: SignalOptions = {},
  ): Promise<{ groupname: string; sharedDir: string }> {
    validateName(groupname);
    const sharedDir = `/shared/${groupname}`;
    for (const [cmd, ...args] of [
      ["groupadd", "--", groupname],
      ["mkdir", "-p", "--", sharedDir],
      ["chown", `root:${groupname}`, "--", sharedDir],
      ["chmod", "2770", "--", sharedDir],
    ]) {
      await requireSuccess(
        await this.runCommand({
          cmd: cmd!,
          args,
          sudo: true,
          signal: options.signal,
        }),
        `Create group ${groupname}`,
      );
    }
    return { groupname, sharedDir };
  }
  async addUserToGroup(
    username: string,
    groupname: string,
    options: SignalOptions = {},
  ): Promise<void> {
    validateName(username);
    validateName(groupname);
    await requireSuccess(
      await this.runCommand({
        cmd: "usermod",
        args: ["-aG", groupname, "--", username],
        sudo: true,
        signal: options.signal,
      }),
      "Add user to group",
    );
  }
  async removeUserFromGroup(
    username: string,
    groupname: string,
    options: SignalOptions = {},
  ): Promise<void> {
    validateName(username);
    validateName(groupname);
    await requireSuccess(
      await this.runCommand({
        cmd: "gpasswd",
        args: ["-d", username, groupname],
        sudo: true,
        signal: options.signal,
      }),
      "Remove user from group",
    );
  }
  /** @internal */ async userTarget(options?: SignalOptions) {
    return this.target(options);
  }
  /** @internal */ get transport() {
    return this.client;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.deleted) await this.stop();
  }
}

/** A fixed historical execution identity. It never resumes into another session. */
export class Session extends Context {
  readonly cwd = "/vercel/sandbox";
  constructor(
    client: Client,
    private record: SessionRecord,
    private sandboxRecord: SandboxRecord,
  ) {
    super(client);
  }
  get sessionId() {
    return this.record.sessionId;
  }
  get sandboxId() {
    return this.record.sandboxId;
  }
  get status() {
    return this.record.status;
  }
  get timeout() {
    return this.record.timeout;
  }
  get startedAt() {
    return new Date(this.record.startedAt);
  }
  get createdAt() {
    return this.startedAt;
  }
  get stoppedAt() {
    return this.record.stoppedAt === undefined
      ? undefined
      : new Date(this.record.stoppedAt);
  }
  get vcpus() {
    return (
      this.record.resources ??
      this.sandboxRecord.sessionConfig?.resources ??
      this.sandboxRecord.resources
    ).vcpus;
  }
  get memory() {
    return (
      this.record.resources ??
      this.sandboxRecord.sessionConfig?.resources ??
      this.sandboxRecord.resources
    ).memoryMb;
  }
  get networkPolicy() {
    return this.sandboxRecord.networkPolicy;
  }
  get sourceSnapshotId() {
    return this.sandboxRecord.snapshotId;
  }
  get routes() {
    return this.sandboxRecord.routes.map((route) => ({ ...route }));
  }
  get expiresAt() {
    return this.record.status === "running"
      ? new Date(this.record.startedAt + this.record.timeout)
      : undefined;
  }
  protected async target(options: SignalOptions = {}) {
    const live = await this.client.rpc<SandboxRecord>(
      "sandbox.get",
      { id: this.sandboxId },
      options,
    );
    if (live.sessionId !== this.sessionId || live.status !== "running")
      throw new APIError(
        "SESSION_STOPPED",
        "This session is no longer running",
        409,
      );
    return { id: this.sandboxId, sessionId: this.sessionId };
  }
  private identity() {
    return { id: this.sandboxId, sessionId: this.sessionId };
  }
  private acceptSandbox(record: SandboxRecord): void {
    if (record.sessionId !== this.sessionId)
      throw new APIError(
        "SESSION_ENDED",
        "Response belongs to a different session",
        409,
      );
    this.sandboxRecord = record;
    this.record = {
      ...this.record,
      status: record.status,
      stoppedAt: record.stoppedAt,
      timeout: record.timeout,
    };
  }
  async stop(options: SignalOptions = {}): Promise<{
    session: SessionRecord;
    sandbox: SandboxRecord;
    snapshot?: SnapshotRecord;
  }> {
    const record = await this.client.rpc<
      SandboxRecord & { snapshot?: SnapshotRecord }
    >("sandbox.stop", this.identity(), options);
    this.acceptSandbox(record);
    return {
      session: this.toJSON(),
      sandbox: structuredClone(record),
      snapshot: record.snapshot,
    };
  }
  async update(
    patch: { networkPolicy?: NetworkPolicy },
    options: SignalOptions = {},
  ): Promise<void> {
    for (const key of Object.keys(patch))
      if (key !== "networkPolicy")
        throw new TypeError(`Session.update does not support ${key}`);
    this.acceptSandbox(
      await this.client.rpc(
        "sandbox.update",
        { ...this.identity(), ...patch },
        options,
      ),
    );
  }
  async extendTimeout(
    duration: number,
    options: SignalOptions = {},
  ): Promise<void> {
    this.acceptSandbox(
      await this.client.rpc(
        "sandbox.extendTimeout",
        { ...this.identity(), duration },
        options,
      ),
    );
  }
  async snapshot(
    options: SignalOptions & { expiration?: number } = {},
  ): Promise<Snapshot> {
    const snapshot = await this.client.rpc<SnapshotRecord>(
      "sandbox.snapshot",
      { ...this.identity(), expiration: options.expiration },
      options,
    );
    // This session was stopped even if a concurrent caller has since resumed the sandbox.
    this.record = {
      ...this.record,
      status: "stopped",
      stoppedAt: snapshot.createdAt,
    };
    return new Snapshot(this.client, snapshot);
  }
  async openInteractive(
    options: SignalOptions &
      Partial<RunCommandParams> & { cols?: number; rows?: number } = {},
  ): Promise<{ url: string; token: string }> {
    const {
      signal,
      stdin: _stdin,
      stdout: _stdout,
      stderr: _stderr,
      ...exec
    } = options;
    return this.client.rpc(
      "sandbox.openInteractive",
      { ...this.identity(), ...exec, cwd: exec.cwd ?? this.cwd },
      { signal },
    );
  }
  domain(port: number) {
    const route = this.sandboxRecord.routes.find(
      (route) => route.port === port,
    );
    if (!route)
      throw new APIError(
        "PORT_NOT_EXPOSED",
        `Port ${port} is not exposed`,
        404,
      );
    return route.url;
  }
  async getCommand(id: string, options: SignalOptions = {}): Promise<Command> {
    const record = await this.client.rpc<CommandRecord>(
      "command.get",
      { id },
      options,
    );
    if (record.sessionId !== this.sessionId)
      throw new APIError(
        "COMMAND_NOT_FOUND",
        "Command does not belong to this session",
        404,
      );
    return record.exitCode === null
      ? new Command(this.client, record)
      : new CommandFinished(this.client, record);
  }
  toJSON() {
    return structuredClone(this.record);
  }
}

export class SandboxUser extends Context {
  readonly homeDir: string;
  get cwd() {
    return this.homeDir;
  }
  constructor(
    private readonly sandbox: Sandbox,
    readonly username: string,
  ) {
    super(sandbox.transport);
    validateName(username);
    this.homeDir = username === "root" ? "/root" : `/home/${username}`;
  }
  protected async target(options?: SignalOptions) {
    return { ...(await this.sandbox.userTarget(options)), user: this.username };
  }
  addToGroup(groupname: string, options?: SignalOptions) {
    return this.sandbox.addUserToGroup(this.username, groupname, options);
  }
  removeFromGroup(groupname: string, options?: SignalOptions) {
    return this.sandbox.removeUserFromGroup(this.username, groupname, options);
  }
}
export class SandboxUserAlreadyExistsError extends Error {
  constructor(readonly username: string) {
    super(`User ${username} already exists`);
    this.name = "SandboxUserAlreadyExistsError";
  }
}

function normalizeMounts(
  mounts?: SandboxMounts,
): Record<string, Mount> | undefined {
  if (!mounts) return undefined;
  return Object.fromEntries(
    Object.entries(mounts).map(([path, value]) => {
      if (value instanceof Drive) return [path, { driveId: value.driveId }];
      if ("drive" in value) {
        return [
          path,
          {
            driveId: value.drive,
            mode: value.mode,
            readOnly: value.mode === "snapshot",
          },
        ];
      }
      return [path, value];
    }),
  );
}
function createParams(options: CreateSandboxParams): CreateOptions {
  const {
    baseUrl: _baseUrl,
    token: _token,
    fetch: _fetch,
    signal: _signal,
    onResume: _hook,
    mounts,
    ...params
  } = options;
  return { ...params, mounts: normalizeMounts(mounts) };
}
function validateName(value: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value))
    throw new TypeError(
      "User and group names must contain 1–32 lowercase letters, digits, underscores, or hyphens, starting with a letter or underscore",
    );
}
async function requireSuccess(command: CommandFinished, action: string) {
  if (command.exitCode !== 0)
    throw new APIError(
      "USER_OPERATION_FAILED",
      `${action}: ${(await command.stderr()).trim()}`,
      400,
    );
}
