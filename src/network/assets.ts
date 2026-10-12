import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

export const TUN2SOCKS_VERSION = "2.7.0";
/** Publisher release archive digests, additionally pinned after extraction. */
export const TUN2SOCKS_ASSETS = Object.freeze({
  arm64: Object.freeze({
    archive: "tun2socks-linux-arm64.zip",
    entry: "tun2socks-linux-arm64",
    archiveBytes: 4166805,
    archiveSha256:
      "3931476c9cfa8fa236d23aeaf36767df0eb27cc11ecaab699faba57744450f49",
    binaryBytes: 11010174,
    binarySha256:
      "7d1b86a1f8cb681fcdf54d535372ad52c6e3f4731d5a8942b09bee2061f37053",
  }),
  x64: Object.freeze({
    archive: "tun2socks-linux-amd64.zip",
    entry: "tun2socks-linux-amd64",
    archiveBytes: 4595237,
    archiveSha256:
      "a612baa287a3b6de6221f74fd02b442a50888508227ecf51e1288a5ccbb77381",
    binaryBytes: 11780222,
    binarySha256:
      "98d545a663b790b4a4100d0c796e1d43d82c5442efdb6e9c4d82e2e32e99c031",
  }),
});
export type TunnelArchitecture = keyof typeof TUN2SOCKS_ASSETS;
export interface TunnelAssetOptions {
  /** Shared host cache. Every cached binary is rehashed before use. */
  cacheDir?: string;
  fetch?: typeof fetch;
}
const pending = new Map<string, Promise<Uint8Array>>();
const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export function verifyTunnelArchive(
  architecture: TunnelArchitecture,
  archive: Uint8Array,
): Uint8Array {
  const asset = TUN2SOCKS_ASSETS[architecture];
  if (
    !asset ||
    archive.byteLength !== asset.archiveBytes ||
    digest(archive) !== asset.archiveSha256
  ) {
    throw new Error(
      "The tun2socks release archive failed its pinned SHA-256 integrity check",
    );
  }
  const entries = unzipSync(archive, {
    filter: (entry) =>
      entry.name === asset.entry && entry.originalSize === asset.binaryBytes,
  });
  const binary = entries[asset.entry];
  if (
    !binary ||
    binary.byteLength !== asset.binaryBytes ||
    digest(binary) !== asset.binarySha256
  ) {
    throw new Error(
      "The tun2socks executable failed its pinned SHA-256 integrity check",
    );
  }
  return binary;
}

async function load(
  architecture: TunnelArchitecture,
  cacheDir: string,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const asset = TUN2SOCKS_ASSETS[architecture];
  if (!asset)
    throw new Error(
      "Transparent networking requires a Linux arm64 or x64 guest",
    );
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(cacheDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("The tunnel cache must be a real directory");
  await chmod(cacheDir, 0o700);
  const destination = join(cacheDir, asset.entry);
  try {
    const file = await open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.size === asset.binaryBytes) {
        const data = await file.readFile();
        if (digest(data) === asset.binarySha256) return data;
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetcher(
    `https://github.com/xjasonlyu/tun2socks/releases/download/v${TUN2SOCKS_VERSION}/${asset.archive}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `Unable to download tun2socks v${TUN2SOCKS_VERSION}: HTTP ${response.status}`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > asset.archiveBytes)
        throw new Error("The tun2socks archive exceeds its pinned size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const binary = verifyTunnelArchive(architecture, Buffer.concat(chunks, size));
  const temporary = join(cacheDir, `.${asset.entry}.${randomUUID()}.tmp`);
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o700,
    );
    try {
      await file.writeFile(binary);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    const parent = await open(cacheDir, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return binary;
}

/** No host executable or toolchain is needed; only pinned public release bytes are downloaded. */
export function tunnelBinary(
  architecture: TunnelArchitecture,
  options: TunnelAssetOptions = {},
): Promise<Uint8Array> {
  const cacheDir = resolve(
    options.cacheDir ??
      join(homedir(), ".cache", "sbox", "tun2socks", TUN2SOCKS_VERSION),
  );
  const key = `${cacheDir}:${architecture}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = load(architecture, cacheDir, options.fetch ?? fetch).finally(
    () => pending.delete(key),
  );
  pending.set(key, request);
  return request;
}
