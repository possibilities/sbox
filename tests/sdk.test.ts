import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable, PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  Command,
  CommandFinished,
  Drive,
  Sandbox,
  Snapshot,
  APIError,
} from "../src/index.ts";
import { Client } from "../src/sdk/client.ts";
import type {
  CommandRecord,
  SandboxRecord,
  SnapshotRecord,
} from "../src/types.ts";

const temporarySdkFiles: string[] = [];
afterEach(async () => {
  for (const path of temporarySdkFiles.splice(0))
    await rm(path, { recursive: true, force: true });
});

function sandboxRecord(patch: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    sandboxId: "sbx-test",
    name: "test",
    status: "running",
    instanceId: "vm-test",
    sessionId: "ses-1",
    image: "test-image",
    resources: { vcpus: 2, memoryMb: 4096, diskMb: 10240 },
    timeout: 300000,
    persistent: true,
    networkPolicy: "allow-all",
    env: {},
    tags: {},
    ports: [3000],
    routes: [{ port: 3000, url: "http://test.localhost:3000" }],
    mounts: {},
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    deadline: Date.now() + 300000,
    snapshotExpiration: 0,
    keepLastSnapshots: { count: 1 },
    ...patch,
  };
}
function commandRecord(patch: Partial<CommandRecord> = {}): CommandRecord {
  return {
    commandId: "cmd-1",
    sandboxId: "sbx-test",
    sessionId: "ses-1",
    cmd: "node",
    args: [],
    cwd: "/vercel/sandbox",
    status: "running",
    exitCode: null,
    startedAt: 100,
    ...patch,
  };
}
function fakeFetch(
  handler: (
    method: string,
    params: any,
    request: Request,
  ) => unknown | Promise<unknown>,
  logs?: (request: Request) => Response,
  files?: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/logs")) return logs!(request);
    if (new URL(request.url).pathname.endsWith("/files"))
      return files!(request);
    const body = (await request.json()) as { method: string; params: any };
    return Response.json({
      result: await handler(body.method, body.params, request),
    });
  }) as typeof fetch;
}
function logsResponse(lines: unknown[]): Response {
  return new Response(
    lines
      .map((line) =>
        JSON.stringify(
          line && typeof line === "object" && "data" in line
            ? {
                ...line,
                data: Buffer.from(String(line.data)).toString("base64"),
              }
            : line,
        ),
      )
      .join("\n") + "\n",
  );
}

