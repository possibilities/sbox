import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, SandboxService, Store } from "../src/server/index.ts";
import { Sandbox, Snapshot, Drive } from "../src/index.ts";
import { TestBackend } from "./test-backend.ts";
import { Readable, Writable } from "node:stream";

let backend: TestBackend,
  store: Store,
  server: Awaited<ReturnType<typeof startServer>>,
  baseUrl: string;
const token = "test-server-auth-token-32-characters";
beforeEach(async () => {
  backend = await new TestBackend().initialize();
  store = new Store(":memory:");
  server = await startServer({
    backend,
    store,
    hostname: "127.0.0.1",
    port: 0,
    token,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server.stop(true);
  store.close();
  await backend.dispose();
});
const connection = () => ({ baseUrl, token });
async function rpc(method: string, params: unknown = {}) {
  return fetch(`${baseUrl}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
}

describe("full SDK → HTTP server → provider contract", () => {
  test("creates once under concurrency, executes literal argv, and returns nonzero exit", async () => {
    const boxes = await Promise.all(
      Array.from({ length: 6 }, () =>
        Sandbox.getOrCreate({ ...connection(), name: "shared" }),
      ),
    );
    expect(new Set(boxes.map((s) => s.sandboxId)).size).toBe(1);
    expect(backend.createCalls).toBe(1);
    const result = await boxes[0]!.runCommand("bun", [
      "-e",
      "console.log(process.argv.at(-1));console.error('bad');process.exit(7)",
      "--",
      "$(touch should-not-exist); ' quotes",
    ]);
    expect(result.exitCode).toBe(7);
    expect(await result.stdout()).toBe("$(touch should-not-exist); ' quotes\n");
    expect(await result.stderr()).toBe("bad\n");
    const native = backend.instances.values().next().value!;
    expect(await Bun.file(`${native.dir}/should-not-exist`).exists()).toBe(
      false,
    );
  });
  test("streams before completion, roundtrips stdin, and reattaches detached commands", async () => {
    const s = await Sandbox.create(connection());
    const started = Date.now();
    const c = await s.runCommand({
      cmd: "bun",
      args: [
        "-e",
        "process.stdout.write('early');await Bun.sleep(350);process.stderr.write(await Bun.stdin.text())",
      ],
      stdin: true,
      detached: true,
    });
    const it = c.logs();
    const first = await it.next();
    expect(first.value?.data).toBe("early");
    expect(Date.now() - started).toBeLessThan(350);
    await c.writeStdin("from stdin\n");
    await c.closeStdin();
    await it.return(undefined);
    const attached = await s.getCommand(c.commandId);
    const result = await attached.wait();
    expect(result.exitCode).toBe(0);
    expect(await result.stderr()).toBe("from stdin\n");
  });
  test("preserves files beyond argv size, modes, missing files, and atomic append", async () => {
    const s = await Sandbox.create(connection());
    const contents = Buffer.alloc(256 * 1024);
    for (let i = 0; i < contents.length; i++) contents[i] = i % 256;
    await s.writeFiles([
      { path: "nested/quo'te\nfile.bin", content: contents, mode: 0o600 },
    ]);
    expect(
      await s.readFileToBuffer({ path: "nested/quo'te\nfile.bin" }),
    ).toEqual(contents);
    expect(await s.readFileToBuffer({ path: "missing" })).toBeNull();
    expect((await s.fs.stat("nested/quo'te\nfile.bin")).mode & 0o777).toBe(
      0o600,
    );
    await s.fs.writeFile("append.txt", "");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.fs.appendFile("append.txt", `${i}\n`),
      ),
    );
    expect(
      (await s.fs.readFile("append.txt", "utf8")).trim().split("\n"),
    ).toHaveLength(10);
    expect(await s.fs.readdir("nested")).toEqual(["quo'te\nfile.bin"]);
  });
  test("stop/resume keeps filesystem with new session and snapshot forks diverge", async () => {
    const s = await Sandbox.create({ ...connection(), name: "original" });
    await s.writeFiles([{ path: "state", content: "before" }]);
    const firstSession = s.toJSON().sessionId;
    await s.stop();
    expect(s.status).toBe("stopped");
    expect((await s.readFileToBuffer({ path: "state" }))?.toString()).toBe(
      "before",
    );
    expect(s.toJSON().sessionId).not.toBe(firstSession);
    const snapshot = await s.snapshot();
    expect(s.status).toBe("stopped");
    const fork = await Sandbox.create({
      ...connection(),
      name: "fork",
      source: { type: "snapshot", snapshotId: snapshot.snapshotId },
    });
    expect((await fork.readFileToBuffer({ path: "state" }))?.toString()).toBe(
      "before",
    );
    await fork.writeFiles([{ path: "state", content: "after" }]);
    expect((await s.readFileToBuffer({ path: "state" }))?.toString()).toBe(
      "before",
    );
  });
  test("ephemeral stop destroys instance; timeout rejects in-flight command", async () => {
    const s = await Sandbox.create({
      ...connection(),
      persistent: false,
      timeout: 1000,
    });
    const c = await s.runCommand({
      cmd: "bun",
      args: ["-e", "await Bun.sleep(10000)"],
      detached: true,
    });
    await expect(c.wait()).rejects.toMatchObject({ code: "SANDBOX_TIMEOUT" });
    expect(backend.instances.size).toBe(0);
    await expect(s.runCommand("true")).rejects.toMatchObject({
      code: "SANDBOX_STOPPED",
    });
  });
  test("command deadline and process cancellation do not stop the sandbox", async () => {
    const s = await Sandbox.create(connection());
    const c = await s.runCommand({
      cmd: "bun",
      args: ["-e", "await Bun.sleep(10000)"],
      detached: true,
      timeoutMs: 50,
    });
    await expect(c.wait()).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(
      (await s.runCommand("bun", ["-e", "console.log(42)"])).exitCode,
    ).toBe(0);
    const detached = await s.runCommand({
      cmd: "bun",
      args: ["-e", "await Bun.sleep(10000)"],
      detached: true,
    });
    await detached.kill("SIGKILL");
    expect((await detached.wait()).exitCode).not.toBe(0);
  });
  test("bounded logs are explicit and keep draining runaway output", async () => {
    await server.stop(true);
    store.close();
    store = new Store(":memory:");
    server = await startServer({
      backend,
      store,
      port: 0,
      token,
      maxOutputBytes: 1024,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const s = await Sandbox.create(connection());
    const c = await s.runCommand("bun", [
      "-e",
      "process.stdout.write('x'.repeat(10000))",
    ]);
    await expect(c.stdout()).rejects.toMatchObject({ code: "LOGS_EXPIRED" });
    expect(c.truncated).toBe(true);
    const metadata = await rpc("command.poll", { id: c.commandId });
    const expired = (await metadata.json()) as any;
    expect(expired.error.code).toBe("LOGS_EXPIRED");
    expect(expired.error.details.firstSequence).toBeGreaterThan(1);
    const tail = await rpc("command.poll", {
      id: c.commandId,
      after: expired.error.details.firstSequence - 1,
    });
    expect(((await tail.json()) as any).result.logs.length).toBeGreaterThan(0);
  });
  test("live command output continues intact after replay retention rolls over", async () => {
    await server.stop(true);
    store.close();
    store = new Store(":memory:");
    server = await startServer({
      backend,
      store,
      port: 0,
      token,
      maxOutputBytes: 1024,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const s = await Sandbox.create(connection());
    const command = await s.runCommand({
      cmd: "bun",
      args: [
        "-e",
        "process.stdout.write('ready');await Bun.stdin.text();for(let n=0;n<100;n++){process.stdout.write(Buffer.alloc(2048,n));await Bun.sleep(1)}",
      ],
      detached: true,
      stdin: true,
    });
    const logs = command.rawLogs();
    expect((await logs.next()).value?.data.toString()).toBe("ready");
    await command.closeStdin();
    const chunks: Buffer[] = [];
    for await (const log of logs) chunks.push(log.data);
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(100 * 2048);
    for (let i = 0; i < 100; i++)
      expect(
        bytes.subarray(i * 2048, (i + 1) * 2048).equals(Buffer.alloc(2048, i)),
      ).toBe(true);
    expect((await command.wait()).truncated).toBe(true);
  });
  test("drive ownership is exclusive and deleting sandbox preserves the drive", async () => {
    const drive = await Drive.getOrCreate({ ...connection(), name: "cache" });
    const s = await Sandbox.create({
      ...connection(),
      mounts: { "/data": drive },
    });
    await expect(
      Sandbox.create({ ...connection(), mounts: { "/data": drive } }),
    ).rejects.toMatchObject({ code: "DRIVE_IN_USE" });
    await expect(drive.delete()).rejects.toMatchObject({
      code: "DRIVE_IN_USE",
    });
    await s.delete();
    expect(backend.volumes.size).toBe(1);
    await drive.delete();
    expect(backend.volumes.size).toBe(0);
  });
});

describe("API boundaries", () => {
  test("auth, JSON, origin, unknown features, input bounds fail before mutation", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/capabilities`)).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/v1/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "text/plain",
          },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${baseUrl}/v1/capabilities`, {
          headers: {
            authorization: `Bearer ${token}`,
            origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    for (const params of [
      { networkPolicy: { allow: { "example.com": [] } } },
      { ports: [1, 1] },
      { resources: { vcpus: 0 } },
      { env: { "BAD=NAME": "x" } },
      { name: "../no" },
      { forwardURL: "https://example.com" },
    ])
      expect(
        (await rpc("sandbox.create", params)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(backend.createCalls).toBe(0);
  });
  test("stale session is rejected and unsupported policy update leaves state intact", async () => {
    const s = await Sandbox.create(connection());
    const sessionId = s.toJSON().sessionId;
    await s.stop();
    await s.runCommand("true");
    const response = await rpc("command.run", {
      id: s.sandboxId,
      sessionId,
      cmd: "true",
    });
    expect(response.status).toBe(409);
    await expect(s.update({ networkPolicy: "deny-all" })).rejects.toMatchObject(
      { code: "UNSUPPORTED_NETWORK_POLICY_UPDATE" },
    );
    expect(
      (await Sandbox.get({ ...connection(), sandboxId: s.sandboxId })).toJSON()
        .networkPolicy,
    ).toBe("allow-all");
  });
  test("server restart retains metadata and marks interrupted commands without replay", async () => {
    const service = new SandboxService(backend, store);
    const { sandbox } = await service.create({ name: "survive" });
    store.put("command", "cmd-crashed", {
      commandId: "cmd-crashed",
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      cmd: "never-repeat",
      args: [],
      cwd: "/vercel/sandbox",
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    });
    await service.initialize();
    expect(service.command("cmd-crashed").error?.code).toBe("SERVER_RESTARTED");
    expect(service.get("survive").instanceId).toBe(sandbox.instanceId);
    await service.close();
  });
});

describe("previews and terminals", () => {
  test("guest HTTP preview preserves paths, methods, binary bodies, cookies and redirects", async () => {
    const guest = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req): Response {
        const u = new URL(req.url);
        if (u.pathname === "/redirect")
          return Response.redirect(`http://127.0.0.1:${guest.port}/next`, 302);
        if (req.method === "POST")
          return new Response(req.body, {
            headers: { "x-guest-path": u.pathname + u.search },
          });
        return Response.json({
          path: u.pathname + u.search,
          cookie: req.headers.get("cookie"),
          authorization: req.headers.get("authorization"),
          host: req.headers.get("host"),
        });
      },
    });
    try {
      const s = await Sandbox.create({ ...connection(), ports: [guest.port!] });
      const domain = new URL(s.domain(guest.port!));
      const exchange = await fetch(`${baseUrl}/?${domain.searchParams}`, {
        headers: { host: domain.host },
        redirect: "manual",
      });
      expect(exchange.status).toBe(303);
      const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
      const unauthorized = await fetch(`${baseUrl}/test`, {
        headers: { host: domain.host },
      });
      expect(unauthorized.status).toBe(401);
      const response = await fetch(`${baseUrl}/deep/path?value=1`, {
        headers: { host: domain.host, cookie: `${cookie}; app=test` },
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.path).toBe("/deep/path?value=1");
      expect(data.cookie).toBe("app=test");
      expect(data.authorization).toBeNull();
      expect(data.host).toBe(domain.host);
      const bytes = Buffer.from([0, 255, 192, 128]);
      const post = await fetch(`${baseUrl}/post?yes`, {
        method: "POST",
        headers: { host: domain.host, cookie },
        body: bytes,
      });
      expect(Buffer.from(await post.arrayBuffer())).toEqual(bytes);
      expect(post.headers.get("x-guest-path")).toBe("/post?yes");
      const redirect = await fetch(`${baseUrl}/redirect`, {
        headers: { host: domain.host, cookie },
        redirect: "manual",
      });
      expect(redirect.headers.get("location")).toBe(
        `http://${domain.host}/next`,
      );
    } finally {
      await guest.stop(true);
    }
  });
  test("terminal tickets are single-use and binary input reaches a running process", async () => {
    const s = await Sandbox.create(connection());
    const { url } = await s.openInteractive({ cmd: "cat", args: [] });
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const out: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          const m = JSON.parse(e.data);
          if (m.type === "exit") resolve();
          if (m.type === "error") reject(Error(m.message));
        } else {
          out.push(Buffer.from(e.data).toString());
          ws.send(JSON.stringify({ type: "signal", signal: "SIGTERM" }));
        }
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "start" }));
        ws.send(Buffer.from("terminal-data\n"));
        resolve();
      }),
    );
    await done;
    expect(out.join("")).toContain("terminal-data");
    expect((await fetch(url.replace("ws:", "http:"))).status).toBe(401);
    ws.close();
  });
});

