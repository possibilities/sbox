import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicClone } from "../src/host/atomic-clone.ts";
import { startHostServer } from "../src/host/index.ts";

const sourceId = `drv-${"a".repeat(24)}`,
  targetId = `dgs-${"b".repeat(24)}`,
  otherId = `drv-${"c".repeat(24)}`;
const token = "test-storage-token-0123456789";
const original = Buffer.alloc(4096, 0x41),
  destination = Buffer.alloc(4096, 0x42);
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (resources.length) await resources.pop()!();
});

async function probeClone() {
  const root = await fs.mkdtemp(join(tmpdir(), "sbox-reflink-probe-"));
  try {
    await fs.writeFile(join(root, "source"), original);
    try {
      atomicClone(join(root, "source"), join(root, "target"));
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ATOMIC_CLONE_UNAVAILABLE"
      )
        return false;
      throw error;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const supported = await probeClone();

async function fixture(start = true) {
  const root = await fs.mkdtemp(join(tmpdir(), "sbox-host-test-"));
  const path = (id: string) => join(root, "volumes", id, "data.raw");
  const metadata: Record<
    string,
    { id: string; name: string; size_gb: number; attachments: unknown[] }
  > = {};
  for (const id of [sourceId, targetId, otherId]) {
    metadata[id] = { id, name: id, size_gb: 1, attachments: [] };
    await fs.mkdir(join(root, "volumes", id), { recursive: true });
    await fs.writeFile(path(id), id === sourceId ? original : destination);
  }
  const requests: string[] = [];
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      const id = pathname.slice("/volumes/".length);
      if (
        request.headers.get("authorization") !== "Bearer native-fixture-token"
      )
        return new Response("unauthorized", { status: 401 });
      return metadata[id]
        ? Response.json(metadata[id])
        : new Response("missing", { status: 404 });
    },
  });
  let host: Awaited<ReturnType<typeof startHostServer>> | undefined;
  const startHost = async () =>
    (host = await startHostServer({
      dataDir: root,
      token,
      hypemanUrl: native.url.toString(),
      hypemanToken: "native-fixture-token",
      hostname: "127.0.0.1",
      port: 0,
    }));
  if (start) await startHost();
  resources.push(async () => {
    await host?.stop(true);
    await native.stop(true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    metadata,
    requests,
    native,
    start: startHost,
    async stop() {
      await host?.stop(true);
      host = undefined;
    },
    async request(
      body: unknown = { sourceId, targetId },
      headers: Record<string, string> = {},
    ) {
      return fetch(`${host!.url}v1/volumes/clone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    },
    async capability(headers: Record<string, string> = {}) {
      return fetch(`${host!.url}v1/capabilities`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
    },
  };
}

async function errorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("host atomic volume clone", () => {
  test("uses reflinks with independent writes, or fails explicitly without a copy fallback", async () => {
    const f = await fixture(false);
    const target = join(f.root, "atomic.raw");
    if (!supported) {
      expect(() => atomicClone(f.path(sourceId), target)).toThrow("filesystem");
      expect(await fs.readFile(f.path(sourceId))).toEqual(original);
      expect((await fs.stat(target).catch(() => ({ size: 0 }))).size).not.toBe(
        original.length,
      );
      return;
    }
    atomicClone(f.path(sourceId), target);
    expect(await fs.readFile(target)).toEqual(original);
    const source = await fs.open(f.path(sourceId), "r+");
    await source.write(Buffer.from("source-new"), 0, 10, 0);
    await source.close();
    expect(await fs.readFile(target)).toEqual(original);
    const copy = await fs.open(target, "r+");
    await copy.write(Buffer.from("fork-new"), 0, 8, 100);
    await copy.close();
    expect((await fs.readFile(f.path(sourceId))).subarray(100, 108)).toEqual(
      original.subarray(100, 108),
    );
    expect(() => atomicClone(f.path(sourceId), target)).toThrow();
    expect((await fs.readFile(target)).subarray(100, 108).toString()).toBe(
      "fork-new",
    );
  });

  test("rejects weak authentication and cross-origin requests before querying Hypeman or mutating volumes", async () => {
    const f = await fixture();
    for (const headers of [
      { authorization: "" },
      { authorization: "Bearer wrong-token" },
    ]) {
      const result = await f.request(undefined, headers);
      expect(result.status).toBe(401);
      expect(await errorCode(result)).toBe("UNAUTHORIZED");
    }
    expect(
      (await f.request(undefined, { origin: "https://untrusted.example" }))
        .status,
    ).toBe(403);
    expect(
      (await f.request(undefined, { host: "untrusted.example" })).status,
    ).toBe(403);
    expect(
      (await f.request(undefined, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(f.requests).toHaveLength(0);
    expect(await fs.readFile(f.path(targetId))).toEqual(destination);
    await expect(
      startHostServer({
        dataDir: f.root,
        token: "weak",
        hypemanUrl: f.native.url.toString(),
        port: 0,
      }),
    ).rejects.toThrow("token");
  });

  test("rejects traversal, unmanaged IDs, same-volume clone, attached targets, and metadata mismatches", async () => {
    const f = await fixture();
    for (const body of [
      { sourceId: "../data", targetId },
      { sourceId: "native-volume", targetId },
      { sourceId, targetId: sourceId },
      { sourceId, targetId: `drv-${"z".repeat(24)}` },
    ]) {
      const response = await f.request(body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("INVALID_ARGUMENT");
    }
    expect(f.requests).toHaveLength(0);
    f.metadata[targetId]!.attachments = [{ instance_id: "active" }];
    expect(await errorCode(await f.request())).toBe("VOLUME_IN_USE");
    f.metadata[targetId]!.attachments = [];
    f.metadata[targetId]!.size_gb = 2;
    expect(await errorCode(await f.request())).toBe("VOLUME_SIZE_MISMATCH");
    f.metadata[targetId]!.size_gb = 1;
    f.metadata[sourceId]!.name = "unmanaged-native-name";
    expect(await errorCode(await f.request())).toBe(
      "VOLUME_OWNERSHIP_MISMATCH",
    );
    f.metadata[sourceId]!.name = sourceId;
    f.metadata[sourceId]!.id = otherId;
    expect(await errorCode(await f.request())).toBe(
      "VOLUME_OWNERSHIP_MISMATCH",
    );
    expect(await fs.readFile(f.path(targetId))).toEqual(destination);
    expect(await fs.readdir(join(f.root, "volumes", targetId))).toEqual([
      "data.raw",
    ]);
  });

  test("rejects symlinked raw images and volume directories without touching their targets", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.raw");
    await fs.writeFile(outside, original);
    await fs.unlink(f.path(sourceId));
    await fs.symlink(outside, f.path(sourceId));
    expect(await errorCode(await f.request())).toBe("INVALID_VOLUME_FILE");
    await fs.unlink(f.path(sourceId));
    await fs.writeFile(f.path(sourceId), original);
    await fs.unlink(f.path(targetId));
    await fs.symlink(outside, f.path(targetId));
    expect(await errorCode(await f.request())).toBe("INVALID_VOLUME_FILE");
    await fs.unlink(f.path(targetId));
    await fs.writeFile(f.path(targetId), destination);
    const directory = join(f.root, "volumes", sourceId),
      moved = join(f.root, "moved");
    await fs.rename(directory, moved);
    await fs.symlink(moved, directory);
    expect(await errorCode(await f.request())).toBe("INVALID_VOLUME_FILE");
    expect(await fs.readFile(outside)).toEqual(original);
    expect(await fs.readFile(f.path(targetId))).toEqual(destination);
  });

  test.skipIf(!supported)(
    "clones successfully, serializes duplicate requests, and never recaptures after source changes",
    async () => {
      const f = await fixture();
      const responses = await Promise.all([f.request(), f.request()]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(await fs.readFile(f.path(targetId))).toEqual(original);
      await fs.writeFile(f.path(sourceId), Buffer.alloc(original.length, 0x43));
      expect((await f.request()).status).toBe(200);
      expect(await fs.readFile(f.path(targetId))).toEqual(original);
      expect(
        await errorCode(await f.request({ sourceId: otherId, targetId })),
      ).toBe("CLONE_CONFLICT");
      expect((await fs.stat(f.path(targetId))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(f.root, ".sbox-storage"))).mode & 0o777).toBe(
        0o700,
      );
    },
  );

  for (const phase of [
    "pending",
    "cloned",
    "installed-before-journal",
  ] as const) {
    test.skipIf(!supported)(
      `recovers ${phase} without recapturing a changed source`,
      async () => {
        const f = await fixture(false);
        const journal = join(f.root, ".sbox-storage");
        await fs.mkdir(journal, { mode: 0o700 });
        const temporary = join(f.root, "volumes", targetId, ".sbox-cloned.raw");
        atomicClone(f.path(sourceId), temporary);
        if (phase === "installed-before-journal")
          await fs.rename(temporary, f.path(targetId));
        await fs.writeFile(
          join(journal, `${targetId}.json`),
          JSON.stringify({
            sourceId,
            targetId,
            size: original.length,
            status: phase === "pending" ? "pending" : "cloned",
          }),
          { mode: 0o600 },
        );
        await fs.writeFile(
          f.path(sourceId),
          Buffer.alloc(original.length, 0x43),
        );
        await f.start();
        expect((await f.request()).status).toBe(200);
        expect(await fs.readFile(f.path(targetId))).toEqual(original);
        expect(
          JSON.parse(
            await fs.readFile(join(journal, `${targetId}.json`), "utf8"),
          ).status,
        ).toBe("installed");
        expect(await fs.readdir(join(f.root, "volumes", targetId))).toEqual([
          "data.raw",
        ]);
      },
    );
  }
});

test("host rejects malformed bodies, unequal raw sizes, and invalid journal states", async () => {
  const f = await fixture();
  expect((await f.request(null)).status).toBe(400);
  await fs.writeFile(f.path(targetId), Buffer.alloc(17));
  expect(await errorCode(await f.request())).toBe("INVALID_VOLUME_FILE");
  expect((await fs.stat(f.path(targetId))).size).toBe(17);
  await fs.writeFile(f.path(targetId), destination);
  await fs.writeFile(
    join(f.root, ".sbox-storage", `${targetId}.json`),
    JSON.stringify({
      sourceId,
      targetId,
      size: original.length,
      status: "unknown",
    }),
  );
  expect(await errorCode(await f.request())).toBe("INVALID_CLONE_JOURNAL");
  expect(await fs.readFile(f.path(targetId))).toEqual(destination);
});

for (const phase of ["pending", "cloned"] as const) {
  test(`host rejects symlinked temporary files in ${phase} recovery`, async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.raw");
    await fs.writeFile(outside, original);
    const temporary = join(f.root, "volumes", targetId, ".sbox-cloned.raw");
    await fs.symlink(outside, temporary);
    await fs.writeFile(
      join(f.root, ".sbox-storage", `${targetId}.json`),
      JSON.stringify({
        sourceId,
        targetId,
        size: original.length,
        status: phase,
      }),
    );
    expect(await errorCode(await f.request())).toBe("INVALID_VOLUME_FILE");
    expect(await fs.readFile(outside)).toEqual(original);
    expect(await fs.readFile(f.path(targetId))).toEqual(destination);
    expect((await fs.lstat(f.path(targetId))).isSymbolicLink()).toBe(false);
  });
}

test.skipIf(!supported)(
  "separate companions serialize conflicting source clones through the shared host lock",
  async () => {
    const f = await fixture();
    const second = await startHostServer({
      dataDir: f.root,
      token,
      hypemanUrl: f.native.url.toString(),
      hypemanToken: "native-fixture-token",
      hostname: "127.0.0.1",
      port: 0,
    });
    resources.push(async () => {
      await second.stop(true);
    });
    const results = await Promise.all([
      f.request(),
      fetch(`${second.url}v1/volumes/clone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceId: otherId, targetId }),
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const intent = JSON.parse(
      await fs.readFile(
        join(f.root, ".sbox-storage", `${targetId}.json`),
        "utf8",
      ),
    );
    expect(await fs.readFile(f.path(targetId))).toEqual(
      await fs.readFile(f.path(intent.sourceId)),
    );
  },
);
