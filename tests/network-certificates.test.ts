import { describe, expect, test } from "bun:test";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer, get } from "node:https";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNetworkAuthority,
  NetworkCertificates,
  networkTrustFile,
} from "../src/network/certificates.ts";

const authority = await createNetworkAuthority();
const certificates = new NetworkCertificates(authority);
const day = 86400000;

describe("network certificate authority", () => {
  test("creates a self-signed CA and server-only exact-host leaf with independent matching keys", async () => {
    const ca = new X509Certificate(authority.cert);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe(ca.issuer);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(ca.checkPrivateKey(createPrivateKey(authority.key))).toBe(true);
    const identity = await certificates.issue("api.example.test");
    const leaf = new X509Certificate(identity.cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkPrivateKey(createPrivateKey(identity.key))).toBe(true);
    expect(identity.key).not.toBe(authority.key);
    expect(leaf.checkHost("api.example.test")).toBe("api.example.test");
    expect(leaf.checkHost("other.example.test")).toBeUndefined();
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(Date.parse(leaf.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(leaf.validTo)).toBeGreaterThan(Date.now() + 6 * day);
    expect(Date.parse(leaf.validTo)).toBeLessThanOrEqual(
      Date.parse(ca.validTo),
    );
  });

  test("encodes DNS IDNA and IPv4/IPv6 SANs correctly, without wildcard certificates", async () => {
    for (const address of [
      "127.0.0.1",
      "192.0.2.10",
      "::1",
      "2001:db8::abcd",
    ]) {
      const leaf = new X509Certificate(
        (await certificates.issue(address)).cert,
      );
      expect(leaf.checkIP(address)).toBe(address);
      expect(leaf.checkHost("other.example")).toBeUndefined();
    }
    const idna = new X509Certificate(
      (await certificates.issue("bücher.example")).cert,
    );
    expect(idna.checkHost("xn--bcher-kva.example")).toBe(
      "xn--bcher-kva.example",
    );
    expect(idna.subjectAltName).toBe("DNS:xn--bcher-kva.example");
    const ipv6 = await certificates.issue("[2001:DB8:0:0:0:0:0:ABCD]");
    expect(ipv6).toBe(await certificates.issue("2001:db8::abcd"));
    expect(await certificates.issue("API.EXAMPLE.TEST.")).toBe(
      await certificates.issue("api.example.test"),
    );
  });

  test("rejects malformed names before creating an identity", async () => {
    for (const host of [
      "",
      "*.example.test",
      "host:443",
      "https://host",
      "a/b",
      "a@host",
      "a\0b",
      "a\nb",
      "CN=example,O=injected",
      "a..test",
      "-a.test",
      "host%zone",
      "[::1]:443",
      ".",
      `${"a".repeat(64)}.test`,
    ])
      await expect(certificates.issue(host)).rejects.toThrow("hostname");
  });

  test("exports guest trust as a readonly public certificate without private material", () => {
    const file = networkTrustFile(authority);
    expect(file.path).toBe("/etc/sbox/network-ca.pem");
    expect(file.mode).toBe(0o444);
    expect(file.content).toBe(authority.cert);
    expect(file.content).not.toContain("PRIVATE KEY");
    expect(Object.keys(file).sort()).toEqual(["content", "mode", "path"]);
    expect(() =>
      networkTrustFile({ cert: authority.cert + "\n" + authority.key }),
    ).toThrow("public CA");
  });

  test("rejects mismatched, expired, future, and non-CA trust material", async () => {
    const other = await createNetworkAuthority();
    expect(
      () => new NetworkCertificates({ cert: authority.cert, key: other.key }),
    ).toThrow("authority");
    expect(
      () =>
        new NetworkCertificates({
          cert: "not a certificate",
          key: authority.key,
        }),
    ).toThrow("authority");
    const leaf = await certificates.issue("untrusted.example");
    expect(() => new NetworkCertificates(leaf)).toThrow("authority");
    const now = Date.now();
    const expired = await createNetworkAuthority({
      now: now - 3 * day,
      validityMs: day,
    });
    expect(() => new NetworkCertificates(expired)).toThrow("authority");
    const future = await createNetworkAuthority({ now: now + day });
    expect(() => new NetworkCertificates(future)).toThrow("authority");
    const restored = new NetworkCertificates(
      JSON.parse(JSON.stringify(authority)),
    );
    expect(
      new X509Certificate(
        (await restored.issue("restored.example")).cert,
      ).verify(new X509Certificate(authority.cert).publicKey),
    ).toBe(true);
  });

  test("deduplicates concurrent issuance, evicts least recently used entries, and renews before expiration", async () => {
    let now = Date.now();
    const issuer = new NetworkCertificates(authority, {
      now: () => now,
      maxCached: 2,
      maxPending: 1,
    });
    const first = issuer.issue("one.example"),
      same = issuer.issue("ONE.EXAMPLE.");
    expect(first).toBe(same);
    await expect(issuer.issue("busy.example")).rejects.toThrow("concurrent");
    const one = await first,
      two = await issuer.issue("two.example");
    expect(await issuer.issue("one.example")).toBe(one);
    await issuer.issue("three.example");
    expect((await issuer.issue("two.example")).cert).not.toBe(two.cert);
    const before = await issuer.issue("renew.example");
    now += 7 * day - 30 * 60000;
    const after = await issuer.issue("renew.example");
    expect(after.cert).not.toBe(before.cert);
    expect(Date.parse(new X509Certificate(after.cert).validTo)).toBeGreaterThan(
      now + 6 * day,
    );
  });

  test("real TLS accepts the correct CA and name, and rejects an unrelated CA and wrong host", async () => {
    const identity = await certificates.issue("origin.example.test");
    const server = createServer(identity, (_request, response) =>
      response.end("verified"),
    );
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No TLS listen address");
    const request = (ca: string, servername: string) =>
      new Promise<string>((resolve, reject) => {
        const req = get(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/",
            servername,
            ca,
            agent: false,
            rejectUnauthorized: true,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.once("end", () => resolve(body));
            res.once("error", reject);
          },
        );
        req.once("error", reject);
        req.setTimeout(3000, () =>
          req.destroy(new Error("TLS handshake timed out")),
        );
      });
    try {
      expect(await request(authority.cert, "origin.example.test")).toBe(
        "verified",
      );
      await expect(
        request(authority.cert, "wrong.example.test"),
      ).rejects.toThrow();
      const unrelated = await createNetworkAuthority();
      await expect(
        request(unrelated.cert, "origin.example.test"),
      ).rejects.toThrow();
      await expect(request("", "origin.example.test")).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);

  test("runs as a compiled Bun executable without openssl or node_modules at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbox-network-cert-compiled-"));
    try {
      const entry = join(root, "entry.ts"),
        binary = join(root, "certificate-test");
      await writeFile(
        entry,
        `import {createNetworkAuthority,NetworkCertificates} from ${JSON.stringify(new URL("../src/network/certificates.ts", import.meta.url).pathname)}; import {X509Certificate} from 'node:crypto'; const a=await createNetworkAuthority(); const b=await new NetworkCertificates(a).issue('compiled.example'); console.log(new X509Certificate(b.cert).verify(new X509Certificate(a.cert).publicKey));`,
      );
      const build = Bun.spawn(
        [process.execPath, "build", entry, "--compile", "--outfile", binary],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [buildOut, buildError, buildCode] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect(buildCode, buildOut + buildError).toBe(0);
      const run = Bun.spawn([binary], {
        cwd: root,
        env: { PATH: "/nonexistent" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, error, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect(code, error).toBe(0);
      expect(out.trim()).toBe("true");
      expect(error).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