test("preview WebSockets preserve app auth, cookies, subprotocols and enforce same origin", async () => {
  let receivedAuth: string | null = null,
    receivedCookie: string | null = null;
  const guest = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server): Response | undefined {
      receivedAuth = req.headers.get("authorization");
      receivedCookie = req.headers.get("cookie");
      if (
        req.headers.get("upgrade") === "websocket" &&
        server.upgrade(req, {
          headers: { "sec-websocket-protocol": "vite-hmr" },
        })
      )
        return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });
  try {
    const s = await Sandbox.create({ ...connection(), ports: [guest.port!] });
    const domain = new URL(s.domain(guest.port!));
    const exchange = await fetch(`${baseUrl}/?${domain.searchParams}`, {
        headers: { host: domain.host },
        redirect: "manual",
      }),
      cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    const blocked = await fetch(`${baseUrl}/socket`, {
      headers: {
        host: domain.host,
        cookie,
        origin: "http://different-sandbox.localhost:7070",
        upgrade: "websocket",
      },
    });
    expect(blocked.status).toBe(403);
    const BunWS = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const ws = new BunWS(baseUrl.replace("http:", "ws:") + "/socket", {
      protocols: ["vite-hmr"],
      headers: {
        host: domain.host,
        cookie: `${cookie}; app=logged-in`,
        authorization: "Bearer app-secret",
        origin: `http://${domain.host}`,
      },
    });
    const response = await new Promise<string>((resolve, reject) => {
      ws.addEventListener("error", () => reject(Error("WebSocket failed")));
      ws.addEventListener("open", () => ws.send("hot reload"));
      ws.addEventListener("message", (event) => resolve(String(event.data)));
    });
    expect(response).toBe("hot reload");
    expect(ws.protocol).toBe("vite-hmr");
    expect(receivedAuth as string | null).toBe("Bearer app-secret");
    expect(receivedCookie as string | null).toBe("app=logged-in");
    ws.close();
  } finally {
    await guest.stop(true);
  }
});

