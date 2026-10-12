import { dlopen, ptr } from "bun:ffi";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
} from "node:fs";
import { SboxError } from "../errors.ts";

/** A real filesystem reflink, never a copy fallback. The destination must not exist. */
export function atomicClone(source: string, destination: string): void {
  if (!lstatSync(source).isFile())
    throw new SboxError(
      "INVALID_VOLUME_FILE",
      "Volume image must be a regular file",
      422,
    );
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    });
    try {
      const from = Buffer.from(source + "\0"),
        to = Buffer.from(destination + "\0");
      if (library.symbols.clonefile(ptr(from), ptr(to), 0) !== 0)
        throw new SboxError(
          "ATOMIC_CLONE_UNAVAILABLE",
          "Volume filesystem refused an atomic clone; APFS on the same filesystem is required",
          422,
        );
    } finally {
      library.close();
    }
    const file = openSync(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return;
  }
  if (process.platform === "linux") {
    const sourceFd = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let targetFd: number | undefined;
    try {
      if (!fstatSync(sourceFd).isFile())
        throw new SboxError(
          "INVALID_VOLUME_FILE",
          "Volume image must be a regular file",
          422,
        );
      targetFd = openSync(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const library = dlopen("libc.so.6", {
        ioctl: { args: ["i32", "u64", "i32"], returns: "i32" },
      });
      try {
        if (library.symbols.ioctl(targetFd, 0x40049409, sourceFd) !== 0)
          throw new SboxError(
            "ATOMIC_CLONE_UNAVAILABLE",
            "Volume filesystem refused FICLONE; a reflink-enabled filesystem such as XFS or Btrfs is required",
            422,
          );
      } finally {
        library.close();
      }
      fsyncSync(targetFd);
    } finally {
      closeSync(sourceFd);
      if (targetFd !== undefined) closeSync(targetFd);
    }
    return;
  }
  throw new SboxError(
    "ATOMIC_CLONE_UNAVAILABLE",
    "Atomic volume cloning is supported on macOS and Linux",
    422,
  );
}
