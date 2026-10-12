import { Sandbox } from "../src/index.ts";

const sandbox = await Sandbox.create({
  image: process.env.SBOX_IMAGE,
});
try {
  await sandbox.writeFiles([
    { path: "checkpoint.txt", content: "This file survives the snapshot.\n" },
  ]);
  const snapshot = await sandbox.snapshot();
  const restored = await Sandbox.create({
    source: { type: "snapshot", snapshotId: snapshot.snapshotId },
  });
  try {
    process.stdout.write(
      (await restored.readFileToBuffer({ path: "checkpoint.txt" })) ??
        Buffer.alloc(0),
    );
  } finally {
    await restored.delete({ deleteOrphanSnapshots: true });
  }
} finally {
  // Delete the source before its backing snapshot, which is protected while referenced.
  await sandbox.delete({ deleteOrphanSnapshots: true });
}
