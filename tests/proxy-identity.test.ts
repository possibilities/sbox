import { expect, test } from "bun:test";
import { createProxyIdentity, ProxyIdentity } from "../src/network/identity.ts";
import { defineSandboxProxy } from "../src/sdk/proxy.ts";
const sandboxId = "sbx-" + "a".repeat(24);
const targetUrl = "https://proxy.example.com/gateway/v1/test?q=1";
const originalUrl = "https://api.example.com/v1/test?q=1";
function fixture() {
  const identity = new ProxyIdentity(createProxyIdentity());
  return {
    identity,
    sign: (overrides = {}) =>
      identity.sign({
        sandboxId,
        sandboxName: "demo",
        originalUrl,
        targetUrl,
        method: "POST",
        ...overrides,
      }),
  };
}
test("signed proxy preserves streamed bytes and authenticates original request metadata", async () => {
  const { identity, sign } = fixture();
  const handler = defineSandboxProxy(async (request, meta) => {
    expect(request.url).toBe(originalUrl);
    expect(request.headers.get("host")).toBe("api.example.com");
    expect(request.headers.get("x-sbox-proxy-token")).toBeNull();
    expect(request.headers.get("vercel-forwarded-host")).toBeNull();
    expect(meta).toEqual({
      host: "proxy.example.com",
      sandboxId,
      sandboxName: "demo",
    });
    return new Response(request.body);
  }, identity.public);
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const token = sign();
  const response = await handler(
    new Request(targetUrl, {
      method: "POST",
      headers: {
        "x-sbox-proxy-token": token,
        "vercel-forwarded-host": "spoofed.invalid",
      },
      body: bytes,
    }),
  );
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(
    (
      await handler(
        new Request(targetUrl, {
          method: "POST",
          headers: { "x-sbox-proxy-token": token },
          body: bytes,
        }),
      )
    ).status,
  ).toBe(403);
});
test("forged tokens, foreign issuer/key, wrong destination/path/method and missing signatures fail closed", async () => {
  const { identity, sign } = fixture();
  const handler = defineSandboxProxy(
    () => new Response("accepted"),
    identity.public,
  );
  const headers = (token: string) => ({ "x-sbox-proxy-token": token });
  for (const request of [
    new Request(targetUrl),
    new Request(targetUrl, {
      method: "POST",
      headers: headers(sign().replace(/.$/, "!")),
    }),
    new Request(targetUrl, {
      method: "POST",
      headers: headers(fixture().sign()),
    }),
    new Request(targetUrl + "x", { method: "POST", headers: headers(sign()) }),
    new Request(targetUrl.replace("proxy.example.com", "evil.example.com"), {
      method: "POST",
      headers: headers(sign()),
    }),
    new Request(targetUrl, { method: "PUT", headers: headers(sign()) }),
  ])
    expect((await handler(request)).status).toBe(403);
  const wrongIssuer = defineSandboxProxy(() => new Response("accepted"), {
    ...identity.public,
    issuer: "urn:sbox:wrong",
  });
  expect(
    (
      await wrongIssuer(
        new Request(targetUrl, { method: "POST", headers: headers(sign()) }),
      )
    ).status,
  ).toBe(403);
});
test("explicit public audience supports TLS termination without trusting forwarded host headers", async () => {
  const { identity, sign } = fixture();
  const handler = defineSandboxProxy(() => new Response("ok"), {
    ...identity.public,
    audience: "https://proxy.example.com",
  });
  expect(
    (
      await handler(
        new Request(
          targetUrl.replace(
            "https://proxy.example.com",
            "http://127.0.0.1:8080",
          ),
          { method: "POST", headers: { "x-sbox-proxy-token": sign() } },
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1:8080/wrong", {
          method: "POST",
          headers: { "x-sbox-proxy-token": sign() },
        }),
      )
    ).status,
  ).toBe(403);
});
test("handler exceptions remain application failures and are not misreported as authentication failures", async () => {
  const { identity, sign } = fixture();
  const handler = defineSandboxProxy(() => {
    throw new Error("application failure");
  }, identity.public);
  await expect(
    handler(
      new Request(targetUrl, {
        method: "POST",
        headers: { "x-sbox-proxy-token": sign() },
      }),
    ),
  ).rejects.toThrow("application failure");
});

test("real forwarding pipeline signs the rewritten destination and verifier restores the original request", async () => {
  const { createNetworkAuthority, NetworkCertificates } = await import(
    "../src/network/certificates.ts"
  );
  const { PolicyProxy } = await import("../src/network/proxy.ts");
  const ca = await createNetworkAuthority();
  const certificates = new NetworkCertificates(ca);
  const identity = new ProxyIdentity(createProxyIdentity());
  let receivedUrl = "",
    receivedSandbox = "";
  const handler = defineSandboxProxy(async (request, meta) => {
    receivedUrl = request.url;
    receivedSandbox = meta.sandboxId;
    return new Response(await request.arrayBuffer());
  }, identity.public);
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: await certificates.issue("forward.example.com"),
    fetch: handler,
  });
  const proxy = new PolicyProxy(
    {
      sandboxId,
      policy: {
        allow: {
          "source.invalid": [
            {
              forwardURL: `https://forward.example.com:${upstream.port}/gateway`,
            },
          ],
        },
        subnets: { allow: ["127.0.0.0/8"] },
      },
    },
    {
      certificates,
      forwardIdentity: identity,
      upstreamCA: ca.cert,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );
  try {
    const { request: httpRequest, Agent } = await import("node:http");
    await proxy.listen();
    const socket = await proxy.connectProxy();
    const agent = new Agent();
    agent.createConnection = () => socket;
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const response = await new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "source.invalid",
          path: "http://source.invalid/v1/path?q=yes",
          method: "POST",
          agent,
          headers: {
            "content-length": bytes.length,
            "x-sbox-proxy-token": "spoofed",
            "vercel-forwarded-host": "evil.invalid",
          },
        },
        async (incoming) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
              }),
            );
          } catch (error) {
            reject(error);
          }
        },
      );
      request.once("error", reject);
      request.end(bytes);
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(receivedUrl).toBe("http://source.invalid/v1/path?q=yes");
    expect(receivedSandbox).toBe(sandboxId);
  } finally {
    await proxy.close();
    await upstream.stop(true);
  }
});

test("SDK retrieves only the authenticated public identity and restart keeps the same trusted key", async () => {
  const { startServer, Store } = await import("../src/server/index.ts");
  const { HypemanBackend } = await import("../src/hypeman/index.ts");
  const { getSandboxProxyIdentity } = await import("../src/sdk/proxy.ts");
  const store = new Store(":memory:");
  const backend = new HypemanBackend({
    baseUrl: "http://127.0.0.1:1",
    fetch: (async () => {
      throw Error("No provider calls expected");
    }) as unknown as typeof fetch,
  });
  const token = crypto.randomUUID();
  let server = await startServer({ backend, store, port: 0, token });
  try {
    expect((await fetch(new URL("v1/proxy-identity", server.url))).status).toBe(
      401,
    );
    const publicIdentity = await getSandboxProxyIdentity({
      baseUrl: server.url.toString(),
      token,
    });
    expect(publicIdentity.algorithm).toBe("Ed25519");
    expect(publicIdentity.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(JSON.stringify(publicIdentity)).not.toContain("PRIVATE");
    await server.stop(true);
    server = await startServer({ backend, store, port: 0, token });
    expect(
      await getSandboxProxyIdentity({ baseUrl: server.url.toString(), token }),
    ).toEqual(publicIdentity);
  } finally {
    await server.stop(true);
    store.close();
  }
});
