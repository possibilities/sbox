import { afterEach, describe, expect, test } from "bun:test";
import {
  HypemanBackend,
  HypemanClient,
  HypemanError,
} from "../src/hypeman/index.ts";
import {
  bridgeCommand,
  BridgeDecoder,
  bridgeInput,
  bridgeStart,
  type BridgeFrame,
} from "../src/hypeman/bridge.ts";
import type { BackendCreate } from "../src/backend.ts";
import { SboxError } from "../src/errors.ts";
import { CREDENTIAL_MANIFEST } from "../src/hypeman/credentials.ts";
import type {
  NativeExecOptions,
  NativeExecSession,
} from "../src/hypeman/client.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mockServer(
  onMessage: (socket: any, data: string | Buffer) => void,
  onFetch?: (request: Request) => Response | undefined,
) {
  const server = Bun.serve<{ path: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const response = onFetch?.(request);
      if (response) return response;
      if (
        server.upgrade(request, {
          data: { path: new URL(request.url).pathname },
        })
      )
        return;
      return Response.json({});
    },
    websocket: { message: onMessage },
  });
  cleanups.push(() => server.stop(true));
  return new HypemanClient({
    baseUrl: server.url.toString(),
    apiKey: "test-token",
    timeoutMs: 2_000,
  });
}

describe("Hypeman native transport", () => {
  test("authenticates WebSockets, separates text control from arbitrary binary output, and resizes PTYs", async () => {
    const received: unknown[] = [];
    let authenticated = false;
    const client = mockServer(
      (socket, data) => {
        if (typeof data === "string") {
          const value = JSON.parse(data);
          received.push(value);
          if (value.resize) {
            socket.send(Buffer.from([0, 255, 10, 13]));
            socket.send(JSON.stringify({ exitCode: 17 }));
          }
        } else received.push([...data]);
      },
      (request) => {
        authenticated =
          request.headers.get("authorization") === "Bearer test-token" &&
          !request.url.includes("test-token");
        return undefined;
      },
    );
    const chunks: Uint8Array[] = [];
    const session = await client.exec(
      "vm/id",
      { command: ["sh"], tty: true },
      (data) => chunks.push(data),
    );
    session.write(new Uint8Array([0, 1, 255]));
    session.resize(50, 120);
    expect(await session.completion).toBe(17);
    expect(authenticated).toBe(true);
    expect(received).toEqual([
      { command: ["sh"], tty: true },
      [0, 1, 255],
      { resize: { rows: 50, cols: 120 } },
    ]);
    expect([...Buffer.concat(chunks)]).toEqual([0, 255, 10, 13]);
  });

  test("rejects a stream that disconnects without an exit status", async () => {
    const client = mockServer((socket) => socket.close());
    const session = await client.exec("vm", { command: ["true"] }, () => {});
    await expect(session.completion).rejects.toThrow("before an exit status");
  });

  test("uploads and downloads binary files using native cp framing", async () => {
    const payload = crypto.getRandomValues(new Uint8Array(128 * 1024 + 7));
    const uploads: Buffer[] = [];
    const client = mockServer((socket, data) => {
      if (typeof data !== "string") {
        uploads.push(data);
        return;
      }
      const message = JSON.parse(data);
      if (message.direction === "from") {
        socket.send(
          JSON.stringify({
            type: "header",
            path: "/data.bin",
            mode: 420,
            is_dir: false,
            size: payload.length,
          }),
        );
        socket.send(payload.subarray(0, 101));
        socket.send(payload.subarray(101));
        socket.send(JSON.stringify({ type: "end", final: true }));
      } else if (message.type === "end")
        socket.send(
          JSON.stringify({
            type: "result",
            success: true,
            bytes_written: payload.length,
          }),
        );
    });
    await client.writeFile("vm", "/data.bin", payload);
    expect(Buffer.concat(uploads)).toEqual(Buffer.from(payload));
    expect(Buffer.from(await client.readFile("vm", "/data.bin"))).toEqual(
      Buffer.from(payload),
    );
  });

  test("rejects incomplete downloads and oversized files", async () => {
    const client = mockServer((socket) => {
      socket.send(
        JSON.stringify({
          type: "header",
          path: "/a",
          mode: 420,
          is_dir: false,
          size: 4,
        }),
      );
      socket.send(Buffer.from("a"));
      socket.send(JSON.stringify({ type: "end", final: true }));
    });
    await expect(client.readFile("vm", "/a")).rejects.toThrow(
      "size did not match",
    );
    await expect(client.readFile("vm", "/a", 2)).rejects.toThrow(
      "transfer limit",
    );
  });

  test("REST errors preserve HTTP status and code, and redirects cannot leak credentials", async () => {
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      fetch: (async (_url: unknown, options: RequestInit) => {
        expect(options.redirect).toBe("error");
        return Response.json(
          { code: "invalid_state", message: "Instance must be running" },
          { status: 409 },
        );
      }) as typeof fetch,
    });
    try {
      await client.request("GET", "/instances/a");
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HypemanError);
      expect((error as HypemanError).status).toBe(409);
      expect((error as HypemanError).code).toBe("invalid_state");
    }
  });
});