describe("SDK execution contract", () => {
  test("passes argv literally and resolves nonzero exit codes; shared stdout/stderr cache", async () => {
    let executions = 0,
      streams = 0;
    const finished = commandRecord({
      status: "exited",
      exitCode: 7,
      finishedAt: 150,
    });
    const fetch = fakeFetch(
      (method, params, request) => {
        expect(request.headers.get("authorization")).toBe("Bearer local-token");
        expect(request.redirect).toBe("error");
        if (method === "sandbox.create" || method === "sandbox.get")
          return sandboxRecord();
        if (method === "command.run") {
          executions++;
          expect(params.args).toEqual(["$(touch nope)", "a && b", "\n"]);
          return commandRecord();
        }
        if (method === "command.wait") return finished;
        throw new Error(method);
      },
      () => {
        streams++;
        return logsResponse([
          { sequence: 1, stream: "stdout", data: "hello\n", timestamp: 1 },
          { sequence: 2, stream: "stderr", data: "problem\n", timestamp: 2 },
          { type: "done", command: finished },
        ]);
      },
    );
    const sandbox = await Sandbox.create({ fetch, token: "local-token" });
    const result = await sandbox.runCommand("node", [
      "$(touch nope)",
      "a && b",
      "\n",
    ]);
    expect(result).toBeInstanceOf(CommandFinished);
    expect(result.exitCode).toBe(7);
    expect(result.durationMs).toBe(50);
    expect(
      await Promise.all([result.stdout(), result.stderr(), result.output()]),
    ).toEqual(["hello\n", "problem\n", "hello\nproblem\n"]);
    expect(executions).toBe(1);
    expect(streams).toBe(1);
  });

  test("recovers interrupted log streams with a replay cursor and split UTF-8", async () => {
    const after: string[] = [];
    const done = commandRecord({ status: "exited", exitCode: 0 });
    const fetch = fakeFetch(
      () => null,
      (request) => {
        const cursor = new URL(request.url).searchParams.get("after")!;
        after.push(cursor);
        const records =
          cursor === "0"
            ? JSON.stringify({
                sequence: 1,
                stream: "stdout",
                data: Buffer.from("😀").subarray(0, 2).toString("base64"),
                timestamp: 1,
              }) + '\n{"sequence":'
            : JSON.stringify({
                sequence: 1,
                stream: "stdout",
                data: Buffer.from("duplicate").toString("base64"),
                timestamp: 1,
              }) +
              "\n" +
              JSON.stringify({
                sequence: 2,
                stream: "stdout",
                data: Buffer.concat([
                  Buffer.from("😀").subarray(2),
                  Buffer.from("é"),
                ]).toString("base64"),
                timestamp: 1,
              }) +
              "\n" +
              JSON.stringify({ type: "done", command: done }) +
              "\n";
        const bytes = new TextEncoder().encode(records);
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        );
      },
    );
    const command = new Command(new Client({ fetch }), commandRecord());
    expect(await command.stdout()).toBe("😀é");
    expect(after).toEqual(["0", "1"]);
  });

  test("serializes stdin writes before EOF and never retries uncertain writes", async () => {
    const calls: string[] = [];
    const client = new Client({
      fetch: fakeFetch(async (method, params) => {
        if (method === "command.stdin") {
          calls.push(Buffer.from(params.data, "base64").toString());
          await new Promise((resolve) => setTimeout(resolve, 5));
        } else calls.push(method);
        return null;
      }),
    });
    const command = new Command(client, commandRecord());
    await Promise.all([
      command.writeStdin("first"),
      command.writeStdin("second"),
      command.closeStdin(),
    ]);
    expect(calls).toEqual(["first", "second", "command.closeStdin"]);
    await expect(command.writeStdin("late")).rejects.toMatchObject({
      code: "STDIN_CLOSED",
    });
    let attempts = 0;
    const broken = new Command(
      new Client({
        fetch: fakeFetch(() => {
          attempts++;
          throw new Error("disconnected after delivery");
        }),
      }),
      commandRecord(),
    );
    await expect(broken.writeStdin("one")).rejects.toThrow(
      "disconnected after delivery",
    );
    await expect(broken.writeStdin("two")).rejects.toThrow(
      "disconnected after delivery",
    );
    expect(attempts).toBe(1);
  });

  test("pipes Readable input, preserves binary bytes, and leaves output streams open", async () => {
    const bytes: Buffer[] = [],
      output: Buffer[] = [];
    let eof = false;
    const finished = commandRecord({ status: "exited", exitCode: 0 });
    const fetch = fakeFetch(
      async (method, params) => {
        if (method.startsWith("sandbox.")) return sandboxRecord();
        if (method === "command.run") {
          expect(params.stdin).toBe(true);
          return commandRecord();
        }
        if (method === "command.stdin") {
          bytes.push(Buffer.from(params.data, "base64"));
          return null;
        }
        if (method === "command.closeStdin") {
          eof = true;
          return null;
        }
        if (method === "command.wait") {
          while (!eof) await new Promise((resolve) => setTimeout(resolve, 1));
          return finished;
        }
        throw new Error(method);
      },
      () =>
        new Response(
          JSON.stringify({
            sequence: 1,
            stream: "stdout",
            data: "AP8K",
            timestamp: 1,
          }) +
            "\n" +
            JSON.stringify({ type: "done", command: finished }) +
            "\n",
        ),
    );
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    const source = Readable.from([
      Buffer.from([0, 255, 10]),
      Buffer.from("next"),
    ]);
    const sandbox = await Sandbox.create({ fetch });
    await sandbox.runCommand({ cmd: "cat", stdin: source, stdout: sink });
    expect(Buffer.concat(bytes)).toEqual(
      Buffer.from([0, 255, 10, 110, 101, 120, 116]),
    );
    expect(Buffer.concat(output)).toEqual(Buffer.from([0, 255, 10]));
    expect(sink.writableEnded).toBe(false);
  });

  test("process completion stops reading an endless caller stream", async () => {
    const fetch = fakeFetch((method) => {
      if (method.startsWith("sandbox.")) return sandboxRecord();
      if (method === "command.run") return commandRecord();
      if (method === "command.wait")
        return commandRecord({ status: "exited", exitCode: 0 });
      return null;
    });
    const source = new PassThrough();
    const sandbox = await Sandbox.create({ fetch });
    await sandbox.runCommand({ cmd: "true", stdin: source });
    expect(source.destroyed).toBe(false);
    expect(source.listenerCount("readable")).toBe(0);
    source.destroy();
  });

  test("an output sink failure rejects the command without uncaught stream errors", async () => {
    const finished = commandRecord({ status: "exited", exitCode: 0 });
    const fetch = fakeFetch(
      (method) => {
        if (method.startsWith("sandbox.")) return sandboxRecord();
        if (method === "command.run") return commandRecord();
        if (method === "command.wait" || method === "command.kill")
          return finished;
        throw new Error(method);
      },
      () =>
        logsResponse([
          { sequence: 1, stream: "stdout", data: "output", timestamp: 1 },
          { type: "done", command: finished },
        ]),
    );
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("sink unavailable"));
      },
    });
    const sandbox = await Sandbox.create({ fetch });
    await expect(
      sandbox.runCommand({ cmd: "echo", stdout: sink }),
    ).rejects.toThrow("sink unavailable");
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.listenerCount("error")).toBe(0);
  });

  test("a successful early exit is not replaced by an in-flight stdin error", async () => {
    const fetch = fakeFetch(async (method) => {
      if (method.startsWith("sandbox.")) return sandboxRecord();
      if (method === "command.run") return commandRecord();
      if (method === "command.stdin")
        throw new APIError("COMMAND_ENDED", "Process already exited", 409);
      if (method === "command.wait") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return commandRecord({ status: "exited", exitCode: 0 });
      }
      throw new Error(method);
    });
    const sandbox = await Sandbox.create({ fetch });
    const result = await sandbox.runCommand({
      cmd: "head",
      args: ["-c", "1"],
      stdin: Readable.from(["many bytes"]),
    });
    expect(result.exitCode).toBe(0);
  });

  test("aborting an attached command cancels waiting and signals its process", async () => {
    const controller = new AbortController();
    const kills: string[] = [];
    const fetch = fakeFetch(async (method, params, request) => {
      if (method.startsWith("sandbox.")) return sandboxRecord();
      if (method === "command.run") return commandRecord();
      if (method === "command.kill") {
        kills.push(params.signal);
        return commandRecord();
      }
      if (method === "command.wait")
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
          queueMicrotask(() => controller.abort(new Error("cancelled")));
        });
      throw new Error(method);
    });
    const sandbox = await Sandbox.create({ fetch });
    await expect(
      sandbox.runCommand({
        cmd: "sleep",
        args: ["100"],
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(kills).toEqual(["SIGTERM"]);
  });

  test("API error codes, details and status survive transport", async () => {
    const fetch = (async () =>
      Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Access denied",
            details: { scope: "command" },
          },
          requestId: "req-1",
        },
        { status: 403 },
      )) as unknown as typeof globalThis.fetch;
    await expect(Sandbox.create({ fetch })).rejects.toMatchObject({
      name: "APIError",
      code: "FORBIDDEN",
      message: "Access denied",
      status: 403,
      details: { scope: "command" },
    });
  });
});

