import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../src/backend.ts";
import {
  TUN2SOCKS_ASSETS,
  tunnelBinary,
  verifyTunnelArchive,
} from "../src/network/assets.ts";
import {
  prepareTunnel,
  TRANSPARENT_GUEST_PROGRAM,
} from "../src/network/transparent.ts";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "sbox-tunnel-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("release archives require both exact publisher size and SHA-256", () => {
  expect(() => verifyTunnelArchive("arm64", new Uint8Array(4))).toThrow(
    "integrity check",
  );
  expect(() =>
    verifyTunnelArchive(
      "x64",
      new Uint8Array(TUN2SOCKS_ASSETS.x64.archiveBytes),
    ),
  ).toThrow("integrity check");
  expect(Object.isFrozen(TUN2SOCKS_ASSETS)).toBe(true);
  expect(Object.isFrozen(TUN2SOCKS_ASSETS.arm64)).toBe(true);
  expect(TUN2SOCKS_ASSETS.arm64.binarySha256).not.toBe(
    TUN2SOCKS_ASSETS.x64.binarySha256,
  );
});

test("invalid release bytes never enter the executable cache", async () => {
  const cacheDir = await temporary();
  const fetcher = (async (url: string | URL | Request) => {
    expect(String(url)).toBe(
      "https://github.com/xjasonlyu/tun2socks/releases/download/v2.7.0/tun2socks-linux-arm64.zip",
    );
    return new Response("not a trusted archive");
  }) as unknown as typeof fetch;
  await expect(
    tunnelBinary("arm64", { cacheDir, fetch: fetcher }),
  ).rejects.toThrow("integrity check");
  expect(
    await Bun.file(join(cacheDir, TUN2SOCKS_ASSETS.arm64.entry)).exists(),
  ).toBe(false);
  expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
});

test("streamed downloads are size bounded and cancelled before extraction", async () => {
  let cancelled = false;
  const fetcher = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new Uint8Array(TUN2SOCKS_ASSETS.arm64.archiveBytes + 1),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    )) as unknown as typeof fetch;
  await expect(
    tunnelBinary("arm64", { cacheDir: await temporary(), fetch: fetcher }),
  ).rejects.toThrow("pinned size");
  expect(cancelled).toBe(true);
});

test("cached executable bytes are rehashed and never trusted by filename or size", async () => {
  const cacheDir = await temporary();
  const path = join(cacheDir, TUN2SOCKS_ASSETS.arm64.entry);
  await writeFile(path, new Uint8Array(TUN2SOCKS_ASSETS.arm64.binaryBytes));
  let downloads = 0;
  const fetcher = (async () => {
    downloads++;
    return new Response("bad replacement");
  }) as unknown as typeof fetch;
  await expect(
    tunnelBinary("arm64", { cacheDir, fetch: fetcher }),
  ).rejects.toThrow("integrity check");
  expect(downloads).toBe(1);
  expect((await stat(path)).size).toBe(TUN2SOCKS_ASSETS.arm64.binaryBytes);
});

test("cache symlinks are refused without modifying or reading their targets", async () => {
  const cacheDir = await temporary();
  const target = join(cacheDir, "target");
  await writeFile(target, "untouched");
  await symlink(target, join(cacheDir, TUN2SOCKS_ASSETS.arm64.entry));
  let downloads = 0;
  const fetcher = (async () => {
    downloads++;
    return new Response("bad");
  }) as unknown as typeof fetch;
  await expect(
    tunnelBinary("arm64", { cacheDir, fetch: fetcher }),
  ).rejects.toThrow();
  expect(downloads).toBe(0);
  expect(await readFile(target, "utf8")).toBe("untouched");
});

test("concurrent startup shares a download and a failed request can be retried", async () => {
  const cacheDir = await temporary();
  let downloads = 0;
  const fetcher = (async () => {
    downloads++;
    await Bun.sleep(10);
    return new Response("bad");
  }) as unknown as typeof fetch;
  const first = tunnelBinary("x64", { cacheDir, fetch: fetcher });
  const second = tunnelBinary("x64", { cacheDir, fetch: fetcher });
  expect(first).toBe(second);
  await Promise.allSettled([first, second]);
  expect(downloads).toBe(1);
  await expect(
    tunnelBinary("x64", { cacheDir, fetch: fetcher }),
  ).rejects.toThrow("integrity check");
  expect(downloads).toBe(2);
});

test("unsupported guest platforms fail before any network asset download", async () => {
  let calls = 0;
  const backend = {
    async exec(_id: string, options: { user: string }) {
      calls++;
      expect(options.user).toBe("root");
      return {
        output: (async function* () {
          yield { stream: "stdout", data: Buffer.from("linux:riscv64\n") };
        })(),
        exited: Promise.resolve({ exitCode: 0 }),
      };
    },
  } as unknown as Backend;
  await expect(
    prepareTunnel(backend, "owned-instance", {
      fetch: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("Linux arm64 or x64");
  expect(calls).toBe(1);
});

test("guest supervisor is a standalone JavaScript program suitable for compiled CLI upload", () => {
  const output = new Bun.Transpiler({
    loader: "js",
    target: "bun",
  }).transformSync(TRANSPARENT_GUEST_PROGRAM);
  expect(output).toContain("/run/sbox-network/tun2socks");
  expect(output).toContain("127.0.0.1:18082");
  expect(output).toContain("127.0.0.53");
  expect(output).not.toContain("node_modules");
});
