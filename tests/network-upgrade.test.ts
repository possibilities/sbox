import { expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import {
  createNetworkAuthority,
  NetworkCertificates,
} from "../src/network/certificates.ts";
import { forwardUpgrade, type UpgradeOptions } from "../src/network/upgrade.ts";

async function forwarding(
  options: (request: IncomingMessage) => UpgradeOptions,
) {
  const pending = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const task = forwardUpgrade(
      request,
      socket as Socket,
      head,
      options(request),
    ).catch(() => {
      if (!socket.destroyed)
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await Promise.allSettled([...pending]);
    },
  };
}
function upgradeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
  return headers;
}
async function opened(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  const promise = new Promise<WebSocket>((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("WebSocket connection rejected"));
  });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.close();
      reject(Error("WebSocket open timeout"));
    }, 4000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.onmessage = (event) =>
      resolve(typeof event.data === "string" ? event.data : "binary");
    socket.onerror = () => reject(Error("WebSocket failed"));
  });
}
async function rawHandshake(port: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let output = "";
    socket.on("connect", () =>
      socket.write(
        "GET /socket HTTP/1.1\r\nHost: downstream.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      ),
    );
    socket.on("data", (data) => (output += data));
    socket.on("error", reject);
    socket.on("end", () => {
      socket.destroy();
      resolve(output);
    });
    socket.setTimeout(5000, () => socket.destroy(Error("Handshake timeout")));
  });
}

test("WebSocket forwarding pins vetted addresses, retries unreachable candidates, and preserves transformed headers and bytes", async () => {
  let seenUrl = "",
    seenHost = "",
    authorization = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      seenUrl = request.url;
      seenHost = request.headers.get("host")!;
      authorization = request.headers.get("authorization")!;
      if (server.upgrade(request)) return;
      return new Response("Expected websocket", { status: 400 });
    },
    websocket: {
      message(socket, data) {
        socket.send(data);
      },
    },
  });
  const proxy = await forwarding((request) => {
    const headers = upgradeHeaders(request);
    headers.set("authorization", "Bearer host-only-secret");
    return {
      url: new URL(`http://allowed.invalid:${upstream.port}/rewritten?x=1`),
      headers,
      addresses: [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    };
  });
  let socket: WebSocket | undefined;
  try {
    socket = await opened(`ws://127.0.0.1:${proxy.port}/original`);
    const reply = message(socket);
    socket.send("unchanged payload λ");
    expect(await reply).toBe("unchanged payload λ");
    expect(seenHost).toBe(`allowed.invalid:${upstream.port}`);
    expect(new URL(seenUrl).pathname).toBe("/rewritten");
    expect(new URL(seenUrl).search).toBe("?x=1");
    expect(authorization).toBe("Bearer host-only-secret");
  } finally {
    socket?.close();
    await proxy.close();
    await upstream.stop(true);
  }
});

test("epoch cancellation closes an established WebSocket tunnel", async () => {
  const controller = new AbortController();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (!server.upgrade(request)) return new Response("no");
    },
    websocket: { message() {} },
  });
  const proxy = await forwarding((request) => ({
    url: new URL(`http://epoch.invalid:${upstream.port}`),
    headers: upgradeHeaders(request),
    addresses: [{ address: "127.0.0.1", family: 4 }],
    signal: controller.signal,
  }));
  let socket: WebSocket | undefined;
  try {
    socket = await opened(`ws://127.0.0.1:${proxy.port}`);
    const closed = new Promise<void>((resolve) => {
      socket!.onclose = () => resolve();
    });
    controller.abort();
    await Promise.race([
      closed,
      Bun.sleep(2000).then(() => {
        throw Error("Policy update left WebSocket open");
      }),
    ]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    socket?.close();
    await proxy.close();
    await upstream.stop(true);
  }
});