describe("Bun guest command bridge", () => {
  test("receives command setup over stdin so secrets and large arguments stay out of provider audit argv", async () => {
    const args = bridgeCommand();
    expect(args).not.toContain("private-secret");
    const child = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(() => child.kill());
    const reader = child.stdout.getReader();
    const decoder = new BridgeDecoder();
    const frames: BridgeFrame[] = [];
    const readFrames = async () => {
      const next = await reader.read();
      if (next.done)
        throw new Error("Command bridge ended before becoming ready");
      frames.push(...decoder.push(next.value));
    };
    while (!frames.some((frame) => frame.type === "ready")) await readFrames();
    child.stdin.write(
      bridgeStart({
        command: [
          process.execPath,
          "-e",
          'console.log(process.env.PRIVATE_VALUE + ":" + process.argv.slice(1).map(a => a.length).join(","))',
          "--",
          ...Array(3).fill("x".repeat(60_000)),
        ],
        env: { PRIVATE_VALUE: "private-secret" },
      }),
    );
    while (!frames.some((frame) => frame.type === "started"))
      await readFrames();
    child.stdin.write(bridgeInput("eof"));
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      frames.push(...decoder.push(next.value));
    }
    expect(await child.exited).toBe(0);
    expect(
      Buffer.concat(
        frames.flatMap((frame) =>
          frame.type === "stdout" ? [Buffer.from(frame.data, "base64")] : [],
        ),
      ).toString(),
    ).toBe("private-secret:60000,60000,60000\n");
  });

  test("streams before exit, preserves separate binary stdout/stderr, and supports stdin EOF", async () => {
    const child = Bun.spawn(
      bridgeCommand({
        command: [
          process.execPath,
          "-e",
          'process.stdout.write(Buffer.from([0,255,1]));process.stderr.write("warning");const data=await Bun.stdin.bytes();process.stdout.write(data)',
        ],
      }),
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    cleanups.push(() => child.kill());
    const reader = child.stdout.getReader();
    const decoder = new BridgeDecoder();
    const frames: BridgeFrame[] = [];
    while (!frames.some((frame) => frame.type === "stdout")) {
      const value = await reader.read();
      expect(value.done).toBe(false);
      frames.push(...decoder.push(value.value!));
    }
    expect(child.exitCode).toBeNull();
    child.stdin.write(bridgeInput("stdin", new Uint8Array([2, 0, 128, 13])));
    child.stdin.write(bridgeInput("eof"));
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      frames.push(...decoder.push(value.value));
    }
    decoder.finish();
    expect(await child.exited).toBe(0);
    const stdout = Buffer.concat(
      frames.flatMap((frame) =>
        frame.type === "stdout" ? [Buffer.from(frame.data, "base64")] : [],
      ),
    );
    const stderr = Buffer.concat(
      frames.flatMap((frame) =>
        frame.type === "stderr" ? [Buffer.from(frame.data, "base64")] : [],
      ),
    );
    expect([...stdout]).toEqual([0, 255, 1, 2, 0, 128, 13]);
    expect(stderr.toString()).toBe("warning");
    expect(frames.at(-1)).toMatchObject({ type: "exit", exitCode: 0 });
  });

  test("kills the command process group and reports the signal exit status", async () => {
    const child = Bun.spawn(
      bridgeCommand({
        command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      }),
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    cleanups.push(() => child.kill());
    const reader = child.stdout.getReader();
    const decoder = new BridgeDecoder();
    const frames: BridgeFrame[] = [];
    while (!frames.some((frame) => frame.type === "started"))
      frames.push(...decoder.push((await reader.read()).value!));
    child.stdin.write(bridgeInput("signal", "SIGKILL"));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(...decoder.push(value));
    }
    expect(await child.exited).toBe(0);
    expect(frames.at(-1)).toMatchObject({
      type: "exit",
      exitCode: 137,
      signal: "SIGKILL",
    });
  });

  test("incremental decoder handles split frames and rejects truncated framing", () => {
    const decoder = new BridgeDecoder();
    expect(decoder.push(Buffer.from('{"type":"std'))).toEqual([]);
    expect(
      decoder.push(Buffer.from('out","data":"AA=="}\n{"type":"ex')),
    ).toEqual([{ type: "stdout", data: "AA==" }]);
    expect(() => decoder.finish()).toThrow("partial frame");
  });

  test("does not inherit transport or removed environment values into command children", async () => {
    const child = Bun.spawn(
      bridgeCommand({
        command: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify(process.env))",
        ],
        env: { ONLY_EXPLICIT: "yes" },
      }),
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SBOX_TRANSPORT_SECRET_TEST: "must-not-leak" },
      },
    );
    cleanups.push(() => child.kill());
    child.stdin.write(bridgeInput("eof"));
    const decoder = new BridgeDecoder();
    const frames = decoder.push(await new Response(child.stdout).bytes());
    expect(await child.exited).toBe(0);
    const stdout = frames.flatMap((frame) =>
      frame.type === "stdout" ? [Buffer.from(frame.data, "base64")] : [],
    );
    const env = JSON.parse(Buffer.concat(stdout).toString());
    expect(env.ONLY_EXPLICIT).toBe("yes");
    expect(env.SBOX_TRANSPORT_SECRET_TEST).toBeUndefined();
  });
});

