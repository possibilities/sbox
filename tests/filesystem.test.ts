import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_GUEST_SCRIPT } from "../src/sdk/fs-guest.ts";
import { FileSystem } from "../src/sdk/filesystem.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "sbox-fs-test-"));
  temporary.push(cwd);
  const operation = async <T>(
    op: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    // Trusted guest filesystem helper test, confined by fixture paths and cwd.
    const child = Bun.spawn([process.execPath, "-e", FS_GUEST_SCRIPT, "--"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ op, args }));
    await child.stdin.end();
    const text = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    await child.exited;
    if (!text) throw new Error(error);
    const response = JSON.parse(text);
    if (response.error)
      throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  return { fs: new FileSystem({ fsOperation: operation }), operation, cwd };
}

describe("guest filesystem helper", () => {
  test("binary files, hidden files, newlines and shell syntax remain literal", async () => {
    const { fs, operation } = await fixture();
    await operation("writeFiles", {
      files: [
        {
          path: "nested/.hidden\n'$(echo danger)",
          data: "AP8KAQI=",
          mode: 0o640,
        },
      ],
    });
    const entries = await fs.readdir("nested", { withFileTypes: true });
    expect(entries.map((e) => e.name)).toEqual([".hidden\n'$(echo danger)"]);
    expect(entries[0]!.isFile()).toBe(true);
    expect(await fs.readFile("nested/.hidden\n'$(echo danger)")).toEqual(
      Buffer.from([0, 255, 10, 1, 2]),
    );
    const stat = await fs.stat("nested/.hidden\n'$(echo danger)");
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o640);
    expect(stat.size).toBe(5);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  test("append is atomic across concurrent writers and supports large stdin payloads", async () => {
    const { fs } = await fixture();
    await fs.writeFile("large", Buffer.alloc(192 * 1024, 65));
    expect((await fs.readFile("large")).length).toBe(192 * 1024);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fs.appendFile("lines", `line-${i}\n`),
      ),
    );
    const lines = (await fs.readFile("lines", "utf8"))
      .trim()
      .split("\n")
      .sort();
    expect(lines).toEqual(
      Array.from({ length: 12 }, (_, i) => `line-${i}`).sort(),
    );
  });

  test("symlinks, stat/lstat, exclusive creation and missing paths have Node semantics", async () => {
    const { fs } = await fixture();
    await fs.writeFile("target", "hello");
    await fs.symlink("target", "link");
    expect(await fs.readlink("link")).toBe("target");
    expect((await fs.stat("link")).isFile()).toBe(true);
    expect((await fs.lstat("link")).isSymbolicLink()).toBe(true);
    await expect(
      fs.writeFile("target", "replace", { flag: "wx" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.exists("missing")).toBe(false);
    await expect(fs.readFile("missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.rename("target", "renamed");
    expect(await fs.exists("target")).toBe(false);
    await fs.copyFile("renamed", "copy");
    await fs.truncate("copy", 2);
    expect(await fs.readFile("copy", "utf8")).toBe("he");
  });

  test("Vercel-compatible options positions retain AbortSignals and string chmod modes", async () => {
    const { fs, operation } = await fixture();
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const facade = new FileSystem({
      fsOperation: async (op, args, options) => {
        expect(options?.signal).toBe(signal);
        calls.push(op);
        return operation(op, args);
      },
    });
    await fs.writeFile("source", "contents");
    await facade.copyFile("source", "copy", { signal });
    await facade.access("copy", { signal });
    await facade.symlink("copy", "link", { signal });
    await facade.chmod("copy", "640", { signal });
    expect((await fs.stat("copy")).mode & 0o777).toBe(0o640);
    await facade.chmod("copy", "u+x", { signal });
    expect((await fs.stat("copy")).mode & 0o777).toBe(0o740);
    expect(calls).toEqual(["copyFile", "access", "symlink", "chmod", "chmod"]);
    expect(await fs.readFile("link", "utf8")).toBe("contents");
    const entries = await fs.readdir(".", { withFileTypes: true });
    const copied = entries.find((entry) => entry.name === "copy")!;
    expect(copied.path).toBe(join(copied.parentPath, "copy"));
  });
});
