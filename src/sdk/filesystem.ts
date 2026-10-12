import { constants } from "node:fs";
import { posix } from "node:path";
import { APIError } from "../errors.ts";
import type { SignalOptions } from "./client.ts";

export interface FsContext {
  readFileToBuffer?(
    file: { path: string },
    options?: SignalOptions,
  ): Promise<Buffer | null>;
  fsOperation<T>(
    op: string,
    args: Record<string, unknown>,
    options?: SignalOptions,
  ): Promise<T>;
}
type EncodingOptions =
  | BufferEncoding
  | ({ encoding?: BufferEncoding | null } & SignalOptions)
  | null;
type WriteOptions =
  | BufferEncoding
  | ({
      encoding?: BufferEncoding;
      mode?: number;
      flag?: string;
    } & SignalOptions);
type StatsData = Record<
  | "dev"
  | "ino"
  | "mode"
  | "nlink"
  | "uid"
  | "gid"
  | "rdev"
  | "size"
  | "blksize"
  | "blocks"
  | "atimeMs"
  | "mtimeMs"
  | "ctimeMs"
  | "birthtimeMs",
  number
>;

export class SandboxStats {
  constructor(private readonly data: StatsData) {}
  get dev() {
    return this.data.dev;
  }
  get ino() {
    return this.data.ino;
  }
  get mode() {
    return this.data.mode;
  }
  get nlink() {
    return this.data.nlink;
  }
  get uid() {
    return this.data.uid;
  }
  get gid() {
    return this.data.gid;
  }
  get rdev() {
    return this.data.rdev;
  }
  get size() {
    return this.data.size;
  }
  get blksize() {
    return this.data.blksize;
  }
  get blocks() {
    return this.data.blocks;
  }
  get atimeMs() {
    return this.data.atimeMs;
  }
  get mtimeMs() {
    return this.data.mtimeMs;
  }
  get ctimeMs() {
    return this.data.ctimeMs;
  }
  get birthtimeMs() {
    return this.data.birthtimeMs;
  }
  get atime() {
    return new Date(this.atimeMs);
  }
  get mtime() {
    return new Date(this.mtimeMs);
  }
  get ctime() {
    return new Date(this.ctimeMs);
  }
  get birthtime() {
    return new Date(this.birthtimeMs);
  }
  isFile() {
    return (this.mode & constants.S_IFMT) === constants.S_IFREG;
  }
  isDirectory() {
    return (this.mode & constants.S_IFMT) === constants.S_IFDIR;
  }
  isSymbolicLink() {
    return (this.mode & constants.S_IFMT) === constants.S_IFLNK;
  }
  isBlockDevice() {
    return (this.mode & constants.S_IFMT) === constants.S_IFBLK;
  }
  isCharacterDevice() {
    return (this.mode & constants.S_IFMT) === constants.S_IFCHR;
  }
  isFIFO() {
    return (this.mode & constants.S_IFMT) === constants.S_IFIFO;
  }
  isSocket() {
    return (this.mode & constants.S_IFMT) === constants.S_IFSOCK;
  }
}
export class SandboxDirent {
  constructor(
    readonly name: string,
    readonly parentPath: string,
    private readonly type: string,
  ) {}
  get path() {
    return posix.join(this.parentPath, this.name);
  }
  isFile() {
    return this.type === "file";
  }
  isDirectory() {
    return this.type === "directory";
  }
  isSymbolicLink() {
    return this.type === "symlink";
  }
  isBlockDevice() {
    return this.type === "block";
  }
  isCharacterDevice() {
    return this.type === "character";
  }
  isFIFO() {
    return this.type === "fifo";
  }
  isSocket() {
    return this.type === "socket";
  }
}

function encodingOptions(options?: EncodingOptions) {
  return typeof options === "string" ? { encoding: options } : (options ?? {});
}
function writeOptions(options?: WriteOptions) {
  return typeof options === "string" ? { encoding: options } : (options ?? {});
}