describe("Hypeman backend safety", () => {
  const options: BackendCreate = {
    name: "test",
    image: "oven/bun:1-debian",
    resources: { vcpus: 2, memoryMb: 1024, diskMb: 10240 },
    env: {},
    mounts: [],
    deadline: Date.now() + 60_000,
    networkPolicy: "allow-all",
  };

  test("rejects unsupported network restrictions before any resource request", async () => {
    let requests = 0;
    const backend = new HypemanBackend({
      baseUrl: "http://localhost:4973",
      fetch: (async () => {
        requests++;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await expect(
      backend.create({
        ...options,
        networkPolicy: { allow: { "api.example.com": [] } },
      }),
    ).rejects.toThrow("allow-all and deny-all");
    expect(requests).toBe(0);
  });

  test("keeps native deletion TTL disabled and uses a disk-preserving guest deadline", async () => {
    let created: Record<string, any> | undefined;
    const client = mockServer(
      (socket, data) => {
        if (typeof data === "string")
          socket.send(JSON.stringify({ exitCode: 0 }));
      },
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/exec")) return undefined;
        if (request.method === "POST" && path === "/instances") {
          // Bun.serve accepts async handlers, but capture request data below through cloned fetch.
          return Response.json({ id: "new-vm", state: "Running" });
        }
        return Response.json({ id: "new-vm", state: "Running" });
      },
    );
    const realRequest = client.request.bind(client);
    client.request = async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (path === "/instances" && method === "POST")
        created = body as Record<string, any>;
      return realRequest<T>(method, path, body);
    };
    const backend = new HypemanBackend(client);
    await backend.create(options);
    expect(created?.ttl).toBeUndefined();
    expect(created?.expires_at).toBeUndefined();
    expect(created?.entrypoint[2]).toContain("/run/sbox/deadline");
    expect(created?.cmd).toEqual([String(options.deadline)]);
    expect(created?.network).toEqual({ enabled: true });
    expect(created?.restart_policy).toEqual({ policy: "never" });
  });

  test("supports released Hypeman without overstating runtime capability verification", async () => {
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      fetch: (async (url: string) => {
        if (url.endsWith("/capabilities"))
          return new Response("404 page not found", { status: 404 });
        return Response.json([]);
      }) as typeof fetch,
    });
    const caps = await new HypemanBackend(client).capabilities();
    expect(caps.snapshots).toBe(true);
    expect(caps.volumes).toBe(true);
    expect(caps.runtimeCapabilitiesVerified).toBe(false);
  });

  test("converts volume sizes using Hypeman GiB units", async () => {
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      fetch: (async (_url: string, request: RequestInit) => {
        expect(JSON.parse(String(request.body)).size_gb).toBe(1);
        expect(JSON.parse(String(request.body)).id).toBe("volume");
        return Response.json({ id: "volume" });
      }) as typeof fetch,
    });
    expect(
      await new HypemanBackend(client).createVolume("volume", 1024 ** 3),
    ).toEqual({ id: "volume" });
  });

  test("resource deletes are idempotent only for confirmed HTTP 404", async () => {
    let status = 404;
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      fetch: (async () =>
        Response.json(
          { message: "failure" },
          { status },
        )) as unknown as typeof fetch,
    });
    const backend = new HypemanBackend(client);
    await backend.delete("missing");
    await backend.deleteSnapshot("missing");
    await backend.deleteVolume("missing");
    status = 503;
    await expect(backend.delete("unknown")).rejects.toBeInstanceOf(
      HypemanError,
    );
    await expect(backend.deleteSnapshot("unknown")).rejects.toBeInstanceOf(
      HypemanError,
    );
    await expect(backend.deleteVolume("unknown")).rejects.toBeInstanceOf(
      HypemanError,
    );
  });

  test("stopping a halted guest releases its VMM while an already stopped instance is untouched", async () => {
    let state = "Shutdown";
    const requests: Array<{ method: string; path: string }> = [];
    const client = new HypemanClient({
      baseUrl: "http://native.invalid",
      fetch: (async (input: string, init: RequestInit) => {
        requests.push({ method: init.method!, path: new URL(input).pathname });
        if (init.method === "POST") state = "Stopped";
        return Response.json({ id: "vm/id", state });
      }) as unknown as typeof fetch,
    });
    const backend = new HypemanBackend(client);
    await backend.stop("vm/id");
    expect(state).toBe("Stopped");
    expect(requests).toEqual([
      { method: "GET", path: "/instances/vm%2Fid" },
      { method: "POST", path: "/instances/vm%2Fid/stop" },
    ]);
    await backend.stop("vm/id");
    expect(requests.at(-1)).toEqual({
      method: "GET",
      path: "/instances/vm%2Fid",
    });
    expect(requests.filter((value) => value.method === "POST")).toHaveLength(1);
    expect(requests.some((value) => value.method === "DELETE")).toBe(false);
  });

  test("Shutdown during startup remains a boot failure and cleans the failed instance without starting guest commands", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const client = new HypemanClient({
      baseUrl: "http://native.invalid",
      fetch: (async (input: string, init: RequestInit) => {
        requests.push({ method: init.method!, path: new URL(input).pathname });
        return Response.json({ id: "failed-boot", state: "Shutdown" });
      }) as unknown as typeof fetch,
    });
    let guestCommands = 0;
    client.exec = async () => {
      guestCommands++;
      throw Error("Must not bootstrap a halted guest");
    };
    const backend = new HypemanBackend(client);
    await expect(
      backend.create({
        name: "boot-failure",
        image: "oven/bun:1-debian",
        resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
        env: {},
        networkPolicy: "deny-all",
        mounts: [],
        deadline: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ code: "guest_boot_failed" });
    expect(guestCommands).toBe(0);
    expect(requests).toEqual([
      { method: "POST", path: "/instances" },
      { method: "GET", path: "/instances/failed-boot" },
      { method: "DELETE", path: "/instances/failed-boot" },
    ]);
  });

  test("uncertain snapshot recovery requires an exact source and name match", async () => {
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      fetch: (async (url: string) => {
        expect(new URL(url).searchParams.get("source_instance_id")).toBe(
          "source",
        );
        return Response.json([
          {
            id: "wrong-source",
            source_instance_id: "another",
            name: "checkpoint",
          },
          { id: "wrong-name", source_instance_id: "source", name: "other" },
          {
            id: "correct",
            source_instance_id: "source",
            name: "checkpoint",
            size_bytes: 123,
          },
        ]);
      }) as typeof fetch,
    });
    const backend = new HypemanBackend(client);
    expect(await backend.findSnapshot("source", "checkpoint")).toEqual({
      id: "correct",
      sizeBytes: 123,
    });
    expect(await backend.findSnapshot("source", "absent")).toBeNull();
  });
});

