import type { Execution } from "../backend.ts";
import { SboxError } from "../errors.ts";

/** The filename travels on stdin, never through a shell or the provider audit argv. */
export const READ_FILE_SCRIPT = `
const request = JSON.parse(await Bun.stdin.text());
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
let file, opened = false;
const write = async b => { if (!process.stdout.write(b)) await new Promise(r => process.stdout.once('drain', r)); };
try {
  file = await fs.open(request.path, constants.O_RDONLY | constants.O_NONBLOCK);
  const stat = await file.stat();
  if (!stat.isFile()) throw Object.assign(new Error('Path is not a regular file'), {code: stat.isDirectory() ? 'EISDIR' : 'EINVAL'});
  await write(JSON.stringify({size: stat.size, mode: stat.mode}) + '\\n');
  opened = true;
  const buffer = Buffer.alloc(65536);
  for (let position = 0; position < stat.size;) {
    const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
    if (!bytesRead) throw new Error('File was truncated while reading');
    await write(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
} catch (error) {
  if (!opened) await write(JSON.stringify({error: {code: error.code || 'FILESYSTEM_FAILED', message: error.message}}) + '\\n');
  process.exitCode = 1;
} finally { await file?.close(); }
`;

export const WRITE_FILE_SCRIPT = `
// SBOX_BINARY_UPLOAD
const fs = require('node:fs/promises');
const {dirname, join} = require('node:path');
let header = Buffer.alloc(0), request, file, temporary, size = 0;
try {
  for await (const bytes of process.stdin) {
    let data = Buffer.from(bytes);
    if (!request) {
      header = Buffer.concat([header, data]);
      const end = header.indexOf(10);
      if (end < 0) { if (header.length > 8192) throw new Error('Upload header too large'); continue; }
      request = JSON.parse(header.subarray(0, end).toString());
      data = header.subarray(end + 1);
      header = Buffer.alloc(0);
      await fs.mkdir(dirname(request.path), {recursive: true});
      const existing = await fs.stat(request.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && !existing.isFile()) throw Object.assign(new Error('Path is not a regular file'), {code: 'EISDIR'});
      temporary = join(dirname(request.path), '.sbox-upload-' + crypto.randomUUID());
      file = await fs.open(temporary, 'wx', request.mode ?? (existing ? existing.mode & 4095 : 438));
    }
    if (data.length) { await file.writeFile(data); size += data.length; }
  }
  if (!request) throw new Error('Missing upload header');
  if (request.size !== undefined && request.size !== size) throw new Error('Upload length does not match declared size');
  if (request.mode !== undefined) await file.chmod(request.mode);
  await file.sync(); await file.close(); file = null;
  await fs.rename(temporary, request.path); temporary = null;
  process.stdout.write(JSON.stringify({size}));
} catch (error) {
  process.stdout.write(JSON.stringify({error: {code: error.code || 'FILESYSTEM_FAILED', message: error.message}}));
  process.exitCode = 1;
} finally { await file?.close(); if (temporary) await fs.unlink(temporary).catch(() => {}); }
`;

export async function fileResponse(
  execution: Execution,
  signal?: AbortSignal,
): Promise<Response> {
  const iterator = execution.output[Symbol.asyncIterator]();
  const result = execution.exited.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const stop = () => {
    void execution.kill("SIGKILL").catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const cleanup = () => signal?.removeEventListener("abort", stop);
  let pending = Buffer.alloc(0),
    size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await iterator.next();
      if (next.done)
        throw new SboxError(
          "FILESYSTEM_FAILED",
          "File transfer ended before its header",
          502,
        );
      if (next.value.stream !== "stdout") continue;
      pending = Buffer.concat([pending, next.value.data]);
      const end = pending.indexOf(10);
      if (end < 0) {
        if (pending.length > 8192)
          throw new SboxError(
            "FILESYSTEM_FAILED",
            "Invalid file transfer header",
            502,
          );
        continue;
      }
      const header = JSON.parse(pending.subarray(0, end).toString());
      if (header.error)
        throw new SboxError(
          header.error.code,
          header.error.message,
          header.error.code === "ENOENT" ? 404 : 400,
        );
      if (!Number.isSafeInteger(header.size) || header.size < 0)
        throw new SboxError("FILESYSTEM_FAILED", "Invalid file size", 502);
      size = header.size;
      pending = pending.subarray(end + 1);
      break;
    }
  } catch (error) {
    cleanup();
    await execution.kill("SIGKILL").catch(() => {});
    throw error;
  }
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        if (pending.length) {
          received += pending.length;
          if (received > size)
            throw new SboxError(
              "FILESYSTEM_FAILED",
              "File response exceeds declared size",
              502,
            );
          controller.enqueue(pending);
          pending = Buffer.alloc(0);
          return;
        }
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            const outcome = await result;
            if ("error" in outcome) throw outcome.error;
            if (outcome.value.exitCode || received !== size)
              throw new SboxError(
                "FILESYSTEM_FAILED",
                "File transfer did not complete",
                502,
              );
            cleanup();
            controller.close();
            return;
          }
          if (next.value.stream !== "stdout") continue;
          received += next.value.data.byteLength;
          if (received > size)
            throw new SboxError(
              "FILESYSTEM_FAILED",
              "File response exceeds declared size",
              502,
            );
          controller.enqueue(next.value.data);
          return;
        }
      } catch (error) {
        cleanup();
        await execution.kill("SIGKILL").catch(() => {});
        controller.error(error);
      }
    },
    async cancel() {
      cleanup();
      await execution.kill("SIGKILL").catch(() => {});
      await iterator.return?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
    },
  });
}
