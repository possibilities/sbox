/** SBOX_LIVE_TEST=1 HYPEMAN_BASE_URL=... HYPEMAN_API_KEY=... bun test tests/network-tunnel.live.test.ts */
import { expect, test } from "bun:test";
import { HypemanBackend } from "../src/hypeman/index.ts";
import { prepareTunnel } from "../src/network/transparent.ts";

test.skipIf(
  process.env.SBOX_LIVE_TEST !== "1" &&
    process.env.SBOX_NETWORK_LIVE_TEST !== "1",
)(
  "real kernel: pinned installation, direct TCP/UDP, and parent-EOF tunnel cleanup without a native NIC",
  async () => {
    if (!process.env.HYPEMAN_BASE_URL)
      throw new Error(
        "Live network tests require an explicit HYPEMAN_BASE_URL",
      );
    const backend = new HypemanBackend({
      baseUrl: process.env.HYPEMAN_BASE_URL,
      apiKey: process.env.HYPEMAN_API_KEY,
    });
    let id: string | undefined;
    try {
      const instance = await backend.create({
        name: `tunnel-test-${crypto.randomUUID().slice(0, 8)}`,
        image: process.env.SBOX_LIVE_IMAGE ?? "oven/bun:1-debian",
        resources: { vcpus: 1, memoryMb: 512, diskMb: 2048 },
        env: {},
        networkPolicy: "deny-all",
        mounts: [],
        deadline: Date.now() + 180_000,
      });
      id = instance.id;
      await prepareTunnel(backend, id);
      const execution = await backend.exec(id, {
        cmd: "bun",
        args: [
          "-e",
          await Bun.file(
            new URL("fixtures/tunnel-probe.js", import.meta.url),
          ).text(),
        ],
        cwd: "/",
        env: {},
        user: "root",
        timeoutMs: 45_000,
      });
      let stdout = "",
        stderr = "";
      for await (const part of execution.output) {
        if (part.stream === "stdout")
          stdout += Buffer.from(part.data).toString();
        else stderr += Buffer.from(part.data).toString();
      }
      expect((await execution.exited).exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.readiness.ready).toBe(true);
      expect(result.interfaces).toEqual(["lo", "sboxtun0"]);
      expect(result.dns).toContain("nameserver 127.0.0.53");
      expect(result.tcp).toBe("TUN TCP PASSED");
      expect(result.tcpDestination).toBe("203.0.113.77:8080");
      expect(result.udp).toBe("TUN UDP PASSED");
      expect(result.udpDestination).toBe("203.0.113.88:5300");
      expect(result.remainingInterfaces).toEqual(["lo"]);
      expect(result.dnsRestored).toBe(true);
    } finally {
      if (id) await backend.delete(id);
    }
  },
  180_000,
);