describe("Hypeman root filesystem snapshot carrier recovery", () => {
  const sourceId = "native-mounted-source";
  const snapshotName = `snp-${"a".repeat(24)}`;
  const carrierName = `${snapshotName}-capture`;
  const image = `example.com/runtime@sha256:${"b".repeat(64)}`;
  type Native = {
    id: string;
    name: string;
    state: string;
    volumes: unknown[];
    [key: string]: unknown;
  };
  type Capture = {
    id: string;
    name: string;
    source_instance_id: string;
    source_instance_name: string;
    size_bytes: number;
  };

  function fixture(reuse = false) {
    const instances = new Map<string, Native>([
      [
        sourceId,
        {
          id: sourceId,
          name: `sbx-${"c".repeat(24)}`,
          state: "Running",
          volumes: [
            {
              volume_id: "native-drive",
              mount_path: "/mnt/cache",
              readonly: false,
            },
          ],
        },
      ],
    ]);
    if (reuse)
      instances.set("recovered-carrier", {
        id: "recovered-carrier",
        name: carrierName,
        state: "Stopped",
        volumes: [],
      });
    const captures: Capture[] = [];
    const requests: Array<{
      host: string;
      method: string;
      path: string;
      body: any;
    }> = [];
    const faults = {
      lostCreateReply: false,
      lostCaptureReply: false,
      deleteUnavailable: false,
    };
    let created = 0;
    const client = new HypemanClient({
      baseUrl: "http://native.invalid",
      apiKey: "carrier-native-token",
      storageUrl: "http://storage.invalid",
      storageToken: "carrier-storage-token",
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input)),
          method = init.method ?? "GET";
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({
          host: url.hostname,
          method,
          path: url.pathname + url.search,
          body,
        });
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("authorization")).toBe(
          url.hostname === "native.invalid"
            ? "Bearer carrier-native-token"
            : "Bearer carrier-storage-token",
        );
        if (url.hostname === "storage.invalid") {
          if (url.pathname === "/v1/capabilities")
            return Response.json({ protocol: 1, rootfsTransplant: true });
          if (url.pathname === `/v1/rootfs/instances/${sourceId}`)
            return Response.json({
              resolvedImage: image,
              platform: "linux/arm64",
              sizeBytes: 1024 ** 3,
            });
          if (url.pathname === "/v1/rootfs/install") {
            expect(instances.get(body.targetId)?.state).toBe("Stopped");
            expect(body.source).toEqual({ instanceId: sourceId });
            return Response.json({ id: body.targetId, sizeBytes: 1024 ** 3 });
          }
        } else {
          if (url.pathname === "/capabilities")
            return Response.json({
              default_runtime: { name: "vz", available: true },
              runtimes: [
                { name: "vz", available: true, features: ["snapshots"] },
              ],
              features: ["exec", "volumes"],
              host: { os: "darwin", arch: "arm64" },
              server: { version: "test", api_version: "1" },
            });
          if (url.pathname === "/spec.json")
            return Response.json({ components: { schemas: {} } });
          if (url.pathname === "/snapshots") return Response.json(captures);
          if (url.pathname === "/instances" && method === "POST") {
            const native: Native = {
              ...body,
              id: `created-carrier-${++created}`,
              state: "Running",
            };
            instances.set(native.id, native);
            if (faults.lostCreateReply) {
              faults.lostCreateReply = false;
              throw Error("create response lost");
            }
            return Response.json(native);
          }
          const parts = url.pathname.split("/");
          if (parts[1] === "instances") {
            const ref = decodeURIComponent(parts[2]!);
            const native =
              instances.get(ref) ??
              [...instances.values()].find((value) => value.name === ref);
            if (!native)
              return Response.json(
                { code: "not_found", message: "Missing native instance" },
                { status: 404 },
              );
            if (method === "GET") return Response.json(native);
            if (method === "DELETE") {
              if (faults.deleteUnavailable)
                return Response.json(
                  {
                    code: "cleanup_unavailable",
                    message: "Temporary carrier cleanup failure",
                  },
                  { status: 503 },
                );
              instances.delete(native.id);
              return Response.json({});
            }
            if (parts[3] === "stop") {
              native.state = "Stopped";
              return Response.json(native);
            }
            if (parts[3] === "snapshots") {
              const captured = {
                id: `native-capture-${captures.length + 1}`,
                name: body.name,
                source_instance_id: native.id,
                source_instance_name: native.name,
                size_bytes: 12345,
              };
              captures.push(captured);
              if (faults.lostCaptureReply) {
                faults.lostCaptureReply = false;
                throw Error("capture response lost");
              }
              return Response.json(captured);
            }
          }
        }
        throw Error(
          `Unexpected mocked carrier request ${method} ${url.hostname}${url.pathname}`,
        );
      }) as unknown as typeof fetch,
    });
    client.exec = async () => ({
      completion: Promise.resolve(0),
      write() {},
      resize() {},
      close() {},
    });
    return {
      backend: new HypemanBackend(client),
      instances,
      captures,
      requests,
      faults,
    };
  }

  test("reuses the exact deterministic carrier without creating another VM", async () => {
    const f = fixture(true);
    expect(await f.backend.snapshot(sourceId, snapshotName)).toEqual({
      id: "native-capture-1",
      sizeBytes: 12345,
    });
    expect(
      f.requests.filter(
        (value) => value.method === "POST" && value.path === "/instances",
      ),
    ).toHaveLength(0);
    expect(
      f.requests.find((value) => value.path === "/v1/rootfs/install")?.body,
    ).toEqual({
      source: { instanceId: sourceId },
      targetId: "recovered-carrier",
    });
    expect(f.captures[0]?.source_instance_id).toBe("recovered-carrier");
    expect([...f.instances.keys()]).toEqual([sourceId]);
    expect(f.instances.get(sourceId)?.volumes).toHaveLength(1);
  });

  test("a recovered capture releases its carrier before reporting success and never recopies", async () => {
    const f = fixture(true);
    f.captures.push({
      id: "existing-capture",
      name: snapshotName,
      source_instance_id: "recovered-carrier",
      source_instance_name: carrierName,
      size_bytes: 99,
    });
    expect(await f.backend.snapshot(sourceId, snapshotName)).toEqual({
      id: "existing-capture",
      sizeBytes: 99,
    });
    expect(f.instances.has("recovered-carrier")).toBe(false);
    expect(
      f.requests.some((value) => value.path === "/v1/rootfs/install"),
    ).toBe(false);
    expect(
      f.requests.some(
        (value) => value.method === "POST" && value.path.endsWith("/snapshots"),
      ),
    ).toBe(false);
    expect(f.captures).toHaveLength(1);
  });

  test("an accepted carrier create with a lost reply is resolved by its exact name and cleaned up", async () => {
    const f = fixture();
    f.faults.lostCreateReply = true;
    await expect(
      f.backend.snapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "hypeman_unreachable" });
    expect([...f.instances.keys()]).toEqual([sourceId]);
    const createdIndex = f.requests.findIndex(
      (value) => value.method === "POST" && value.path === "/instances",
    );
    expect(f.requests[createdIndex]?.body).toMatchObject({
      name: carrierName,
      image,
      volumes: [],
      network: { enabled: false },
    });
    expect(
      f.requests
        .slice(createdIndex + 1)
        .map((value) => [value.method, value.path]),
    ).toEqual([
      ["GET", `/instances/${carrierName}`],
      ["DELETE", "/instances/created-carrier-1"],
    ]);
    expect(f.captures).toHaveLength(0);
  });

  test("cleanup failure keeps recovery incomplete and a later retry reuses the one committed capture", async () => {
    const f = fixture(true);
    f.faults.deleteUnavailable = true;
    await expect(
      f.backend.snapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "cleanup_unavailable" });
    expect(f.captures).toHaveLength(1);
    expect(f.instances.has("recovered-carrier")).toBe(true);
    await expect(
      f.backend.findSnapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "cleanup_unavailable" });
    expect(f.instances.has("recovered-carrier")).toBe(true);
    f.faults.deleteUnavailable = false;
    expect(await f.backend.snapshot(sourceId, snapshotName)).toEqual({
      id: "native-capture-1",
      sizeBytes: 12345,
    });
    expect(f.instances.has("recovered-carrier")).toBe(false);
    expect(f.captures).toHaveLength(1);
    expect(
      f.requests.filter((value) => value.path === "/v1/rootfs/install"),
    ).toHaveLength(1);
  });

  test("lost create response and failed cleanup retain the deterministic carrier for the next capture attempt", async () => {
    const f = fixture();
    f.faults.lostCreateReply = true;
    f.faults.deleteUnavailable = true;
    await expect(
      f.backend.snapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "hypeman_unreachable" });
    expect(f.instances.get("created-carrier-1")?.name).toBe(carrierName);
    expect(f.captures).toHaveLength(0);
    f.faults.deleteUnavailable = false;
    expect(await f.backend.snapshot(sourceId, snapshotName)).toEqual({
      id: "native-capture-1",
      sizeBytes: 12345,
    });
    expect(
      f.requests.filter(
        (value) => value.method === "POST" && value.path === "/instances",
      ),
    ).toHaveLength(1);
    expect(f.captures[0]?.source_instance_id).toBe("created-carrier-1");
    expect([...f.instances.keys()]).toEqual([sourceId]);
  });

  test("recovering an ordinary source snapshot never deletes the source VM", async () => {
    const f = fixture();
    f.captures.push({
      id: "native-direct-snapshot",
      name: snapshotName,
      source_instance_id: sourceId,
      source_instance_name: f.instances.get(sourceId)!.name,
      size_bytes: 321,
    });
    expect(await f.backend.findSnapshot(sourceId, snapshotName)).toEqual({
      id: "native-direct-snapshot",
      sizeBytes: 321,
    });
    expect(f.requests.some((value) => value.method === "DELETE")).toBe(false);
    expect(f.instances.has(sourceId)).toBe(true);
  });

  test("lost capture reply recovery accepts a confirmed missing carrier and ignores unrelated snapshots", async () => {
    const f = fixture(true);
    f.faults.lostCaptureReply = true;
    await expect(
      f.backend.snapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "hypeman_unreachable" });
    expect(f.instances.has("recovered-carrier")).toBe(false);
    f.captures.unshift({
      id: "wrong-owner",
      name: snapshotName,
      source_instance_id: "unrelated-vm",
      source_instance_name: "unrelated-carrier",
      size_bytes: 0,
    });
    f.captures.push({
      id: "wrong-name",
      name: "different",
      source_instance_id: "unrelated-vm",
      source_instance_name: carrierName,
      size_bytes: 0,
    });
    expect(await f.backend.findSnapshot(sourceId, snapshotName)).toEqual({
      id: "native-capture-1",
      sizeBytes: 12345,
    });
    expect(
      f.requests.some(
        (value) =>
          value.method === "DELETE" && value.path === "/instances/unrelated-vm",
      ),
    ).toBe(false);
    f.captures.push({
      id: "duplicate",
      name: snapshotName,
      source_instance_id: "duplicate-carrier",
      source_instance_name: carrierName,
      size_bytes: 0,
    });
    await expect(
      f.backend.findSnapshot(sourceId, snapshotName),
    ).rejects.toMatchObject({ code: "ambiguous_snapshot" });
    expect(
      f.requests.some(
        (value) =>
          value.method === "DELETE" &&
          value.path === "/instances/duplicate-carrier",
      ),
    ).toBe(false);
  });
});