/** Node-style filesystem operations executed inside the guest, under its user. */
export class FileSystem {
  constructor(private readonly context: FsContext) {}
  async readFile(
    path: string,
    options?: { encoding?: null; signal?: AbortSignal } | null,
  ): Promise<Buffer>;
  async readFile(
    path: string,
    options:
      | BufferEncoding
      | { encoding: BufferEncoding; signal?: AbortSignal },
  ): Promise<string>;
  async readFile(
    path: string,
    options?: EncodingOptions,
  ): Promise<string | Buffer> {
    const opts = encodingOptions(options);
    const buffer = this.context.readFileToBuffer
      ? await this.context.readFileToBuffer({ path }, opts)
      : Buffer.from(
          (
            await this.context.fsOperation<{ data: string }>(
              "readFile",
              { path },
              opts,
            )
          ).data,
          "base64",
        );
    if (buffer === null)
      throw Object.assign(
        new APIError("ENOENT", `No such file: ${path}`, 404, {
          path,
          syscall: "readFile",
        }),
        { path, syscall: "readFile" },
      );
    return opts.encoding ? buffer.toString(opts.encoding) : buffer;
  }
  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions,
  ): Promise<void> {
    await this.write("writeFile", path, data, options);
  }
  async appendFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions,
  ): Promise<void> {
    await this.write("appendFile", path, data, options);
  }
  private async write(
    op: string,
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions,
  ): Promise<void> {
    const { signal, encoding, ...opts } = writeOptions(options);
    const buffer =
      typeof data === "string"
        ? Buffer.from(data, encoding ?? "utf8")
        : Buffer.from(data);
    await this.context.fsOperation(
      op,
      { path, data: buffer.toString("base64"), options: opts },
      { signal },
    );
  }
  async mkdir(
    path: string,
    options:
      | (SignalOptions & { recursive?: boolean; mode?: number })
      | number = {},
  ): Promise<string | undefined> {
    const { signal, ...opts } =
      typeof options === "number" ? { mode: options } : options;
    return (
      (await this.context.fsOperation<string | null>(
        "mkdir",
        { path, options: opts },
        { signal },
      )) ?? undefined
    );
  }
  async readdir(
    path: string,
    options?: SignalOptions & { withFileTypes?: false },
  ): Promise<string[]>;
  async readdir(
    path: string,
    options: SignalOptions & { withFileTypes: true },
  ): Promise<SandboxDirent[]>;
  async readdir(
    path: string,
    options: SignalOptions & { withFileTypes?: boolean } = {},
  ): Promise<string[] | SandboxDirent[]> {
    const entries = await this.context.fsOperation<
      Array<{ name: string; parentPath: string; type: string }>
    >("readdir", { path }, options);
    return options.withFileTypes
      ? entries.map((e) => new SandboxDirent(e.name, e.parentPath, e.type))
      : entries.map((e) => e.name);
  }
  async stat(path: string, options?: SignalOptions) {
    return new SandboxStats(
      await this.context.fsOperation<StatsData>("stat", { path }, options),
    );
  }
  async lstat(path: string, options?: SignalOptions) {
    return new SandboxStats(
      await this.context.fsOperation<StatsData>("lstat", { path }, options),
    );
  }
  async unlink(path: string, options?: SignalOptions): Promise<void> {
    await this.context.fsOperation("unlink", { path }, options);
  }
  async rm(
    path: string,
    options: SignalOptions & {
      recursive?: boolean;
      force?: boolean;
      maxRetries?: number;
      retryDelay?: number;
    } = {},
  ): Promise<void> {
    const { signal, ...opts } = options;
    await this.context.fsOperation("rm", { path, options: opts }, { signal });
  }
  async rmdir(path: string, options?: SignalOptions): Promise<void> {
    await this.context.fsOperation("rmdir", { path }, options);
  }
  async rename(
    path: string,
    dest: string,
    options?: SignalOptions,
  ): Promise<void> {
    await this.context.fsOperation("rename", { path, dest }, options);
  }
  async copyFile(
    path: string,
    dest: string,
    options?: SignalOptions,
  ): Promise<void>;
  async copyFile(
    path: string,
    dest: string,
    mode?: number,
    options?: SignalOptions,
  ): Promise<void>;
  async copyFile(
    path: string,
    dest: string,
    modeOrOptions: number | SignalOptions = 0,
    options?: SignalOptions,
  ): Promise<void> {
    const mode = typeof modeOrOptions === "number" ? modeOrOptions : 0;
    if (typeof modeOrOptions === "object") options = modeOrOptions;
    await this.context.fsOperation("copyFile", { path, dest, mode }, options);
  }
  async access(path: string, options?: SignalOptions): Promise<void>;
  async access(
    path: string,
    mode?: number,
    options?: SignalOptions,
  ): Promise<void>;
  async access(
    path: string,
    modeOrOptions: number | SignalOptions = constants.F_OK,
    options?: SignalOptions,
  ): Promise<void> {
    const mode =
      typeof modeOrOptions === "number" ? modeOrOptions : constants.F_OK;
    if (typeof modeOrOptions === "object") options = modeOrOptions;
    await this.context.fsOperation("access", { path, mode }, options);
  }
  async exists(path: string, options?: SignalOptions): Promise<boolean> {
    try {
      await this.access(path, undefined, options);
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
        return false;
      throw error;
    }
  }
  async chmod(
    path: string,
    mode: number | string,
    options?: SignalOptions,
  ): Promise<void> {
    await this.context.fsOperation("chmod", { path, mode }, options);
  }
  async chown(
    path: string,
    uid: number,
    gid: number,
    options?: SignalOptions,
  ): Promise<void> {
    await this.context.fsOperation("chown", { path, uid, gid }, options);
  }
  async symlink(
    target: string,
    path: string,
    options?: SignalOptions,
  ): Promise<void>;
  async symlink(
    target: string,
    path: string,
    type?: "file" | "dir" | "junction",
    options?: SignalOptions,
  ): Promise<void>;
  async symlink(
    target: string,
    path: string,
    typeOrOptions?: "file" | "dir" | "junction" | SignalOptions,
    options?: SignalOptions,
  ): Promise<void> {
    const type = typeof typeOrOptions === "string" ? typeOrOptions : undefined;
    if (typeof typeOrOptions === "object") options = typeOrOptions;
    await this.context.fsOperation("symlink", { target, path, type }, options);
  }
  readlink(path: string, options?: SignalOptions): Promise<string> {
    return this.context.fsOperation("readlink", { path }, options);
  }
  realpath(path: string, options?: SignalOptions): Promise<string> {
    return this.context.fsOperation("realpath", { path }, options);
  }
  async truncate(
    path: string,
    len = 0,
    options?: SignalOptions,
  ): Promise<void> {
    await this.context.fsOperation("truncate", { path, len }, options);
  }
  mkdtemp(prefix: string, options?: SignalOptions): Promise<string> {
    return this.context.fsOperation("mkdtemp", { prefix }, options);
  }
}
