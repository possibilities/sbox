import { afterEach, expect, test } from "bun:test";
import { SandboxService, Store } from "../src/server/index.ts";
import type {
  MediatedNetwork,
  NetworkConfiguration,
  NetworkSession,
} from "../src/network/index.ts";
import { credentialEnvironment } from "../src/hypeman/credentials.ts";
import { TestBackend } from "./test-backend.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const backend = await new TestBackend().initialize();
  const store = new Store(":memory:");
  const connections: Array<{
    id: string;
    configuration: NetworkConfiguration;
    closed: boolean;
    session: NetworkSession;
  }> = [];
  const network = {
    async attach(
      _backend: unknown,
      id: string,
      configuration: NetworkConfiguration,
    ) {
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const connection = {
        id,
        configuration: structuredClone(configuration),
        closed: false,
        session: undefined as unknown as NetworkSession,
      };
      const environment = (env: Record<string, string>) => ({
        ...credentialEnvironment(
          connection.configuration.credentials ?? {},
          env,
        ),
        HTTPS_PROXY: "http://127.0.0.1:18081",
      });
      connection.session = {
        environment,
        get env() {
          return environment({});
        },
        closed,
        update(next) {
          connection.configuration = structuredClone(next);
        },
        async close() {
          connection.closed = true;
          finish();
        },
      };
      connections.push(connection);
      return connection.session;
    },
  } as unknown as MediatedNetwork;
  const service = new SandboxService(backend, store, { network });
  cleanup.push(async () => {
    await service.close();
    store.close();
    await backend.dispose();
  });
  return { backend, store, service, connections, network };
}
const credentials = {
  API_KEY: {
    source: { env: "HOST_TOKEN" },
    inject: [
      {
        hosts: ["api.example.com"],
        as: { header: "Authorization", format: "Bearer ${value}" },
      },
    ],
  },
};

test("mediated lifecycle stores secrets privately and never provisions a native network or provider secrets", async () => {
  const f = await fixture();
  const { sandbox } = await f.service.create({
    credentials,
    credentialSecrets: { HOST_TOKEN: "host-only-secret" },
    networkPolicy: {
      allow: {
        "api.example.com": [
          { transform: [{ headers: { "x-api-key": "header-secret" } }] },
        ],
      },
    },
  });
  const native = f.backend.instances.get(sandbox.instanceId!)!;
  expect(native.options.networkPolicy).toBe("deny-all");
  expect(native.options.credentials).toBeUndefined();
  expect(native.options.credentialSecrets).toBeUndefined();
  expect(JSON.stringify(native.options)).not.toContain("host-only-secret");
  expect(JSON.stringify(sandbox)).not.toContain("host-only-secret");
  expect(JSON.stringify(sandbox)).not.toContain("header-secret");
  expect(f.connections[0]!.configuration.credentialSecrets).toEqual({
    HOST_TOKEN: "host-only-secret",
  });
  expect(JSON.stringify(f.connections[0]!.configuration.policy)).toContain(
    "header-secret",
  );
  const command = await f.service.run(sandbox.sandboxId, {
    cmd: "bun",
    args: [
      "-e",
      "console.log(JSON.stringify({key:process.env.API_KEY,source:process.env.HOST_TOKEN,proxy:process.env.HTTPS_PROXY}))",
    ],
    env: {
      API_KEY: "attempted-alias",
      HOST_TOKEN: "attempted-source",
      HTTPS_PROXY: "http://bad-proxy.invalid",
    },
  });
  await f.service.wait(command.commandId);
  const output = JSON.parse(
    f.service
      .poll(command.commandId)
      .logs.map((log) => Buffer.from(log.data, "base64").toString())
      .join(""),
  );
  expect(output.source).toBeUndefined();
  expect(output.key).not.toBe("attempted-alias");
  expect(output.key).not.toBe("host-only-secret");
  expect(output.proxy).toBe("http://127.0.0.1:18081");
  await f.service.update(sandbox.sandboxId, {
    credentialSecrets: { HOST_TOKEN: "rotated-secret" },
    networkPolicy: "deny-all",
  });
  expect(f.connections[0]!.configuration.credentialSecrets).toEqual({
    HOST_TOKEN: "rotated-secret",
  });
  expect(f.connections[0]!.configuration.policy).toBe("deny-all");
  expect(JSON.stringify(f.service.get(sandbox.sandboxId))).not.toContain(
    "rotated-secret",
  );
  await expect(
    f.service.update(sandbox.sandboxId, { env: { HOST_TOKEN: "not-allowed" } }),
  ).rejects.toMatchObject({ code: "CREDENTIAL_ENV_CONFLICT" });
});

test("mediated stop, resume, snapshot fork and transport reconnect preserve private policies", async () => {
  const f = await fixture();
  const { sandbox } = await f.service.create({
    credentials,
    credentialSecrets: { HOST_TOKEN: "initial-secret" },
    networkPolicy: {
      allow: {
        "api.example.com": [
          { transform: [{ headers: { Authorization: "private-transform" } }] },
        ],
      },
    },
    keepLastSnapshots: null,
  });
  const stopped = await f.service.stop(sandbox.sandboxId);
  expect(f.connections[0]!.closed).toBe(true);
  expect(JSON.stringify(stopped.snapshot)).not.toContain("private-transform");
  await f.service.update(sandbox.sandboxId, {
    credentialSecrets: { HOST_TOKEN: "resume-secret" },
  });
  const resumed = await f.service.resume(sandbox.sandboxId);
  expect(resumed.sessionId).not.toBe(sandbox.sessionId);
  expect(f.connections[1]!.configuration.credentialSecrets).toEqual({
    HOST_TOKEN: "resume-secret",
  });
  expect(JSON.stringify(f.connections[1]!.configuration.policy)).toContain(
    "private-transform",
  );
  await f.connections[1]!.session.close();
  await Promise.resolve();
  const command = await f.service.run(sandbox.sandboxId, { cmd: "true" });
  await f.service.wait(command.commandId);
  expect(f.connections).toHaveLength(3);
  const fork = await f.service.create({
    source: { type: "snapshot", snapshotId: stopped.snapshot!.snapshotId },
  });
  expect(fork.sandbox.sandboxId).not.toBe(sandbox.sandboxId);
  expect(f.connections[3]!.configuration.credentialSecrets).toEqual({
    HOST_TOKEN: "initial-secret",
  });
  expect(JSON.stringify(f.connections[3]!.configuration.policy)).toContain(
    "private-transform",
  );
  await f.service.delete(fork.sandbox.sandboxId);
  expect(f.connections[3]!.closed).toBe(true);
});