describe("SDK lifecycle and compatibility", () => {
  test("static fork forwards configuration without leaking its source selector into create options", async () => {
    const fetch = fakeFetch((method, params) => {
      expect(method).toBe("sandbox.fork");
      expect(params).toEqual({
        id: "source",
        name: "fork",
        resources: { vcpus: 4 },
      });
      return sandboxRecord({ name: "fork" });
    });
    expect(
      (
        await Sandbox.fork({
          fetch,
          sourceSandbox: "source",
          name: "fork",
          resources: { vcpus: 4 },
        })
      ).name,
    ).toBe("fork");
  });

  test("session lifecycle always sends its fixed identity and updates its own metadata", async () => {
    let current = sandboxRecord();
    const calls: string[] = [];
    const fetch = fakeFetch((method, params) => {
      if (method === "sandbox.create") return current;
      calls.push(method);
      expect(params.id).toBe("sbx-test");
      expect(params.sessionId).toBe("ses-1");
      if (method === "sandbox.extendTimeout")
        current = { ...current, timeout: current.timeout + params.duration };
      if (method === "sandbox.update")
        current = { ...current, networkPolicy: params.networkPolicy };
      if (method === "sandbox.openInteractive")
        return { url: "ws://localhost/terminal", token: "ticket" };
      if (method === "sandbox.stop")
        current = { ...current, status: "stopped", stoppedAt: 12345 };
      return current;
    });
    const session = (await Sandbox.create({ fetch })).currentSession();
    await session.extendTimeout(1000);
    expect(session.timeout).toBe(301000);
    await session.update({ networkPolicy: "deny-all" });
    expect(session.networkPolicy).toBe("deny-all");
    expect(await session.openInteractive()).toEqual({
      url: "ws://localhost/terminal",
      token: "ticket",
    });
    const stopped = await session.stop();
    expect(stopped.session.sessionId).toBe("ses-1");
    expect(session.status).toBe("stopped");
    expect(session.stoppedAt?.getTime()).toBe(12345);
    expect(calls).toEqual([
      "sandbox.extendTimeout",
      "sandbox.update",
      "sandbox.openInteractive",
      "sandbox.stop",
    ]);
  });

  test("session snapshot retains the stopped identity even if a newer session starts", async () => {
    const snapshot: SnapshotRecord = {
      snapshotId: "snp-1",
      nativeId: "native",
      sandboxId: "sbx-test",
      sourceSessionId: "ses-1",
      name: "test",
      status: "ready",
      createdAt: 200,
      updatedAt: 201,
      expiresAt: null,
      config: {},
    };
    const fetch = fakeFetch((method, params) => {
      if (method === "sandbox.create") return sandboxRecord();
      expect(method).toBe("sandbox.snapshot");
      expect(params).toEqual({
        id: "sbx-test",
        sessionId: "ses-1",
        expiration: 0,
      });
      return snapshot;
    });
    const session = (await Sandbox.create({ fetch })).currentSession();
    const captured = await session.snapshot({ expiration: 0 });
    expect(captured.sourceSessionId).toBe("ses-1");
    expect(captured.updatedAt.getTime()).toBe(201);
    expect(captured.status).toBe("created");
    expect(session.status).toBe("stopped");
    expect(session.sessionId).toBe("ses-1");
  });

  test("snapshot metadata reports pending and failed captures instead of claiming success", async () => {
    for (const status of ["creating", "failed", "ready"] as const) {
      const fetch = fakeFetch(() => ({
        snapshotId: "snp-1",
        nativeId: "native",
        sandboxId: "sbx-test",
        name: "test",
        status,
        createdAt: 10,
        expiresAt: null,
        config: {},
      }));
      const snapshot = await Snapshot.get({ fetch, snapshotId: "snp-1" });
      expect(snapshot.status).toBe(status === "ready" ? "created" : status);
      await snapshot.delete();
      expect(snapshot.status).toBe("deleted");
    }
  });
  test("concurrent operations resume once and wait for a reentrant onResume hook", async () => {
    let current = sandboxRecord({ status: "stopped" }),
      resumes = 0,
      hooks = 0;
    const commands: string[] = [];
    const fetch = fakeFetch(async (method, params) => {
      if (method === "sandbox.get") return current;
      if (method === "sandbox.resume") {
        resumes++;
        current = sandboxRecord({ sessionId: "ses-2" });
        return current;
      }
      if (method === "command.run") {
        commands.push(params.cmd);
        return commandRecord({ cmd: params.cmd, sessionId: "ses-2" });
      }
      if (method === "command.wait")
        return commandRecord({
          status: "exited",
          exitCode: 0,
          sessionId: "ses-2",
        });
      throw new Error(method);
    });
    const sandbox = await Sandbox.get({
      name: "test",
      fetch,
      onResume: async (s) => {
        hooks++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await s.runCommand("warmup");
      },
    });
    await Promise.all([
      sandbox.runCommand("first"),
      sandbox.runCommand("second"),
    ]);
    expect(resumes).toBe(1);
    expect(hooks).toBe(1);
    expect(commands[0]).toBe("warmup");
    expect(commands.slice(1).sort()).toEqual(["first", "second"]);
  });

  test("list retains page access and supports automatic pagination", async () => {
    const fetch = fakeFetch((_method, params) =>
      params.cursor
        ? { items: [sandboxRecord({ name: "second" })], nextCursor: null }
        : { items: [sandboxRecord()], nextCursor: "next" },
    );
    const list = await Sandbox.list({ fetch, limit: 1 });
    expect(list.sandboxes[0]?.name).toBe("test");
    expect(list.pagination.next).toBe("next");
    expect((await list.toArray()).map((s) => s.name)).toEqual([
      "test",
      "second",
    ]);
    const pages = [];
    for await (const page of list.pages()) {
      pages.push(page.items.length);
      if (page.pagination.next === null)
        expect((await page.toArray()).map((s) => s.name)).toEqual(["second"]);
    }
    expect(pages).toEqual([1, 1]);
  });

  test("files preserve binary content and scoped users retain ownership", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const fetch = fakeFetch(
      (method, params) => {
        if (method.startsWith("sandbox.")) return sandboxRecord();
        calls.push({ method, params });
        return null;
      },
      undefined,
      async (request) => {
        const params = new URL(request.url).searchParams;
        expect(params.get("sessionId")).toBe("ses-1");
        if (request.method === "PUT") {
          expect(request.headers.get("content-type")).toBe(
            "application/octet-stream",
          );
          calls.push({
            method: "file.write",
            params: {
              user: params.get("user"),
              files: [
                {
                  path: params.get("path"),
                  data: Buffer.from(await request.arrayBuffer()).toString(
                    "base64",
                  ),
                  mode: Number(params.get("mode")),
                },
              ],
            },
          });
          return new Response(null, { status: 204 });
        }
        if (params.get("path")?.endsWith("missing"))
          return Response.json(
            { error: { code: "ENOENT", message: "Missing" } },
            { status: 404 },
          );
        expect(params.get("user")).toBe("alice");
        expect(params.get("path")).toBe("/home/alice/data");
        return new Response(Buffer.from([0, 255, 10]));
      },
    );
    const sandbox = await Sandbox.create({ fetch });
    const alice = sandbox.asUser("alice");
    await alice.writeFiles([
      { path: "nested/a\n'b", content: Buffer.from([0, 255, 10]), mode: 0o600 },
    ]);
    expect(calls[0]?.params).toMatchObject({
      user: "alice",
      files: [{ path: "/home/alice/nested/a\n'b", data: "AP8K", mode: 0o600 }],
    });
    expect(await alice.readFileToBuffer({ path: "data" })).toEqual(
      Buffer.from([0, 255, 10]),
    );
    expect(await sandbox.readFile({ path: "missing" })).toBeNull();
    expect(() => sandbox.asUser("-evil")).toThrow();
  });

  test("a Session rejects execution after another session resumes", async () => {
    let current = sandboxRecord();
    const sandbox = await Sandbox.create({ fetch: fakeFetch(() => current) });
    const session = sandbox.currentSession();
    current = sandboxRecord({ sessionId: "ses-2" });
    await expect(session.runCommand("echo")).rejects.toMatchObject({
      code: "SESSION_STOPPED",
    });
  });

  test("drive snapshot descriptors capture on mount and forks go through the server", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const drive = await Drive.getOrCreate({
      name: "cache",
      fetch: fakeFetch((method, params) => {
        calls.push({ method, params });
        if (method === "sandbox.create") return sandboxRecord();
        return {
          driveId: "drive-1",
          nativeId: "native",
          name: params.name,
          sizeBytes: 1024 ** 3,
          createdAt: 1,
        };
      }),
    });
    expect(drive.readOnly()).toEqual({ driveId: "drive-1", readOnly: true });
    expect(drive.snapshot()).toEqual({ drive: "cache", mode: "snapshot" });
    expect(calls).toHaveLength(1);
    expect((await drive.fork({ name: "fork" })).name).toBe("fork");
    expect(calls[1]).toEqual({
      method: "drive.fork",
      params: { id: "drive-1", name: "fork" },
    });
    const fetch = fakeFetch((_method, params) => {
      expect(params.mounts).toEqual({
        "/data": { driveId: "cache", mode: "snapshot", readOnly: true },
      });
      return sandboxRecord();
    });
    await Sandbox.create({ fetch, mounts: { "/data": drive.snapshot() } });
  });
});