test("non-upgrade responses retain their status and body without following redirects", async () => {
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("redirect body", {
        status: 302,
        headers: {
          location: "http://never-follow.invalid/",
          "x-upstream": "yes",
        },
      });
    },
  });
  const proxy = await forwarding((request) => ({
    url: new URL(`http://allowed.invalid:${upstream.port}`),
    headers: upgradeHeaders(request),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  }));
  try {
    const result = await rawHandshake(proxy.port);
    expect(result).toStartWith("HTTP/1.1 302");
    expect(result.toLowerCase()).toContain(
      "location: http://never-follow.invalid/",
    );
    expect(result).toEndWith("redirect body");
    expect(result.toLowerCase()).not.toContain("transfer-encoding");
    expect(requests).toBe(1);
  } finally {
    await proxy.close();
    await upstream.stop(true);
  }
});

test("WSS uses the authorized IP while validating the destination hostname and explicit CA", async () => {
  const authority = await createNetworkAuthority();
  const leaf = await new NetworkCertificates(authority).issue("secure.invalid");
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: leaf,
    fetch(request, server) {
      if (!server.upgrade(request)) return new Response("no");
    },
    websocket: {
      message(socket, data) {
        socket.send(data);
      },
    },
  });
  let host = "secure.invalid",
    trust: string | undefined = authority.cert;
  const proxy = await forwarding((request) => ({
    url: new URL(`https://${host}:${upstream.port}`),
    headers: upgradeHeaders(request),
    addresses: [{ address: "127.0.0.1", family: 4 }],
    upstreamCA: trust,
  }));
  let socket: WebSocket | undefined;
  try {
    socket = await opened(`ws://127.0.0.1:${proxy.port}`);
    const reply = message(socket);
    socket.send("trusted TLS");
    expect(await reply).toBe("trusted TLS");
    socket.close();
    host = "wrong.invalid";
    await expect(opened(`ws://127.0.0.1:${proxy.port}`)).rejects.toThrow(
      "rejected",
    );
    host = "secure.invalid";
    trust = undefined;
    await expect(opened(`ws://127.0.0.1:${proxy.port}`)).rejects.toThrow(
      "rejected",
    );
  } finally {
    socket?.close();
    await proxy.close();
    await upstream.stop(true);
  }
});

test("bytes buffered with either upgrade handshake survive unchanged", async () => {
  const { createHash } = await import("node:crypto");
  const fromGuest = Buffer.from([0x82, 0x84, 1, 2, 3, 4, 20, 21, 22, 23]);
  const fromUpstream = Buffer.from([0x82, 4, 0, 255, 42, 128]);
  let received = Buffer.alloc(0);
  const upstreamSockets = new Set<Socket>();
  const upstream = createServer();
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSockets.add(socket as Socket);
    socket.on("error", () => {});
    received = Buffer.concat([received, head]);
    socket.on("data", (data) => {
      received = Buffer.concat([received, Buffer.from(data)]);
    });
    const accept = createHash("sha1")
      .update(
        String(request.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ),
        fromUpstream,
      ]),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const proxy = await forwarding((request) => ({
    url: new URL(
      `http://buffered.invalid:${(upstream.address() as AddressInfo).port}`,
    ),
    headers: upgradeHeaders(request),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  }));
  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1");
      let response = Buffer.alloc(0);
      socket.on("connect", () =>
        socket.write(
          Buffer.concat([
            Buffer.from(
              "GET / HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            ),
            fromGuest,
          ]),
        ),
      );
      socket.on("error", reject);
      socket.on("data", (data) => {
        response = Buffer.concat([response, Buffer.from(data)]);
        const separator = response.indexOf("\r\n\r\n");
        if (
          separator >= 0 &&
          response.length >= separator + 4 + fromUpstream.length
        ) {
          const body = response.subarray(separator + 4);
          setTimeout(() => {
            socket.destroy();
            resolve(body);
          }, 20);
        }
      });
      socket.setTimeout(2000, () =>
        socket.destroy(Error("Buffered frame timeout")),
      );
    });
    expect(actual).toEqual(fromUpstream);
    expect(received).toEqual(fromGuest);
  } finally {
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    upstream.close();
  }
});
