import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createRelay, type Socket } from "node:net";
import {
  CompiledPolicy,
  redactPolicy,
  validatePolicy,
} from "../src/network/policy.ts";
import { PolicyProxy } from "../src/network/proxy.ts";
import {
  createNetworkAuthority,
  NetworkCertificates,
} from "../src/network/certificates.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return (server.address() as { port: number }).port;
};
const authority = await createNetworkAuthority();
const BunWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
const certificates = new NetworkCertificates(authority);
async function proxy(
  configuration: ConstructorParameters<typeof PolicyProxy>[0],
  lookup?: ConstructorParameters<typeof PolicyProxy>[1]["lookup"],
) {
  const instance = new PolicyProxy(configuration, {
    certificates,
    lookup: lookup ?? (async () => [{ address: "127.0.0.1", family: 4 }]),
    upstreamCA: authority.cert,
  });
  const internalPort = await instance.listen();
  const sockets = new Set<Socket>();
  const relay = createRelay((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    void instance
      .connectProxy()
      .then((upstream) => {
        socket.once("close", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        upstream.once("close", () => socket.destroy());
        socket.pipe(upstream);
        upstream.pipe(socket);
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const port = (relay.address() as { port: number }).port;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  cleanups.push(() => instance.close());
  return { instance, internalPort, url: `http://127.0.0.1:${port}` };
}
async function httpThrough(
  proxyUrl: string,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
  } = {},
) {
  return await new Promise<{
    status: number;
    body: Buffer;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const request = httpRequest(
      proxyUrl,
      {
        method: options.method ?? "GET",
        path: url,
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks),
            headers: response.headers,
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
describe("Mediated network policy", () => {
  test("host-only listener capabilities reject direct clients and cross-sandbox localhost scans", async () => {
    const protectedProxy = await proxy({
      policy: {
        allow: {
          "private.invalid": [
            {
              response: {
                statusCode: 200,
                body: "private-response",
                contentType: "text/plain",
              },
            },
          ],
        },
      },
    });
    await expect(
      httpThrough(
        `http://127.0.0.1:${protectedProxy.internalPort}`,
        "http://private.invalid/",
      ),
    ).rejects.toThrow();
    const other = await proxy({
      policy: { subnets: { allow: ["127.0.0.0/8"] } },
    });
    const socket = await other.instance.connectTCP(
      "127.0.0.1",
      protectedProxy.internalPort,
    );
    const response = await socketRequest(
      socket,
      "GET http://private.invalid/ HTTP/1.1\r\nHost: private.invalid\r\nConnection: close\r\n\r\n",
    ).catch(() => "");
    expect(response).not.toContain("private-response");
    expect(
      (
        await httpThrough(protectedProxy.url, "http://private.invalid/")
      ).body.toString(),
    ).toBe("private-response");
  });
  test("matches RE2 path, methods, query and header dimensions with declaration-order fallthrough", () => {
    const compiled = new CompiledPolicy({
      allow: {
        "api.example.com": [
          {
            match: {
              path: { regex: "^/v[0-9]+/" },
              method: ["POST"],
              queryString: [
                { key: { exact: "mode" }, value: { startsWith: "safe" } },
              ],
              headers: [{ key: { exact: "x-test" }, value: { exact: "yes" } }],
            },
            transform: [{ headers: { authorization: "host-secret" } }],
          },
          { response: { statusCode: 403 } },
        ],
      },
    });
    expect(
      compiled.request({
        url: new URL("https://api.example.com/v1/read?mode=safe-copy"),
        method: "POST",
        headers: new Headers({ "x-test": "yes" }),
      }).rule?.transform?.[0]?.headers?.authorization,
    ).toBe("host-secret");
    expect(
      compiled.request({
        url: new URL("https://api.example.com/v1/read?mode=bad"),
        method: "POST",
        headers: new Headers({ "x-test": "yes" }),
      }).rule?.response?.statusCode,
    ).toBe(403);
    expect(compiled.addressAllowed("api.example.com", "1.2.3.4")).toBe(true);
    expect(compiled.addressAllowed("other.example.com", "1.2.3.4")).toBe(false);
    expect(() =>
      validatePolicy({
        allow: {
          "api.example.com": [
            {
              match: { path: { regex: "(?=evil)" } },
              response: { statusCode: 403 },
            },
          ],
        },
      }),
    ).toThrow("RE2");
  });
  test("CIDR denies override domains, CIDR grants bypass domain lists, including IPv6 and IPv4-mapped IPv6", () => {
    const p = new CompiledPolicy({
      allow: ["allowed.example"],
      subnets: {
        allow: ["10.0.0.0/8", "2001:db8::/32"],
        deny: ["10.1.0.0/16", "2001:db8:1::/48"],
      },
    });
    expect(p.addressAllowed("other.example", "10.2.0.1")).toBe(true);
    expect(p.addressAllowed("allowed.example", "10.1.0.1")).toBe(false);
    expect(p.addressAllowed("allowed.example", "::ffff:10.1.0.1")).toBe(false);
    expect(p.addressAllowed("other.example", "2001:db8:2::1")).toBe(true);
    expect(p.addressAllowed("allowed.example", "2001:db8:1::1")).toBe(false);
  });
  test("validates transformations, synthetic responses, redirect routing and public redaction", () => {
    for (const invalid of [
      {
        allow: {
          "example.com": [{ transform: [{ headers: { host: "internal" } }] }],
        },
      },
      { allow: { "example.com": [{ forwardURL: "http://internal" }] } },
      {
        allow: {
          "example.com": [
            {
              response: {
                statusCode: 204,
                body: "bad",
                contentType: "text/plain",
              },
            },
          ],
        },
      },
      {
        allow: {
          "example.com": [{ response: { statusCode: 200, body: "bad" } }],
        },
      },
      {
        allow: {
          "example.com": [{ response: { statusCode: 200 }, transform: [] }],
        },
      },
      { subnets: { allow: ["10.0.0.1/33"] } },
    ])
      expect(() => validatePolicy(invalid)).toThrow();
    const full = {
      allow: {
        "example.com": [
          { transform: [{ headers: { authorization: "secret" } }] },
        ],
      },
    };
    expect(JSON.stringify(redactPolicy(full))).not.toContain("secret");
    expect(JSON.stringify(full)).toContain("secret");
  });
  test("blocks private control-plane destinations unless CIDRs explicitly grant access", async () => {
    let contacted = 0;
    const upstream = await listen(
      createServer((_q, r) => {
        contacted++;
        r.end("private");
      }),
    );
    const p = await proxy({ policy: { allow: ["*"] } });
    expect(
      (await httpThrough(p.url, `http://localhost:${upstream}/`)).status,
    ).toBe(403);
    expect(contacted).toBe(0);
    p.instance.update({
      policy: { allow: ["*"], subnets: { allow: ["127.0.0.0/8"] } },
    });
    expect(
      (
        await httpThrough(p.url, `http://localhost:${upstream}/`)
      ).body.toString(),
    ).toBe("private");
    p.instance.update({
      policy: {
        allow: ["*"],
        subnets: { allow: ["127.0.0.0/8"], deny: ["127.0.0.1/32"] },
      },
    });
    expect(
      (await httpThrough(p.url, `http://localhost:${upstream}/`)).status,
    ).toBe(403);
    expect(contacted).toBe(1);
  });
  test("returns ordered synthetic responses without DNS or upstream traffic", async () => {
    let resolutions = 0;
    const p = await proxy(
      {
        policy: {
          allow: {
            "virtual.invalid": [
              {
                match: { path: { exact: "/ok" } },
                response: {
                  statusCode: 200,
                  body: "synthetic",
                  contentType: "text/plain",
                },
              },
              { response: { statusCode: 403 } },
            ],
          },
        },
      },
      async () => {
        resolutions++;
        throw new Error("No DNS expected");
      },
    );
    expect(
      (await httpThrough(p.url, "http://virtual.invalid/ok")).body.toString(),
    ).toBe("synthetic");
    expect((await httpThrough(p.url, "http://virtual.invalid/no")).status).toBe(
      403,
    );
    expect(resolutions).toBe(0);
  });
  test("streams binary HTTP bodies, injects host-only transforms, and pins resolved destinations", async () => {
    let sawSecret = false,
      sawHost = "";
    const data = crypto.getRandomValues(new Uint8Array(65536));
    const upstream = await listen(
      createServer((request, response) => {
        sawSecret = request.headers.authorization === "Bearer host-secret";
        sawHost = request.headers.host!;
        request.pipe(response);
      }),
    );
    let lookups = 0;
    const p = await proxy(
      {
        policy: {
          allow: {
            "api.example.com": [
              {
                transform: [
                  { headers: { authorization: "Bearer host-secret" } },
                ],
              },
            ],
          },
          subnets: { allow: ["127.0.0.0/8"] },
        },
      },
      async () => {
        lookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    );
    const response = await httpThrough(
      p.url,
      `http://api.example.com:${upstream}/echo`,
      { method: "POST", headers: { authorization: "mock" }, body: data },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from(data));
    expect(sawSecret).toBe(true);
    expect(sawHost).toBe(`api.example.com:${upstream}`);
    expect(lookups).toBe(1);
  });
  test("retries only approved DNS addresses without resolving again", async () => {
    const upstream = await listen(
      createServer((_request, response) => response.end("fallback")),
    );
    let lookups = 0;
    const p = await proxy(
      {
        policy: {
          allow: ["api.example.com"],
          subnets: { allow: ["127.0.0.0/8"], deny: ["127.0.0.3/32"] },
        },
      },
      async () => {
        lookups++;
        return [
          { address: "::1", family: 6 },
          { address: "127.0.0.3", family: 4 },
          { address: "127.0.0.2", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ];
      },
    );
    const reply = await httpThrough(
      p.url,
      `http://api.example.com:${upstream}/`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("fallback");
    expect(lookups).toBe(1);
  });
  test("terminates CONNECT TLS outside the guest, applies scoped credentials, and rotates on live update", async () => {
    const leaf = await certificates.issue("api.example.com");
    const upstream = await listen(
      createSecureServer(leaf, (request, response) =>
        response.end(request.headers.authorization ?? "missing"),
      ),
    );
    const config = {
      policy: {
        allow: ["api.example.com"],
        subnets: { allow: ["127.0.0.0/8"] },
      },
      credentials: {
        API_KEY: {
          source: { env: "REAL_KEY" },
          inject: [
            {
              hosts: ["api.example.com"],
              as: { header: "Authorization", format: "Bearer ${value}" },
            },
          ],
        },
      },
      credentialSecrets: { REAL_KEY: "secret-one" },
    };
    const p = await proxy(config);
    const fetchThrough = () =>
      fetch(`https://api.example.com:${upstream}/`, {
        proxy: p.url,
        tls: { ca: authority.cert },
        headers: { authorization: "Bearer mock-API_KEY" },
      });
    expect(await (await fetchThrough()).text()).toBe("Bearer secret-one");
    p.instance.update({
      ...config,
      credentialSecrets: { REAL_KEY: "secret-two" },
    });
    expect(await (await fetchThrough()).text()).toBe("Bearer secret-two");
  }, 15000);
  test("forwardURL preserves original request metadata and does not automatically follow redirects", async () => {
    const leaf = await certificates.issue("forward.example.com");
    let metadata: any;
    const upstream = await listen(
      createSecureServer(leaf, (request, response) => {
        metadata = {
          path: request.url,
          host: request.headers["vercel-forwarded-host"],
          original: request.headers["vercel-forwarded-path"],
          sandbox: request.headers["x-sbox-sandbox-id"],
        };
        response.writeHead(302, { location: "http://127.0.0.1/secret" });
        response.end();
      }),
    );
    const p = await proxy({
      sandboxId: "sbx-test",
      policy: {
        allow: {
          "api.example.com": [
            { forwardURL: `https://forward.example.com:${upstream}/gateway` },
          ],
        },
        subnets: { allow: ["127.0.0.0/8"] },
      },
    });
    const reply = await httpThrough(
      p.url,
      "http://api.example.com/v1/test?a=1",
    );
    expect(reply.status).toBe(302);
    expect(metadata).toEqual({
      path: "/gateway/v1/test?a=1",
      host: "api.example.com",
      original: "/v1/test?a=1",
      sandbox: "sbx-test",
    });
  });
  test("applies HTTPS WebSocket policy and credentials before upgrading, streams binary, and revokes live tunnels", async () => {
    let authorization = "",
      transformed = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: await certificates.issue("api.example.com"),
      fetch(request, server) {
        authorization = request.headers.get("authorization") ?? "";
        transformed = request.headers.get("x-host-only") ?? "";
        if (server.upgrade(request)) return;
        return new Response("Upgrade required", { status: 400 });
      },
      websocket: {
        message(socket, data) {
          socket.send(data);
        },
      },
    });
    cleanups.push(async () => {
      upstream.stop(true);
    });
    const config = {
      policy: {
        allow: {
          "api.example.com": [
            {
              match: { path: { exact: "/socket" } },
              transform: [{ headers: { "x-host-only": "injected" } }],
            },
            { response: { statusCode: 403 } },
          ],
        },
        subnets: { allow: ["127.0.0.0/8"] },
      },
      credentials: {
        API_KEY: {
          source: { env: "REAL_KEY" },
          inject: [
            {
              hosts: ["api.example.com"],
              as: { header: "authorization", format: "Bearer ${value}" },
            },
          ],
        },
      },
      credentialSecrets: { REAL_KEY: "host-only-key" },
    };
    const p = await proxy(config);
    const open = async (path: string) => {
      const socket = new BunWebSocket(
        `wss://api.example.com:${upstream.port}${path}`,
        {
          proxy: p.url,
          tls: { ca: authority.cert },
          headers: { authorization: "mock-API_KEY" },
        },
      );
      socket.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Upgrade denied"));
      });
      cleanups.push(async () => socket.close());
      return socket;
    };
    const socket = await open("/socket");
    expect(authorization).toBe("Bearer host-only-key");
    expect(transformed).toBe("injected");
    const message = new Promise<ArrayBuffer>((resolve) => {
      socket.onmessage = (event) => resolve(event.data as ArrayBuffer);
    });
    socket.send(new Uint8Array([0, 255, 128, 42]));
    expect(new Uint8Array(await message)).toEqual(
      new Uint8Array([0, 255, 128, 42]),
    );
    await expect(open("/blocked")).rejects.toThrow("Upgrade denied");
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    p.instance.update({ ...config, policy: "deny-all" });
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  }, 15000);
});

function dnsQuestion(host: string, type = 1): Buffer {
  const labels = host
    .split(".")
    .map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
    );
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1234);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}
async function socketRequest(
  socket: import("node:net").Socket,
  data: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    socket.on("data", (data) => chunks.push(Buffer.from(data)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.once("error", reject);
    socket.write(data);
  });
}
describe("Transparent network routing", () => {
  test("wildcard grants cannot use IP aliases or mismatched TLS authority to evade specific HTTP rules", async () => {
    let resolutions = 0;
    const p = await proxy(
      {
        policy: {
          allow: {
            "api.example.com": [{ response: { statusCode: 403 } }],
            "*": [],
          },
        },
      },
      async () => {
        resolutions++;
        return [{ address: "203.0.113.17", family: 4 }];
      },
    );
    await expect(p.instance.connectTCP("203.0.113.17", 8443)).rejects.toThrow();
    const { connect: tlsConnect } = await import("node:tls");
    const raw = await p.instance.connectTCP("alias.example.com", 8443);
    const socket = tlsConnect({
      socket: raw,
      servername: "api.example.com",
      rejectUnauthorized: false,
    });
    const response = await socketRequest(
      socket,
      "GET /forbidden HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n",
    );
    expect(response).toContain("400 Bad Request");
    expect(resolutions).toBe(1);
    const direct = await p.instance.connectTCP("api.example.com", 8443);
    expect(
      await socketRequest(
        direct,
        "GET /forbidden HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n",
      ),
    ).toContain("403 Forbidden");
    expect(resolutions).toBe(1);
  });
  test("binds synthetic DNS to names and inspects plaintext HTTP on arbitrary ports", async () => {
    let injected = "";
    let contacts = 0;
    const upstream = await listen(
      createServer((request, response) => {
        injected = String(request.headers["x-host-secret"]);
        contacts++;
        response.end("ok");
      }),
    );
    const p = await proxy({
      policy: {
        allow: {
          "api.example.test": [
            {
              match: { path: { exact: "/yes" } },
              transform: [{ headers: { "x-host-secret": "private" } }],
            },
            { response: { statusCode: 403 } },
          ],
        },
        subnets: { allow: ["127.0.0.0/8"] },
      },
    });
    const dns = await p.instance.answerDNS(dnsQuestion("api.example.test"));
    expect(dns.readUInt16BE(6)).toBe(1);
    const fake = [...dns.subarray(-4)].join(".");
    expect(fake).toStartWith("198.18.");
    const socket = await p.instance.connectTCP(fake, upstream);
    const response = await socketRequest(
      socket,
      `GET /yes HTTP/1.1\r\nHost: api.example.test:${upstream}\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toContain("200");
    expect(injected).toBe("private");
    const blocked = await p.instance.connectTCP(fake, upstream);
    expect(
      await socketRequest(
        blocked,
        `GET /no HTTP/1.1\r\nHost: api.example.test:${upstream}\r\nConnection: close\r\n\r\n`,
      ),
    ).toContain("403");
    expect(contacts).toBe(1);
    p.instance.update({ policy: "deny-all" });
    expect(
      (
        await p.instance.answerDNS(dnsQuestion("api.example.test"))
      ).readUInt16BE(2) & 15,
    ).toBe(5);
    await expect(p.instance.connectTCP(fake, upstream)).rejects.toMatchObject({
      code: "NETWORK_DENIED",
    });
  });
  test("bounds DNS protocol support and never resolves unallowed names", async () => {
    let lookups = 0;
    const p = await proxy(
      { policy: { allow: ["api.example.test"] } },
      async () => {
        lookups++;
        return [{ address: "1.2.3.4", family: 4 }];
      },
    );
    expect(
      (
        await p.instance.answerDNS(dnsQuestion("bad.example.test"))
      ).readUInt16BE(2) & 15,
    ).toBe(5);
    expect(
      (
        await p.instance.answerDNS(dnsQuestion("api.example.test", 16))
      ).readUInt16BE(2) & 15,
    ).toBe(5);
    expect(
      (
        await p.instance.answerDNS(dnsQuestion("api.example.test", 28))
      ).readUInt16BE(6),
    ).toBe(0);
    expect(lookups).toBe(0);
    await expect(p.instance.answerDNS(Buffer.alloc(2))).rejects.toThrow();
  });
  test("revokes active raw TCP streams when policy changes", async () => {
    const { createServer } = await import("node:net");
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const p = await proxy({
      policy: { allow: ["*"], subnets: { allow: ["127.0.0.0/8"] } },
    });
    const socket = await p.instance.connectTCP(
      "127.0.0.1",
      (server.address() as { port: number }).port,
    );
    const echoed = new Promise<string>((resolve) =>
      socket.once("data", (data) => resolve(data.toString())),
    );
    socket.write("before");
    expect(await echoed).toBe("before");
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    p.instance.update({ policy: "deny-all" });
    await closed;
    expect(socket.destroyed).toBe(true);
  });
  test("relays authorized UDP but rejects attempts to bypass L7 rules with datagrams", async () => {
    const { createSocket } = await import("node:dgram");
    const echo = createSocket("udp4");
    echo.on("message", (data, peer) =>
      echo.send(data, peer.port, peer.address),
    );
    await new Promise<void>((resolve) => echo.bind(0, "127.0.0.1", resolve));
    cleanups.push(async () => echo.close());
    const p = await proxy({
      policy: {
        allow: ["udp.example.test"],
        subnets: { allow: ["127.0.0.0/8"] },
      },
    });
    const dns = await p.instance.answerDNS(dnsQuestion("udp.example.test"));
    const header = Buffer.alloc(10);
    header[3] = 1;
    dns.copy(header, 4, dns.length - 4);
    header.writeUInt16BE(echo.address().port, 8);
    const bytes = Buffer.from([0, 255, 128, 42]);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      void p.instance
        .sendDatagram("1", Buffer.concat([header, bytes]), resolve)
        .catch(reject);
    });
    expect(reply).toEqual(Buffer.concat([header, bytes]));
    p.instance.update({
      policy: {
        allow: { "udp.example.test": [{ response: { statusCode: 403 } }] },
        subnets: { allow: ["127.0.0.0/8"] },
      },
    });
    await expect(
      p.instance.sendDatagram("1", Buffer.concat([header, bytes]), () => {}),
    ).rejects.toMatchObject({ code: "NETWORK_DENIED" });
    header[2] = 1;
    await expect(
      p.instance.sendDatagram("1", Buffer.concat([header, bytes]), () => {}),
    ).rejects.toThrow("Fragmented");
  });
});