describe("streaming files and resumable command observation", () => {
  test("readFile returns the first bytes before EOF and destroying it cancels the remote body", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(Uint8Array.of(0, 255, 128));
        },
        cancel() {
          cancelled();
        },
      }),
    );
    const fetch = fakeFetch(
      () => sandboxRecord(),
      undefined,
      (request) => {
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        expect(request.redirect).toBe("error");
        expect(new URL(request.url).searchParams.get("path")).toBe(
          "/vercel/sandbox/file",
        );
        return response;
      },
    );
    const sandbox = await Sandbox.create({ fetch });
    const stream = await sandbox.readFile({ path: "file" });
    expect(stream).not.toBeNull();
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.from([0, 255, 128]));
    stream!.destroy();
    await cancellation;
    // The body has been canceled without requiring its producer to send EOF.
    expect(() => controller.enqueue(Uint8Array.of(1))).toThrow();
  });

  test("downloadFile streams binary files larger than the JSON operation limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbox-sdk-download-"));
    temporarySdkFiles.push(directory);
    const chunk = Buffer.alloc(64 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;
    const expected = createHash("sha256");
    for (let i = 0; i < 320; i++) expected.update(chunk);
    let produced = 0;
    const fetch = fakeFetch(
      () => sandboxRecord(),
      undefined,
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (produced++ === 320) controller.close();
                else controller.enqueue(chunk);
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const sandbox = await Sandbox.create({ fetch });
    const target = await sandbox.downloadFile(
      { path: "large.bin" },
      { path: "nested/large.bin", cwd: directory },
      { mkdirRecursive: true },
    );
    expect(target).toBe(join(directory, "nested/large.bin"));
    expect(Bun.file(target!).size).toBe(20 * 1024 * 1024);
    const actual = createHash("sha256");
    const reader = Bun.file(target!).stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      actual.update(value);
    }
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
  });

  test("file read distinguishes a missing file from a missing sandbox", async () => {
    let code = "ENOENT";
    const fetch = fakeFetch(
      () => sandboxRecord(),
      undefined,
      () =>
        Response.json({ error: { code, message: "Missing" } }, { status: 404 }),
    );
    const sandbox = await Sandbox.create({ fetch });
    expect(await sandbox.readFile({ path: "missing" })).toBeNull();
    await expect(sandbox.fs.readFile("missing")).rejects.toMatchObject({
      code: "ENOENT",
      path: "missing",
      syscall: "readFile",
    });
    code = "NOT_FOUND";
    await expect(sandbox.readFile({ path: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  test("poll preserves binary bytes and after cursors are honored by streams", async () => {
    const record = commandRecord({ status: "exited", exitCode: 9 });
    const fetch = fakeFetch(
      (method, params) => {
        expect(method).toBe("command.poll");
        expect(params).toEqual({ id: "cmd-1", after: 7, limit: 1 });
        return {
          command: record,
          logs: [{ sequence: 8, stream: "stdout", data: "AP+A", timestamp: 1 }],
          nextCursor: 8,
          hasMore: false,
        };
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("after")).toBe("8");
        return logsResponse([{ type: "done", command: record }]);
      },
    );
    const command = new Command(new Client({ fetch }), commandRecord());
    const result = await command.poll({ after: 7, limit: 1 });
    expect(result.logs[0]!.data).toEqual(Buffer.from([0, 255, 128]));
    expect(command.exitCode).toBe(9);
    const remaining = [];
    for await (const log of command.rawLogs({ after: result.nextCursor }))
      remaining.push(log);
    expect(remaining).toEqual([]);
  });

  test("explicit log stream errors retain details and are never retried", async () => {
    let attempts = 0;
    const fetch = fakeFetch(
      () => null,
      () => {
        attempts++;
        return logsResponse([
          {
            type: "error",
            error: {
              code: "LOG_CURSOR_EXPIRED",
              message: "History expired",
              status: 409,
              details: { firstSequence: 20 },
            },
          },
        ]);
      },
    );
    const command = new Command(new Client({ fetch }), commandRecord());
    await expect(command.rawLogs({ after: 4 }).next()).rejects.toMatchObject({
      code: "LOG_CURSOR_EXPIRED",
      status: 409,
      details: { firstSequence: 20 },
    });
    expect(attempts).toBe(1);
  });

  test("an expired initial cursor keeps the earliest available sequence for recovery", async () => {
    const fetch = fakeFetch(
      () => null,
      () =>
        Response.json(
          {
            error: {
              code: "LOGS_EXPIRED",
              message: "History expired",
              details: { firstSequence: 50 },
            },
          },
          { status: 409 },
        ),
    );
    const command = new Command(new Client({ fetch }), commandRecord());
    await expect(command.rawLogs({ after: 2 }).next()).rejects.toMatchObject({
      code: "LOGS_EXPIRED",
      details: { firstSequence: 50 },
    });
  });
});
