import { Sandbox } from "../src/index.ts";
import { harnessCommand, type HarnessName } from "../src/harnesses/index.ts";

const name = (process.argv[2] ?? "codex") as HarnessName;
const prompt = process.argv[3] ?? "Create hello.py and run it";
// Explicit allowlist: only the selected harness's API key is supplied to the guest.
const credential = name === "codex" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY";
const key = process.env[credential];
if (!key) throw new Error(`Set ${credential} to run this example`);
const sandbox = await Sandbox.create({
  image: process.env.SBOX_IMAGE ?? "sbox-agents:local",
  timeout: 15 * 60_000,
});
try {
  // Authentication via CODEX_API_KEY is supported by codex exec; no host auth files are mounted.
  const command = await sandbox.runCommand(
    harnessCommand({
      harness: name,
      prompt,
      env: { [credential]: key },
      args: name === "codex" ? ["--sandbox", "workspace-write"] : [],
    }),
  );
  for await (const log of command.logs())
    (log.stream === "stdout" ? process.stdout : process.stderr).write(log.data);
  process.exitCode = (await command.wait()).exitCode;
} finally {
  await sandbox.delete();
}
