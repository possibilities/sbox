import { Sandbox } from "../src/index.ts";

// SBOX_URL and SBOX_TOKEN select either your local or remote control plane.
const sandbox = await Sandbox.create({
  image: process.env.SBOX_IMAGE,
  timeout: 60_000,
});
try {
  await sandbox.writeFiles([
    {
      path: "hello.ts",
      content: "console.log('Hello from an isolated Hypeman sandbox!')\n",
    },
  ]);
  const result = await sandbox.runCommand({
    cmd: "bun",
    args: ["hello.ts"],
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = result.exitCode ?? 1;
} finally {
  await sandbox.delete();
}