test("configured HTTPS origin works behind a TLS reverse proxy without trusting forwarded headers", async () => {
  const original = await Sandbox.create({ ...connection(), ports: [3000] });
  await server.stop(true);
  server = await startServer({
    backend,
    store,
    port: 0,
    token,
    publicUrl: "https://sbox.example.com",
    previewHost: "previews.example.com",
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  const api = await fetch(`${baseUrl}/v1/capabilities`, {
    headers: {
      host: "sbox.example.com",
      origin: "https://sbox.example.com",
      authorization: `Bearer ${token}`,
    },
  });
  expect(api.status).toBe(200);
  const s = await Sandbox.get({
      ...connection(),
      sandboxId: original.sandboxId,
    }),
    domain = new URL(s.domain(3000));
  expect(domain.protocol).toBe("https:");
  const exchange = await fetch(`${baseUrl}/?${domain.searchParams}`, {
    headers: { host: domain.host },
    redirect: "manual",
  });
  expect(exchange.status).toBe(303);
  expect(exchange.headers.get("location")).toBe(`https://${domain.host}/`);
  expect(exchange.headers.get("set-cookie")).toContain("; Secure");
  const spoofed = await fetch(`${baseUrl}/v1/capabilities`, {
    headers: {
      host: "sbox.example.com",
      origin: "https://attacker.example",
      "x-forwarded-proto": "https",
      authorization: `Bearer ${token}`,
    },
  });
  expect(spoofed.status).toBe(403);
});
