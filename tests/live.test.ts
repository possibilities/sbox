/**
 * Explicit opt-in: this suite creates real Hypeman VMs, snapshots, and a volume.
 * Only resources created by this suite are deleted. The Hypeman daemon is owned
 * by the caller and is never stopped or reconfigured here.
 *
 * SBOX_LIVE_TEST=1 HYPEMAN_BASE_URL=... HYPEMAN_API_KEY=... bun test tests/live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Sandbox, Snapshot, Drive } from "../src/index.ts";
import { HypemanBackend } from "../src/hypeman/index.ts";
import { startServer, Store } from "../src/server/index.ts";

describe.skipIf(process.env.SBOX_LIVE_TEST !== "1")(
  "real Hypeman: SDK → control plane → microVM",
  () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let store: Store;
    let sandbox: Sandbox;
    const boxes: Sandbox[] = [];
    const snapshots: Snapshot[] = [];
    const drives: Drive[] = [];
    let connection: { baseUrl: string; token: string };
    const resources = { vcpus: 1, memoryMb: 512, diskMb: 1024 };
    const prefix = `live-${crypto.randomUUID().slice(0, 8)}`;

    async function create(extra: Parameters<typeof Sandbox.create>[0] = {}) {
      const box = await Sandbox.create({
        ...connection,
        image: process.env.SBOX_LIVE_IMAGE ?? "oven/bun:1-debian",
        resources,
        timeout: 600_000,
        networkPolicy: "deny-all",
        ...extra,
      });
      boxes.push(box);
      return box;
    }

    beforeAll(async () => {
      if (!process.env.HYPEMAN_BASE_URL)
        throw new Error("Live tests require an explicit HYPEMAN_BASE_URL");
      const backend = new HypemanBackend({
        baseUrl: process.env.HYPEMAN_BASE_URL,
        apiKey: process.env.HYPEMAN_API_KEY,
      });
      store = new Store(":memory:");
      const token = crypto.randomUUID();
      server = await startServer({
        backend,
        store,
        hostname: "127.0.0.1",
        port: 0,
        token,
      });
      connection = { baseUrl: `http://127.0.0.1:${server.port}`, token };
      sandbox = await create({
        name: `${prefix}-main`,
        env: { REMOVE_ME: "old-value" },
      });
    }, 180_000);

    afterAll(async () => {
      const failures: string[] = [];
      for (const box of boxes.reverse()) {
        try {
          await box.delete();
        } catch (error) {
          if (
            !["SANDBOX_DELETED", "NOT_FOUND"].includes(
              (error as { code?: string }).code ?? "",
            )
          )
            failures.push(`sandbox ${box.sandboxId}: ${String(error)}`);
        }
      }
      for (const snapshot of server
        ? await Snapshot.list(connection).then((page) => page.toArray())
        : snapshots) {
        try {
          await (
            await Snapshot.get({
              ...connection,
              snapshotId: snapshot.snapshotId,
            })
          ).delete();
        } catch (error) {
          failures.push(`snapshot ${snapshot.snapshotId}: ${String(error)}`);
        }
      }
      for (const drive of drives) {
        try {
          await drive.delete();
        } catch (error) {
          failures.push(`drive ${drive.driveId}: ${String(error)}`);
        }
      }
      if (server) await server.stop(true);
      store?.close();
      if (failures.length)
        throw new Error(`Live test cleanup failed:\n${failures.join("\n")}`);
    }, 180_000);

    test("literal arguments, stderr, nonzero status, and explicit root execution", async () => {
      const literal = `$(touch unsafe); 'quoted' \\ spaced`;
      const command = await sandbox.runCommand("bun", [
        "-e",
        'console.log(process.argv.at(-1));console.error("separate stderr");process.exit(7)',
        "--",
        literal,
      ]);
      expect(command.exitCode).toBe(7);
      expect(await command.stdout()).toBe(literal + "\n");
      expect(await command.stderr()).toBe("separate stderr\n");
      expect(
        (
          await (
            await sandbox.runCommand({ cmd: "id", args: ["-u"], sudo: true })
          ).stdout()
        ).trim(),
      ).toBe("0");
      expect(
        (await (await sandbox.runCommand("id", ["-u"])).stdout()).trim(),
      ).not.toBe("0");
    }, 30_000);

    test("streams before exit and reattaches detached commands with binary stdin and EOF", async () => {
      const command = await sandbox.runCommand({
        cmd: "bun",
        args: [
          "-e",
          'console.log("ready");await Bun.sleep(2000);console.error(JSON.stringify([...await Bun.stdin.bytes()]))',
        ],
        stdin: true,
        detached: true,
      });
      const started = performance.now();
      const logs = command.logs();
      const first = await logs.next();
      expect(first.value?.data).toContain("ready");
      expect(performance.now() - started).toBeLessThan(1500);
      const payload = Buffer.from([0, 1, 255, 128, 13, 10]);
      await command.writeStdin(payload);
      await command.closeStdin();
      await logs.return(undefined);
      const attached = await sandbox.getCommand(command.commandId);
      const finished = await attached.wait();
      expect(finished.exitCode).toBe(0);
      expect(JSON.parse(await finished.stderr())).toEqual([...payload]);
      const cancelled = await sandbox.runCommand({
        cmd: "sleep",
        args: ["30"],
        detached: true,
      });
      await cancelled.kill("SIGKILL");
      expect((await cancelled.wait()).exitCode).not.toBe(0);
    }, 30_000);

    test("binary files larger than argv limits preserve names, permissions, and bytes", async () => {
      const data = Buffer.alloc(384 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;
      const path = `nested/quote' and\nnewline.bin`;
      await sandbox.writeFiles([{ path, content: data, mode: 0o600 }]);
      expect(await sandbox.readFileToBuffer({ path })).toEqual(data);
      expect((await sandbox.fs.stat(path)).mode & 0o777).toBe(0o600);
      expect(
        await sandbox.readFileToBuffer({ path: "not-present" }),
      ).toBeNull();
      await sandbox.fs.appendFile(path, Buffer.from([0, 128]));
      expect((await sandbox.fs.stat(path)).size).toBe(data.length + 2);
    }, 30_000);

    test("environment replacement and supplementary groups work across users", async () => {
      await sandbox.update({ env: { ONLY_NEW: "current" } });
      await sandbox.stop();
      await sandbox.resume();
      const env = JSON.parse(
        await (
          await sandbox.runCommand("bun", [
            "-e",
            "console.log(JSON.stringify(process.env))",
          ])
        ).stdout(),
      );
      expect(env.REMOVE_ME).toBeUndefined();
      expect(env.ONLY_NEW).toBe("current");
      const writer = await sandbox.createUser("writer");
      const group = await sandbox.createGroup("collaborators");
      await sandbox.addUserToGroup("sandbox", "collaborators");
      await writer.addToGroup("collaborators");
      await sandbox.fs.writeFile(
        `${group.sharedDir}/shared.txt`,
        "shared through supplemental groups",
      );
      expect(
        await writer.fs.readFile(`${group.sharedDir}/shared.txt`, "utf8"),
      ).toBe("shared through supplemental groups");
      const home = await writer.runCommand("bun", [
        "-e",
        "console.log(process.env.HOME)",
      ]);
      expect((await home.stdout()).trim()).toBe("/home/writer");
      await writer.fs.writeFile("private.txt", "private");
      await expect(
        sandbox.fs.readFile("/home/writer/private.txt", "utf8"),
      ).rejects.toMatchObject({ code: "EACCES" });
    }, 120_000);

    test("native PTY supports input, resize, exit, and one-use connection tickets", async () => {
      const ticket = await sandbox.openInteractive({
        cmd: "sh",
        args: [
          "-c",
          'printf "ready\\n"; read -r line; i=0; while [ "$(stty size)" != "40 100" ] && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.01; done; stty size; printf "input:%s\\n" "$line"',
        ],
        rows: 24,
        cols: 80,
      });
      const socket = new WebSocket(ticket.url);
      socket.binaryType = "arraybuffer";
      let text = "";
      let sent = false;
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Live PTY timed out"));
        }, 15_000);
        socket.addEventListener("open", () =>
          socket.send(JSON.stringify({ type: "start" })),
        );
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("Live PTY socket error"));
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            const frame = JSON.parse(event.data);
            if (frame.type === "exit") {
              clearTimeout(timeout);
              resolve(frame.code);
            }
            if (frame.type === "error") {
              clearTimeout(timeout);
              reject(new Error(frame.message));
            }
          } else {
            text += Buffer.from(event.data).toString();
            if (!sent && text.includes("ready")) {
              sent = true;
              socket.send(
                JSON.stringify({ type: "resize", rows: 40, cols: 100 }),
              );
              socket.send(Buffer.from("hello-live\n"));
            }
          }
        });
      });
      expect(exitCode).toBe(0);
      expect(text).toContain("40 100");
      expect(text).toContain("input:hello-live");
      expect((await fetch(ticket.url.replace(/^ws/, "http"))).status).toBe(401);
      socket.close();
    }, 30_000);

    test("persistent stop/resume and real filesystem snapshots retain and fork data", async () => {
      await sandbox.fs.writeFile("checkpoint.txt", "source");
      const firstSession = sandbox.sessionId;
      await sandbox.stop();
      expect(
        (
          await sandbox.readFileToBuffer({ path: "checkpoint.txt" })
        )?.toString(),
      ).toBe("source");
      expect(sandbox.sessionId).not.toBe(firstSession);
      const capability = await Sandbox.capabilities(connection);
      expect(capability.snapshots).toBe(true);
      const snapshot = await sandbox.snapshot();
      snapshots.push(snapshot);
      expect(sandbox.status).toBe("stopped");
      const fork = await Sandbox.create({
        ...connection,
        name: `${prefix}-fork`,
        source: { type: "snapshot", snapshotId: snapshot.snapshotId },
      });
      boxes.push(fork);
      expect(
        (await fork.readFileToBuffer({ path: "checkpoint.txt" }))?.toString(),
      ).toBe("source");
      await fork.fs.writeFile("checkpoint.txt", "fork");
      expect(
        (
          await sandbox.readFileToBuffer({ path: "checkpoint.txt" })
        )?.toString(),
      ).toBe("source");
      expect(
        (await fork.readFileToBuffer({ path: "checkpoint.txt" }))?.toString(),
      ).toBe("fork");
      await fork.delete();
    }, 120_000);

    test("persistent drives survive VM deletion and remain writable by the sandbox user", async () => {
      const drive = await Drive.getOrCreate({
        ...connection,
        name: `${prefix}-drive`,
        sizeBytes: 1024 ** 3,
      });
      drives.push(drive);
      const first = await create({
        name: `${prefix}-drive-first`,
        mounts: { "/data": drive },
      });
      await first.fs.writeFile("/data/persist.txt", "volume survives");
      await first.delete();
      const second = await create({
        name: `${prefix}-drive-second`,
        mounts: { "/data": drive },
      });
      expect(await second.fs.readFile("/data/persist.txt", "utf8")).toBe(
        "volume survives",
      );
      await second.delete();
    }, 120_000);

    test("authenticated HTTP and WebSocket previews reach the actual guest service", async () => {
      const preview = await create({
        name: `${prefix}-preview`,
        ports: [3000],
      });
      const script = String.raw`
const server=Bun.serve({hostname:'127.0.0.1',port:3000,
fetch(req,server){const u=new URL(req.url);if(u.pathname==='/ws'){if(server.upgrade(req,{data:{cookie:req.headers.get('cookie')}}))return;return new Response('upgrade failed',{status:400})}if(u.pathname==='/redirect')return Response.redirect('http://127.0.0.1:3000/next',302);if(req.method==='POST')return new Response(req.body,{headers:{'x-path':u.pathname+u.search}});return Response.json({path:u.pathname+u.search,cookie:req.headers.get('cookie'),authorization:req.headers.get('authorization')})},
websocket:{open(ws){ws.send(JSON.stringify({cookie:ws.data.cookie}))},message(ws,data){ws.send(data)}}});
console.log('preview-ready');
`;
      const command = await preview.runCommand({
        cmd: "bun",
        args: ["-e", script],
        detached: true,
      });
      const logs = command.logs();
      expect((await logs.next()).value?.data).toContain("preview-ready");
      await logs.return(undefined);
      const domain = new URL(preview.domain(3000));
      const exchange = await fetch(
        `${connection.baseUrl}/?${domain.searchParams}`,
        { headers: { host: domain.host }, redirect: "manual" },
      );
      expect(exchange.status).toBe(303);
      const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
      const requestHeaders = {
        host: domain.host,
        cookie: `${cookie}; app_session=guest-cookie`,
      };
      expect(
        (
          await fetch(`${connection.baseUrl}/`, {
            headers: { host: domain.host },
          })
        ).status,
      ).toBe(401);
      const response = await fetch(`${connection.baseUrl}/deep/path?query=ok`, {
        headers: requestHeaders,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        path: "/deep/path?query=ok",
        cookie: "app_session=guest-cookie",
        authorization: null,
      });
      const bytes = Buffer.from([0, 255, 128, 0, 13, 10]);
      const post = await fetch(`${connection.baseUrl}/binary?echo`, {
        method: "POST",
        headers: requestHeaders,
        body: bytes,
      });
      expect(Buffer.from(await post.arrayBuffer())).toEqual(bytes);
      expect(post.headers.get("x-path")).toBe("/binary?echo");
      const redirect = await fetch(`${connection.baseUrl}/redirect`, {
        headers: requestHeaders,
        redirect: "manual",
      });
      expect(redirect.headers.get("location")).toBe(
        `http://${domain.host}/next`,
      );
      const BunWebSocket = WebSocket as unknown as {
        new (url: string, options: Bun.WebSocketOptions): WebSocket;
      };
      const socket = new BunWebSocket(
        `${connection.baseUrl.replace(/^http/, "ws")}/ws`,
        { headers: requestHeaders },
      );
      socket.binaryType = "arraybuffer";
      const received: Array<string | Uint8Array> = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Live preview WebSocket timed out"));
        }, 15_000);
        socket.addEventListener("open", () => {
          socket.send("text-through-guest");
          socket.send(bytes);
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("Live preview WebSocket failed"));
        });
        socket.addEventListener("message", (event) => {
          received.push(
            typeof event.data === "string"
              ? event.data
              : new Uint8Array(event.data),
          );
          if (received.length === 3) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      socket.close();
      expect(JSON.parse(received[0] as string)).toEqual({
        cookie: "app_session=guest-cookie",
      });
      expect(received[1]).toBe("text-through-guest");
      expect(Buffer.from(received[2] as Uint8Array)).toEqual(bytes);
      await command.kill("SIGKILL");
      await command.wait();
      await preview.delete();
    }, 60_000);

    test("allow-all provides real DNS and outbound HTTPS for package registries", async () => {
      const networked = await create({
        name: `${prefix}-network`,
        networkPolicy: "allow-all",
      });
      const response = await networked.runCommand("bun", [
        "-e",
        'const r=await fetch("https://registry.npmjs.org/bun",{signal:AbortSignal.timeout(15000)});console.log(r.status);if(!r.ok)process.exit(1)',
      ]);
      expect(response.exitCode, await response.stderr()).toBe(0);
      expect((await response.stdout()).trim()).toBe("200");
      await networked.delete();
    }, 60_000);
  },
);
