/**
 * Runs only inside a Hypeman guest. The control plane invokes Bun with this
 * source and passes a JSON operation as a separate argv element; no path or
 * file content is interpolated into executable source.
 */
export const FS_GUEST_SCRIPT = String.raw`
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
const argument = process.argv[1];
const request = JSON.parse(argument && argument !== "--" ? argument : await Bun.stdin.text());
const a = request.args ?? {};
const options = a.options ?? {};
const decode = () => Buffer.from(a.data, "base64");
const stats = (s) => Object.fromEntries(["dev","ino","mode","nlink","uid","gid","rdev","size","blksize","blocks","atimeMs","mtimeMs","ctimeMs","birthtimeMs"].map(key => [key, s[key]]));
try {
  let result;
  switch (request.op) {
    case "readFile": result = { data: (await fs.readFile(a.path)).toString("base64") }; break;
    case "writeFile": await fs.writeFile(a.path, decode(), options); result = null; break;
    case "writeFiles":
      for (const file of a.files) {
        await fs.mkdir(dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, Buffer.from(file.data, "base64"), file.mode === undefined ? undefined : { mode: file.mode });
        if (file.mode !== undefined) await fs.chmod(file.path, file.mode);
      }
      result = null; break;
    case "appendFile": await fs.appendFile(a.path, decode(), options); result = null; break;
    case "mkdir": result = (await fs.mkdir(a.path, options)) ?? null; break;
    case "readdir": result = (await fs.readdir(a.path, { withFileTypes: true })).map(d => ({ name: d.name, parentPath: d.parentPath ?? a.path, type: d.isFile() ? "file" : d.isDirectory() ? "directory" : d.isSymbolicLink() ? "symlink" : d.isBlockDevice() ? "block" : d.isCharacterDevice() ? "character" : d.isFIFO() ? "fifo" : d.isSocket() ? "socket" : "unknown" })); break;
    case "stat": result = stats(await fs.stat(a.path)); break;
    case "lstat": result = stats(await fs.lstat(a.path)); break;
    case "unlink": await fs.unlink(a.path); result = null; break;
    case "rm": await fs.rm(a.path, options); result = null; break;
    case "rmdir": await fs.rmdir(a.path); result = null; break;
    case "rename": await fs.rename(a.path, a.dest); result = null; break;
    case "copyFile": await fs.copyFile(a.path, a.dest, a.mode ?? 0); result = null; break;
    case "access": await fs.access(a.path, a.mode ?? constants.F_OK); result = null; break;
    case "chmod":
      if (typeof a.mode === "string" && !/^[0-7]{1,4}$/.test(a.mode)) {
        const child = Bun.spawn(["chmod", "--", a.mode, a.path], { stdout: "ignore", stderr: "pipe" });
        const stderr = await new Response(child.stderr).text();
        if (await child.exited) throw Object.assign(new Error(stderr.trim() || "chmod failed"), { code: "FS_ERROR", path: a.path, syscall: "chmod" });
      } else await fs.chmod(a.path, typeof a.mode === "string" ? parseInt(a.mode, 8) : a.mode);
      result = null; break;
    case "chown": await fs.chown(a.path, a.uid, a.gid); result = null; break;
    case "symlink": await fs.symlink(a.target, a.path, a.type); result = null; break;
    case "readlink": result = await fs.readlink(a.path); break;
    case "realpath": result = await fs.realpath(a.path); break;
    case "truncate": await fs.truncate(a.path, a.len ?? 0); result = null; break;
    case "mkdtemp": result = await fs.mkdtemp(a.prefix); break;
    default: throw Object.assign(new Error("Unknown filesystem operation: " + request.op), { code: "UNSUPPORTED_OPERATION" });
  }
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? "FS_ERROR", message: error.message, path: error.path, syscall: error.syscall } }));
  process.exitCode = 1;
}
`;
