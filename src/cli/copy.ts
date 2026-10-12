import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, resolve, posix, relative, sep } from "node:path";
import { Readable } from "node:stream";
import type { Sandbox } from "../index.ts";
import { UsageError } from "./args.ts";

// A fixed guest program, never shell-interpolated. The temporary file is renamed
// only after EOF and an exact length check; cancelled uploads cannot corrupt an
// existing destination. SIGKILL may leave this clearly named temporary file.
export const uploadProgram = `
const fs = require('node:fs/promises');
const path = require('node:path');
const [destination, mode, expected] = process.argv.slice(1);
const temporary = path.join(path.dirname(destination), '.sbox-upload-' + crypto.randomUUID());
let file;
try {
  file = await fs.open(temporary, 'wx', Number(mode));
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > Number(expected)) throw new Error('Source file grew during upload');
    let offset = 0;
    while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
  }
  if (size !== Number(expected)) throw new Error('Source file changed during upload');
  await file.chmod(Number(mode));
  await file.close(); file = undefined;
  await fs.rename(temporary, destination);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await file?.close(); await fs.rm(temporary, { force: true }); }
`;

interface CopyOptions {
  recursive?: boolean;
  signal?: AbortSignal;
}
const missing = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

/** Copy to the exact destination path. Traversal never follows source symlinks. */
export async function copyPath(
  sandbox: Sandbox,
  direction: "upload" | "download",
  source: string,
  destination: string,
  options: CopyOptions = {},
): Promise<void> {
  const upload = direction === "upload";
  const signal = options.signal;
  const sourcePath = upload
    ? resolve(source)
    : posix.resolve(sandbox.cwd, source);
  let destinationPath = upload
    ? posix.resolve(sandbox.cwd, destination)
    : resolve(destination);
  const sourceFs = upload ? fs : sandbox.fs;
  const destinationFs = upload ? sandbox.fs : fs;
  const sourceJoin = upload ? resolve : posix.resolve;
  const destinationJoin = upload ? posix.resolve : resolve;
  const sourceRelative = upload ? relative : posix.relative;
  const sourceSeparator = upload ? sep : "/";
  const destinationDirname = upload ? posix.dirname : dirname;
  const metadata = await sourceFs.lstat(sourcePath);
  if (metadata.isDirectory() && !options.recursive)
    throw new UsageError("Copying a directory requires --recursive (-r)");
  if (metadata.isSymbolicLink())
    throw new UsageError(
      "Copy the containing directory with --recursive to preserve symlinks",
    );

  // Canonicalize only the user-selected parent. Every descendant is inspected
  // with lstat before writing, so an existing local link cannot redirect a copy.
  const parent = destinationDirname(destinationPath);
  await destinationFs.mkdir(parent, { recursive: true });
  const canonicalParent = await destinationFs.realpath(parent);
  destinationPath = destinationJoin(
    canonicalParent,
    upload ? posix.basename(destinationPath) : basename(destinationPath),
  );

  async function existing(path: string) {
    try {
      return await destinationFs.lstat(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async function visit(from: string, to: string): Promise<void> {
    signal?.throwIfAborted();
    const entry = await sourceFs.lstat(from);
    const current = await existing(to);
    if (current?.isSymbolicLink() && !entry.isSymbolicLink())
      throw new Error(`Destination is a symlink: ${to}`);
    if (entry.isDirectory()) {
      if (current && !current.isDirectory())
        throw new Error(`Destination is not a directory: ${to}`);
      await destinationFs
        .mkdir(to, { recursive: false, mode: 0o700 })
        .catch((error) => {
          if (
            !(
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        });
      // Recheck after mkdir; do not accept a pre-existing symlink as a directory.
      const created = await destinationFs.lstat(to);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(`Unsafe destination directory: ${to}`);
      for (const name of await (upload
        ? fs.readdir(from)
        : sandbox.fs.readdir(from))) {
        if (
          typeof name !== "string" ||
          !name ||
          name === "." ||
          name === ".." ||
          /[/\\\0]/.test(name)
        )
          throw new Error("Unsafe directory entry from sandbox");
        await visit(sourceJoin(from, name), destinationJoin(to, name));
      }
      await destinationFs.chmod(to, entry.mode & 0o777);
      return;
    }
    if (entry.isSymbolicLink()) {
      const target = await sourceFs.readlink(from);
      const resolved = sourceJoin(
        upload ? dirname(from) : posix.dirname(from),
        target,
      );
      const within = sourceRelative(sourcePath, resolved);
      if (
        target.startsWith("/") ||
        /[\\\0]/.test(target) ||
        within === ".." ||
        within.startsWith(`..${sourceSeparator}`)
      )
        throw new Error(`Symlink points outside the copied directory: ${from}`);
      if (current?.isDirectory())
        throw new Error(`Cannot replace a directory with a symlink: ${to}`);
      const temporary = destinationJoin(
        destinationDirname(to),
        `.sbox-link-${crypto.randomUUID()}`,
      );
      try {
        await destinationFs.symlink(target, temporary);
        await destinationFs.rename(temporary, to);
      } finally {
        await destinationFs.rm(temporary, { force: true });
      }
      return;
    }
    if (!entry.isFile()) throw new Error(`Unsupported special file: ${from}`);
    if (current && !current.isFile())
      throw new Error(`Destination is not a regular file: ${to}`);
    if (upload) {
      const sourceFile = await fs.open(
        from,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const input = sourceFile.createReadStream({
        highWaterMark: 256 * 1024,
        signal,
      });
      let command;
      try {
        // Do not abort command creation: retain its handle so cancellation can
        // terminate an accepted remote process even if it races the response.
        command = await sandbox.runCommand({
          cmd: "bun",
          args: [
            "-e",
            uploadProgram,
            to,
            String(entry.mode & 0o777),
            String(entry.size),
          ],
          stdin: input,
          detached: true,
        });
        const terminate = () => {
          void command!.kill("SIGKILL").catch(() => {});
        };
        signal?.addEventListener("abort", terminate, { once: true });
        try {
          signal?.throwIfAborted();
          const result = await command.wait({ signal });
          if (result.exitCode)
            throw new Error(
              `Upload failed: ${(await result.stderr()).slice(0, 2048)}`,
            );
        } finally {
          signal?.removeEventListener("abort", terminate);
        }
      } catch (error) {
        await command?.kill("SIGKILL").catch(() => {});
        throw error;
      } finally {
        input.destroy();
      }
    } else {
      const temporary = destinationJoin(
        destinationDirname(to),
        `.sbox-download-${crypto.randomUUID()}`,
      );
      let input: Readable | null = null;
      const file = await fs.open(temporary, "wx", entry.mode & 0o777);
      try {
        input = await sandbox.readFile({ path: from }, { signal });
        if (!input) throw new Error(`Source file disappeared: ${from}`);
        let size = 0;
        for await (const chunk of input) {
          signal?.throwIfAborted();
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > entry.size)
            throw new Error(`Source file changed during download: ${from}`);
          let offset = 0;
          while (offset < bytes.length)
            offset += (await file.write(bytes, offset, bytes.length - offset))
              .bytesWritten;
        }
        if ((await file.stat()).size !== entry.size)
          throw new Error(`Source file changed during download: ${from}`);
        await file.chmod(entry.mode & 0o777);
        await file.close();
        await fs.rename(temporary, to);
      } finally {
        input?.destroy();
        await file.close().catch(() => {});
        await fs.rm(temporary, { force: true });
      }
    }
  }
  await visit(sourcePath, destinationPath);
}