describe("Hypeman credential brokering and volume overlays", () => {
  function fixture(storage = false) {
    const requests: Array<{ method: string; path: string; body: any }> = [];
    const commands: NativeExecOptions[] = [];
    let native: any;
    let redact = true;
    let support = true;
    let patchStatus = 200;
    const client = new HypemanClient({
      baseUrl: "http://localhost:4973",
      ...(storage
        ? {
            storageUrl: "http://localhost:4974",
            storageToken: "storage-only-test-token",
          }
        : {}),
    });
    client.request = async <T>(
      method: string,
      path: string,
      body?: any,
    ): Promise<T> => {
      requests.push({ method, path, body: structuredClone(body) });
      if (path === "/spec.json")
        return {
          components: {
            schemas: support
              ? {
                  CreateInstanceRequest: { properties: { credentials: {} } },
                  CreateInstanceRequestNetworkEgress: {
                    properties: { enabled: {} },
                  },
                  CreateInstanceRequestCredential: {
                    properties: { source: {} },
                  },
                  UpdateInstanceRequest: { properties: { env: {} } },
                }
              : {},
          },
        } as T;
      if (path === "/capabilities")
        return {
          default_runtime: { name: "vz", available: true },
          runtimes: [{ name: "vz", available: true, features: ["snapshots"] }],
          features: ["exec", "volumes"],
          host: { os: "darwin", arch: "arm64" },
          server: { version: "test", api_version: "1" },
        } as T;
      if (method === "POST" && path === "/instances")
        native = { ...structuredClone(body), id: "vm", state: "Running" };
      if (method === "POST" && path.endsWith("/fork"))
        native = { ...structuredClone(native), id: "fork", state: "Stopped" };
      if (method === "POST" && path.endsWith("/start"))
        native.state = "Running";
      if (method === "PATCH") {
        if (patchStatus !== 200)
          throw new HypemanError("Rotation failed", patchStatus);
        Object.assign(native.env, body.env);
      }
      return structuredClone(native) as T;
    };
    client.exec = async (
      _id: string,
      options: NativeExecOptions,
      onData: (data: Uint8Array) => void,
    ): Promise<NativeExecSession> => {
      commands.push(options);
      if (options.command.includes("sbox-bridge")) {
        let resolve!: (code: number) => void;
        const completion = new Promise<number>((r) => {
          resolve = r;
        });
        queueMicrotask(() => onData(Buffer.from('{"type":"ready"}\n')));
        return {
          completion,
          write(data) {
            const frame = JSON.parse(Buffer.from(data).toString());
            if (frame.type !== "start") return;
            onData(
              Buffer.from(JSON.stringify({ type: "started", pid: 100 }) + "\n"),
            );
            onData(
              Buffer.from(
                JSON.stringify({
                  type: "stdout",
                  data: Buffer.from(JSON.stringify(frame.options)).toString(
                    "base64",
                  ),
                }) + "\n",
              ),
            );
            onData(Buffer.from('{"type":"exit","exitCode":0}\n'));
            resolve(0);
          },
          close() {},
          resize() {},
        };
      }
      const failedRedaction =
        !redact &&
        options.command.some((part) =>
          part.includes("Provider did not redact guest credentials"),
        );
      return {
        completion: Promise.resolve(failedRedaction ? 127 : 0),
        write() {},
        close() {},
        resize() {},
      };
    };
    const options: BackendCreate = {
      name: "credential-test",
      image: "oven/bun:1-debian",
      resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
      env: {},
      networkPolicy: "allow-all",
      mounts: [],
      deadline: Date.now() + 60_000,
      credentials: {
        API_KEY: {
          source: { env: "HOST_SECRET" },
          inject: [
            {
              hosts: ["API.Example.com"],
              as: { header: "Authorization", format: "Bearer ${value}" },
            },
          ],
        },
      },
      credentialSecrets: { HOST_SECRET: "real-secret-one" },
    };
    return {
      client,
      requests,
      commands,
      options,
      backend: new HypemanBackend(client),
      setRedaction(value: boolean) {
        redact = value;
      },
      setSupport(value: boolean) {
        support = value;
      },
      setPatchStatus(value: number) {
        patchStatus = value;
      },
      native() {
        return native;
      },
    };
  }

  test("never creates with real secrets, prevents differing source-name leakage, and scrubs ordinary and PTY command environments", async () => {
    const f = fixture();
    await f.backend.create(f.options);
    const created = f.requests.find(
      (request) => request.path === "/instances",
    )!.body;
    expect(created.env.HOST_SECRET).toBeUndefined();
    expect(created.env.API_KEY).toStartWith("sbox-initial-");
    expect(JSON.stringify(created)).not.toContain("real-secret-one");
    expect(created.credentials.API_KEY.source.env).toBe("API_KEY");
    expect(created.network.egress).toEqual({
      enabled: true,
      enforcement: { mode: "all" },
    });
    expect(
      f.requests.find((request) => request.method === "PATCH")!.body,
    ).toEqual({ env: { API_KEY: "real-secret-one" } });
    const exec = {
      cmd: "env",
      args: [],
      cwd: "/vercel/sandbox",
      user: "sandbox",
      env: {
        HOST_SECRET: "real-secret-one",
        API_KEY: "real-secret-one",
        ORDINARY: "retained",
      },
    };
    const command = await f.backend.exec("vm", exec);
    const chunks: Uint8Array[] = [];
    for await (const chunk of command.output) chunks.push(chunk.data);
    await command.exited;
    const sent = JSON.parse(Buffer.concat(chunks).toString());
    expect(sent.env.HOST_SECRET).toBeUndefined();
    expect(sent.env.API_KEY).toBe("mock-API_KEY");
    expect(sent.env.ORDINARY).toBe("retained");
    expect(sent.brokered).toBe(true);
    await (
      await f.backend.exec("vm", { ...exec, tty: true })
    ).exited;
    const pty = JSON.parse(f.commands.at(-1)!.env!.SBOX_TERMINAL_OPTIONS!);
    expect(pty.env.HOST_SECRET).toBeUndefined();
    expect(pty.env.API_KEY).toBe("mock-API_KEY");
    expect(JSON.stringify(f.commands)).not.toContain("real-secret-one");
  });

  test("fails before installing real secrets when support or guest redaction cannot be verified", async () => {
    const unsupported = fixture();
    unsupported.setSupport(false);
    await expect(
      unsupported.backend.create(unsupported.options),
    ).rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(
      unsupported.requests.some((request) => request.method === "POST"),
    ).toBe(false);
    const unsafe = fixture();
    unsafe.setRedaction(false);
    await expect(unsafe.backend.create(unsafe.options)).rejects.toMatchObject({
      code: "guest_setup_failed",
    });
    expect(JSON.stringify(unsafe.requests)).not.toContain("real-secret-one");
    expect(unsafe.requests.at(-1)!.method).toBe("DELETE");
  });

  test("recovers bindings after adapter restart, rotates mapped sources, and propagates rotation failures", async () => {
    const f = fixture();
    await f.backend.create(f.options);
    const restarted = new HypemanBackend(f.client);
    await restarted.rotateCredentials("vm", { HOST_SECRET: "rotated-secret" });
    expect(f.requests.at(-1)!.body).toEqual({
      env: { API_KEY: "rotated-secret" },
    });
    await expect(
      restarted.rotateCredentials("vm", { UNKNOWN: "secret" }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    f.setPatchStatus(503);
    await expect(
      restarted.rotateCredentials("vm", { HOST_SECRET: "rejected-secret" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.native().env.API_KEY).toBe("rotated-secret");
  });

  test("restores immutable credential policies and rotates values only after the fork starts", async () => {
    const f = fixture();
    await f.backend.create(f.options);
    f.requests.length = 0;
    await new HypemanBackend(f.client).restore("snapshot", {
      ...f.options,
      credentialSecrets: { HOST_SECRET: "fork-secret" },
    });
    expect(
      f.requests.findIndex((request) => request.path.endsWith("/start")),
    ).toBeLessThan(
      f.requests.findIndex((request) => request.method === "PATCH"),
    );
    expect(
      f.requests.find((request) => request.method === "PATCH")!.body.env,
    ).toEqual({ API_KEY: "fork-secret" });
    await expect(
      f.backend.restore("snapshot", {
        ...f.options,
        credentials: {
          ...f.options.credentials,
          OTHER: f.options.credentials!.API_KEY!,
        },
      }),
    ).rejects.toMatchObject({ code: "snapshot_credential_override" });
    expect(f.requests.at(-1)!.method).toBe("DELETE");
  });

  test("rechecks the native credential proxy on resume and retains disks when it fails", async () => {
    const f = fixture();
    await f.backend.create(f.options);
    f.requests.length = 0;
    f.setRedaction(false);
    await expect(
      new HypemanBackend(f.client).start("vm", Date.now() + 60_000),
    ).rejects.toMatchObject({ code: "guest_setup_failed" });
    expect(
      f.requests.some((request) => request.path === "/instances/vm/stop"),
    ).toBe(true);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(
      false,
    );
    expect(f.requests.some((request) => request.method === "PATCH")).toBe(
      false,
    );
  });

  test("rejects dangerous credential policies and incompatible networks before mutations", async () => {
    const f = fixture();
    await expect(
      f.backend.create({ ...f.options, networkPolicy: "deny-all" }),
    ).rejects.toMatchObject({ code: "credential_network_required" });
    await expect(
      f.backend.create({
        ...f.options,
        credentials: { LD_PRELOAD: f.options.credentials!.API_KEY! },
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      f.backend.create({
        ...f.options,
        credentials: {
          API_KEY: {
            source: { env: "HOST_SECRET" },
            inject: [
              {
                hosts: [],
                as: { header: "Authorization", format: "Bearer ${value}" },
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      f.backend.create({
        ...f.options,
        credentialSecrets: { HOST_SECRET: "bad\r\nheader" },
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(f.requests).toHaveLength(0);
  });

  test("malformed provider manifest fails closed after restart", async () => {
    const f = fixture();
    await f.backend.create(f.options);
    f.native().env[CREDENTIAL_MANIFEST] = "invalid";
    await expect(
      new HypemanBackend(f.client).exec("vm", {
        cmd: "true",
        args: [],
        cwd: "/",
        env: {},
        user: "sandbox",
      }),
    ).rejects.toMatchObject({ code: "credential_manifest_invalid" });
  });

  test("supports readonly overlays with writable ownership and validates fork mount equivalence", async () => {
    const f = fixture();
    const options = {
      ...f.options,
      mounts: [
        {
          volumeId: "base",
          path: "/data",
          readOnly: true,
          overlay: true,
          overlaySizeBytes: 1024 ** 3,
        },
      ],
    };
    await f.backend.create(options);
    expect(f.native().volumes).toEqual([
      {
        volume_id: "base",
        mount_path: "/data",
        readonly: true,
        overlay: true,
        overlay_size: "1073741824B",
      },
    ]);
    expect(
      f.commands.some(
        (command) =>
          command.command.join(" ") === "chown sandbox:sandbox -- /data",
      ),
    ).toBe(true);
    await f.backend.restore("snapshot", options);
    await expect(
      f.backend.restore("snapshot", {
        ...options,
        mounts: [{ ...options.mounts[0]!, overlaySizeBytes: 2 * 1024 ** 3 }],
      }),
    ).rejects.toMatchObject({ code: "snapshot_mount_override" });
    const invalid = fixture();
    await expect(
      invalid.backend.create({
        ...invalid.options,
        mounts: [
          {
            volumeId: "base",
            path: "/data",
            readOnly: false,
            overlay: true,
            overlaySizeBytes: 1024 ** 3,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_volume_overlay" });
    expect(invalid.requests).toHaveLength(0);
  });

  test("advertises HTTPS injection separately from a general network firewall", async () => {
    const caps = await fixture().backend.capabilities();
    expect(caps.credentialBrokering).toBe(true);
    expect(caps.credentialBrokeringDetails).toMatchObject({
      destinationFirewall: false,
      hostEnforcement: "none",
      protocol: "https-header-injection",
    });
    expect(caps.liveNetworkPolicy).toBe(false);
    expect(caps.volumeOverlays).toBe(true);
  });

  test("copy clones reject attached writers and retain target ownership while cleaning the helper on failure", async () => {
    const f = fixture();
    let writer = true;
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(
      method: string,
      path: string,
      body?: any,
    ): Promise<T> => {
      if (path === "/volumes/source")
        return { id: "source", attachments: [{ readonly: !writer }] } as T;
      if (path === "/volumes" && method === "POST") {
        f.requests.push({ method, path, body });
        return { id: body.id } as T;
      }
      return request<T>(method, path, body);
    };
    await expect(
      f.backend.cloneVolume("source", "target", 1024 ** 3),
    ).rejects.toMatchObject({ code: "volume_writer_attached" });
    expect(f.requests).toHaveLength(0);
    writer = false;
    expect(await f.backend.cloneVolume("source", "target", 1024 ** 3)).toEqual({
      id: "target",
    });
    const helper = f.requests.find(
      (value) => value.path === "/instances",
    )!.body;
    expect(helper.name).toBe("target-copy");
    expect(helper.network.enabled).toBe(false);
    expect(helper.volumes).toEqual([
      { volume_id: "source", mount_path: "/sbox-copy-source", readonly: true },
      {
        volume_id: "target",
        mount_path: "/sbox-copy-destination",
        readonly: false,
      },
    ]);
    expect(f.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/instances/vm",
    });
    const exec = f.client.exec.bind(f.client);
    f.client.exec = async (id, options, onData) =>
      exec(id, options, (data) =>
        onData(
          Buffer.from(
            Buffer.from(data)
              .toString()
              .replace('"exitCode":0', '"exitCode":1'),
          ),
        ),
      );
    await expect(
      f.backend.cloneVolume("source", "failed-target", 1024 ** 3),
    ).rejects.toMatchObject({ code: "volume_copy_failed" });
    expect(f.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/instances/vm",
    });
    expect(
      f.requests.some(
        (value) =>
          value.method === "DELETE" && value.path.startsWith("/volumes/"),
      ),
    ).toBe(false);
  });

  test("atomic clones probe host capability and replay the cloned journal without attaching or changing the source", async () => {
    const f = fixture(true);
    const storageRequests: Array<{
      method: string;
      path: string;
      body: unknown;
    }> = [];
    f.client.storageRequest = async <T>(
      method: string,
      path: string,
      body?: any,
    ): Promise<T> => {
      storageRequests.push({ method, path, body });
      return (
        method === "GET"
          ? {
              protocol: 1,
              atomicVolumeClone: true,
              consistency: "crash-consistent",
            }
          : { id: body.targetId }
      ) as T;
    };
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(
      method: string,
      path: string,
      body?: any,
    ): Promise<T> => {
      if (path === "/volumes/source")
        return { id: "source", attachments: [{ readonly: false }] } as T;
      if (path === "/volumes" && method === "POST") {
        f.requests.push({ method, path, body });
        return { id: body.id } as T;
      }
      return request<T>(method, path, body);
    };
    expect((await f.backend.capabilities()).atomicVolumeClone).toBe(true);
    expect(await f.backend.cloneVolume("source", "target", 1024 ** 3)).toEqual({
      id: "target",
    });
    expect(storageRequests).toEqual([
      { method: "GET", path: "/v1/capabilities", body: undefined },
      {
        method: "POST",
        path: "/v1/volumes/clone",
        body: { sourceId: "source", targetId: "target" },
      },
    ]);
    const helper = f.requests.find(
      (value) => value.path === "/instances",
    )!.body;
    expect(helper.volumes).toEqual([
      {
        volume_id: "target",
        mount_path: "/sbox-copy-destination",
        readonly: false,
      },
    ]);
    expect(helper.network.enabled).toBe(false);
    expect(
      f.commands.some((options) => options.command.includes("sbox-bridge")),
    ).toBe(false);
    expect(f.commands.some((options) => options.command[0] === "chown")).toBe(
      false,
    );
    expect(f.commands.at(-1)!.command).toEqual([
      "sync",
      "-f",
      "/sbox-copy-destination",
    ]);
    expect(f.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/instances/vm",
    });
  });

  test("never falls back from configured atomic storage to a racy copy", async () => {
    const f = fixture(true);
    f.client.request = async <T>() => ({ id: "source", attachments: [] }) as T;
    f.client.storageRequest = async <T>() =>
      ({
        protocol: 2,
        atomicVolumeClone: true,
        consistency: "crash-consistent",
      }) as T;
    await expect(
      f.backend.cloneVolume("source", "target", 1024 ** 3),
    ).rejects.toMatchObject({ code: "atomic_clone_unavailable" });
    expect(f.commands).toHaveLength(0);
    const unreachable = fixture(true);
    unreachable.client.request = f.client.request;
    unreachable.client.storageRequest = async () => {
      throw new SboxError("storage_unreachable", "Unavailable", 502);
    };
    await expect(
      unreachable.backend.cloneVolume("source", "target", 1024 ** 3),
    ).rejects.toMatchObject({ code: "storage_unreachable" });
    expect(unreachable.commands).toHaveLength(0);
  });

  test("storage requests use separate bearer authentication and reject redirects", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new HypemanClient({
      baseUrl: "http://provider.invalid",
      apiKey: "native-secret",
      storageUrl: "http://storage.invalid",
      storageToken: "storage-secret-only",
      fetch: (async (url: string | URL | Request, init: RequestInit) => {
        requests.push({ url: String(url), init });
        return Response.json(
          { error: { code: "VOLUME_IN_USE", message: "Target attached" } },
          { status: 409 },
        );
      }) as typeof fetch,
    });
    await expect(
      client.storageRequest("POST", "/v1/volumes/clone", {
        sourceId: "a",
        targetId: "b",
      }),
    ).rejects.toMatchObject({ code: "VOLUME_IN_USE", status: 409 });
    expect(requests[0]!.url).toBe("http://storage.invalid/v1/volumes/clone");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe(
      "Bearer storage-secret-only",
    );
    expect(JSON.stringify(requests)).not.toContain("native-secret");
    expect(
      () =>
        new HypemanClient({
          baseUrl: "http://provider.invalid",
          storageUrl: "http://storage.invalid",
        }),
    ).toThrow("token");
    expect(
      () =>
        new HypemanClient({
          baseUrl: "http://provider.invalid",
          storageUrl: "http://user:secret@storage.invalid",
          storageToken: "storage-secret-only",
        }),
    ).toThrow("without embedded credentials");
  });
});
