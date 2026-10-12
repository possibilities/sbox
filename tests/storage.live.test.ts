/**
 * Opt-in integration with a caller-owned Hypeman daemon and host companion.
 * SBOX_LIVE_TEST=1 HYPEMAN_BASE_URL=... HYPEMAN_API_KEY=...
 * SBOX_STORAGE_URL=... SBOX_STORAGE_TOKEN=... bun test tests/storage.live.test.ts
 * Creates and deletes only this test's VMs, snapshots, and drives.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox, Drive } from "../src/index.ts";
import { HypemanBackend, HypemanClient } from "../src/hypeman/index.ts";
import { startServer, Store } from "../src/server/index.ts";
import { Client } from "../src/sdk/client.ts";
import type {
  SandboxRecord,
  SnapshotRecord,
  DriveRecord,
} from "../src/types.ts";

describe.skipIf(
  process.env.SBOX_LIVE_TEST !== "1" ||
    !process.env.SBOX_STORAGE_URL ||
    !process.env.SBOX_STORAGE_TOKEN,
)(
  "real Hypeman: mounted filesystem snapshots and mutable VM configuration",
  () => {
    test("stop releases the writer, restore changes resources and mounts, and rollback preserves root files", async () => {
      if (!process.env.HYPEMAN_BASE_URL)
        throw Error("Storage live tests require HYPEMAN_BASE_URL");
      const nativeConnection = {
        baseUrl: process.env.HYPEMAN_BASE_URL,
        apiKey: process.env.HYPEMAN_API_KEY,
      };
      const backend = new HypemanBackend({
        ...nativeConnection,
        storageUrl: process.env.SBOX_STORAGE_URL,
        storageToken: process.env.SBOX_STORAGE_TOKEN,
      });
      const native = new HypemanClient(nativeConnection);
      const store = new Store(":memory:");
      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      let client: Client | undefined;
      let failure: unknown;
      try {
        expect((await backend.capabilities()).rootfsTransplant).toBe(true);
        const token = crypto.randomUUID();
        server = await startServer({
          backend,
          store,
          hostname: "127.0.0.1",
          port: 0,
          token,
        });
        const connection = { baseUrl: server.url.toString(), token };
        client = new Client(connection);
        const prefix = `storage-live-${crypto.randomUUID().slice(0, 8)}`;
        const base = {
          ...connection,
          image: process.env.SBOX_LIVE_IMAGE ?? "oven/bun:1-debian",
          resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
          networkPolicy: "deny-all" as const,
          timeout: 600_000,
          keepLastSnapshots: { count: 10 },
        };
        const drive = await Drive.getOrCreate({
          ...connection,
          name: `${prefix}-cache`,
          sizeBytes: 1024 ** 3,
        });
        const replacement = await Drive.getOrCreate({
          ...connection,
          name: `${prefix}-replacement`,
          sizeBytes: 1024 ** 3,
        });
        const box = await Sandbox.create({
          ...base,
          name: `${prefix}-source`,
          mounts: { "/mnt/cache": drive },
        });
        const firstNative = box.toJSON().instanceId!;
        await box.writeFiles([
          { path: "root-state", content: "filesystem-alpha" },
          { path: "/mnt/cache/cache-state", content: "drive-alpha" },
        ]);
        const runningInfo = await fetch(
          new URL(
            `v1/rootfs/instances/${firstNative}`,
            `${process.env.SBOX_STORAGE_URL!.replace(/\/$/, "")}/`,
          ),
          {
            headers: {
              authorization: `Bearer ${process.env.SBOX_STORAGE_TOKEN}`,
            },
            redirect: "error",
          },
        );
        expect(runningInfo.status).toBe(409);
        await runningInfo.body?.cancel();
        expect((await box.runCommand("true")).exitCode).toBe(0);
        const stopped = await box.stop();
        expect(stopped.instanceId).toBeUndefined();
        expect(stopped.snapshot?.snapshotId).toBeDefined();
        await expect(backend.get(firstNative)).rejects.toMatchObject({
          status: 404,
        });

        const writer = await Sandbox.create({
          ...base,
          name: `${prefix}-writer`,
          mounts: { "/mnt/cache": drive },
        });
        expect(
          (
            await writer.readFileToBuffer({ path: "/mnt/cache/cache-state" })
          )?.toString(),
        ).toBe("drive-alpha");
        await writer.writeFiles([
          { path: "/mnt/cache/cache-state", content: "drive-beta" },
        ]);
        await box.update({
          resources: { vcpus: 2, memoryMb: 768 },
          mounts: { "/mnt/cache": replacement },
        });
        await box.resume();
        const changed = await native.request<{
          vcpus: number;
          size: string;
          volumes: Array<{ volume_id: string }>;
        }>("GET", `/instances/${box.toJSON().instanceId}`);
        expect(changed.vcpus).toBe(2);
        expect(changed.size).toMatch(
          /^(?:768(?:\.0)? ?M(?:i?B)?|805306368 ?B?)$/i,
        );
        expect(changed.volumes[0]?.volume_id).toBe(
          replacement.toJSON().nativeId,
        );
        expect(
          (await box.readFileToBuffer({ path: "root-state" }))?.toString(),
        ).toBe("filesystem-alpha");
        expect(
          await box.readFileToBuffer({ path: "/mnt/cache/cache-state" }),
        ).toBeNull();
        expect(
          (
            await writer.readFileToBuffer({ path: "/mnt/cache/cache-state" })
          )?.toString(),
        ).toBe("drive-beta");

        await box.writeFiles([
          { path: "root-state", content: "filesystem-beta" },
        ]);
        const second = await box.stop();
        expect(second.snapshot?.snapshotId).not.toBe(
          stopped.snapshot!.snapshotId,
        );
        await box.update({
          currentSnapshotId: stopped.snapshot!.snapshotId,
          mounts: {},
        });
        await box.resume();
        expect(
          (await box.readFileToBuffer({ path: "root-state" }))?.toString(),
        ).toBe("filesystem-alpha");
        expect(box.toJSON().mounts).toEqual({});
        const fork = await Sandbox.create({
          ...base,
          name: `${prefix}-fork`,
          source: {
            type: "snapshot",
            snapshotId: stopped.snapshot!.snapshotId,
          },
        });
        expect(fork.toJSON().mounts).toEqual({});
        expect(
          (await fork.readFileToBuffer({ path: "root-state" }))?.toString(),
        ).toBe("filesystem-alpha");
        await fork.writeFiles([
          { path: "root-state", content: "independent-fork" },
        ]);
        expect(
          (await box.readFileToBuffer({ path: "root-state" }))?.toString(),
        ).toBe("filesystem-alpha");
      } catch (error) {
        failure = error;
      } finally {
        const failures: unknown[] = [];
        // The isolated store also includes ownership records from failed creations.
        if (server) {
          for (const box of store.all<SandboxRecord>("sandbox")) {
            try {
              await client!.rpc("sandbox.delete", { id: box.sandboxId });
            } catch (error) {
              failures.push(error);
            }
          }
          for (const snapshot of store.all<SnapshotRecord>("snapshot")) {
            try {
              await client!.rpc("snapshot.delete", { id: snapshot.snapshotId });
            } catch (error) {
              failures.push(error);
            }
          }
          for (const drive of store.all<DriveRecord>("drive")) {
            try {
              await client!.rpc("drive.delete", { id: drive.driveId });
            } catch (error) {
              failures.push(error);
            }
          }
          await server.stop(true);
        }
        store.close();
        if (failures.length)
          failure = new AggregateError(
            [...(failure ? [failure] : []), ...failures],
            "Storage integration or resource cleanup failed",
          );
      }
      if (failure) throw failure;
    }, 600_000);
  },
);
