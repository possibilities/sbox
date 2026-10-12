import type {
  Backend,
  BackendCreate,
  BackendExec,
  Execution,
  Instance,
} from "../backend.ts";
import { SboxError } from "../errors.ts";
import type { Capabilities, CredentialPolicies } from "../types.ts";
import {
  CREDENTIAL_MANIFEST,
  credentialEnvironment,
  decodeCredentialManifest,
  encodeCredentialManifest,
  nativeCredentialPolicies,
  nativeCredentialSecrets,
  normalizeCredentials,
} from "./credentials.ts";
import {
  bridgeCommand,
  BridgeDecoder,
  bridgeInput,
  bridgeStart,
  GUEST_TERMINAL,
} from "./bridge.ts";
import {
  HypemanClient,
  HypemanError,
  type HypemanClientOptions,
} from "./client.ts";

export { HypemanClient, HypemanError } from "./client.ts";
export type { CredentialPolicies, CredentialPolicy } from "../types.ts";

interface NativeInstance {
  id: string;
  image?: string;
  state: string;
  network?: { enabled?: boolean; ip?: string };
  env?: Record<string, string>;
  vcpus?: number;
  size?: string;
  overlay_size?: string;
  volumes?: Array<{
    volume_id: string;
    mount_path: string;
    readonly?: boolean;
    overlay?: boolean;
    overlay_size?: string;
  }>;
}

interface NativeCapabilities {
  default_runtime: { name: string; available: boolean };
  runtimes: Array<{ name: string; available: boolean; features: string[] }>;
  server: { version: string; api_version: string };
  host: { os: string; arch: string };
  features: string[];
}

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEADLINE_PATH = "/run/sbox/deadline";

function parseBytes(value?: string): number | undefined {
  const match = value?.match(/^([\d.]+)\s*([KMGT]?I?B)?$/i);
  if (!match) return undefined;
  const unit = (match[2] ?? "B").toUpperCase();
  const exponent = "BKMGT".indexOf(unit[0]!);
  return Number(match[1]) * 1024 ** Math.max(0, exponent);
}

function commandEnvironment(
  user: string,
  env: Record<string, string>,
): Record<string, string> {
  const home = ["root", "0"].includes(user) ? "/root" : `/home/${user}`;
  return {
    PATH: `${home}/.bun/bin:${home}/.local/bin:${home}/.npm-global/bin:${home}/.cargo/bin:${PATH}`,
    HOME: home,
    USER: user,
    ...env,
  };
}

/** Hypeman shuts the VM down when its entrypoint exits; disks remain intact. */
export const GUEST_WATCHDOG = String.raw`
const fs = require('node:fs');
// Creation first uses disposable values. Real secrets are installed on the
// provider only after this confirms its guest-side credential redaction works.
if (process.env.SBOX_CREDENTIAL_MANIFEST) {
  const manifest = JSON.parse(Buffer.from(process.env.SBOX_CREDENTIAL_MANIFEST,'base64url').toString());
  if (manifest.version !== 1) throw new Error('Invalid credential manifest');
  for (const alias of Object.keys(manifest.policies)) {
    if (process.env[alias] !== 'mock-' + alias) throw new Error('Provider did not redact guest credentials');
  }
  if (!process.env.HTTPS_PROXY || !fs.existsSync('/usr/local/share/ca-certificates/hypeman-egress-proxy.crt')) throw new Error('Provider did not configure credential proxy trust');
}
// Hypeman v0.3.0 leaves loopback down when no external NIC is attached. Local
// servers must still work in deny-all guests. This only raises the existing lo
// interface; it does not attach a NIC, add routes, or grant external access.
if (!require('node:os').networkInterfaces().lo?.some(a => a.address === '127.0.0.1')) {
  const { dlopen, ptr } = require('bun:ffi');
  const symbols = { socket: { args: ['i32','i32','i32'], returns: 'i32' }, ioctl: { args: ['i32','u64','ptr'], returns: 'i32' }, close: { args: ['i32'], returns: 'i32' } };
  let libc;
  for (const name of ['libc.so.6','libc.musl-aarch64.so.1','libc.musl-x86_64.so.1']) {
    try { libc = dlopen(name, symbols); break; } catch {}
  }
  if (!libc) throw new Error('Cannot load libc to initialize guest loopback networking');
  const fd = libc.symbols.socket(2,2,0);
  if (fd < 0) throw new Error('Cannot open guest network control socket');
  try {
    const request = Buffer.alloc(40); request.write('lo');
    if (libc.symbols.ioctl(fd,0x8913,ptr(request)) !== 0) throw new Error('Cannot inspect guest loopback flags');
    request.writeUInt16LE(request.readUInt16LE(16) | 1,16);
    if (libc.symbols.ioctl(fd,0x8914,ptr(request)) !== 0) throw new Error('Cannot enable guest loopback');
  } finally { libc.symbols.close(fd); libc.close(); }
}
const path = '/run/sbox/deadline';
const deadline = Number(process.argv.at(-1));
if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) process.exit(0);
fs.mkdirSync('/run/sbox', { recursive: true, mode: 0o700 });
fs.writeFileSync(path, String(deadline), { mode: 0o600 });
setInterval(() => {
  try {
    const until = Number(fs.readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(until) || Date.now() >= until) process.exit(0);
  } catch { process.exit(0); }
}, 250);
`;

const BOOTSTRAP = String.raw`
set -eu
command -v bun >/dev/null || { echo 'The sandbox image must contain Bun in PATH' >&2; exit 127; }
command -v stty >/dev/null || { echo 'The sandbox image must contain stty (coreutils)' >&2; exit 127; }
command -v runuser >/dev/null || { echo 'The sandbox image must contain runuser (util-linux)' >&2; exit 127; }
if ! id sandbox >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash sandbox
fi
mkdir -p /vercel/sandbox /home/sandbox
chown sandbox:$(id -gn sandbox) /vercel/sandbox /home/sandbox
chmod 700 /home/sandbox
if command -v sudo >/dev/null 2>&1; then
  mkdir -p /etc/sudoers.d
  printf '%s\n' 'sandbox ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sbox-sandbox
  chmod 440 /etc/sudoers.d/sbox-sandbox
fi
`;

class OutputQueue
  implements AsyncIterable<{ stream: "stdout" | "stderr"; data: Uint8Array }>
{
  private values: Array<{ stream: "stdout" | "stderr"; data: Uint8Array }> = [];
  private notify?: () => void;
  private done = false;
  private error?: Error;
  private buffered = 0;

  push(stream: "stdout" | "stderr", data: Uint8Array) {
    if (this.done) return;
    this.buffered += data.length;
    if (this.buffered > 32 * 1024 * 1024)
      throw new Error(
        "Command output consumer exceeded the 32 MiB buffering limit",
      );
    this.values.push({ stream, data });
    this.notify?.();
    this.notify = undefined;
  }

  finish(error?: Error) {
    this.done = true;
    this.error = error;
    this.notify?.();
    this.notify = undefined;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.values.length) {
        const value = this.values.shift()!;
        this.buffered -= value.data.length;
        yield value;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}

const encode = encodeURIComponent;
const instance = (value: NativeInstance): Instance => ({
  id: value.id,
  state: value.state,
  ip: value.network?.ip,
});

export class HypemanBackend implements Backend {
  readonly client: HypemanClient;
  private readonly credentialPolicies = new Map<string, CredentialPolicies>();
  private credentialSupport?: Promise<boolean>;
  private atomicCloneSupport?: Promise<boolean>;
  private rootfsSupport?: Promise<boolean>;
  private storageCapabilities?: Promise<{
    protocol?: number;
    rootfsTransplant?: boolean;
    atomicVolumeClone?: boolean;
    consistency?: string;
  }>;

  constructor(options: HypemanClientOptions | HypemanClient) {
    this.client =
      options instanceof HypemanClient ? options : new HypemanClient(options);
  }

  async capabilities(): Promise<Capabilities> {
    let native: NativeCapabilities;
    try {
      native = await this.client.request<NativeCapabilities>(
        "GET",
        "/capabilities",
      );
    } catch (error) {
      if (!(error instanceof HypemanError) || error.status !== 404) throw error;
      // The latest tagged release (v0.3.0) predates /capabilities. Probe known
      // read-only resources; never infer host architecture from the client host.
      const probe = async (path: string) => {
        try {
          await this.client.request("GET", path);
          return true;
        } catch (error) {
          if (
            error instanceof HypemanError &&
            [404, 501].includes(error.status)
          )
            return false;
          throw error;
        }
      };
      const [snapshots, volumes] = await Promise.all([
        probe("/snapshots"),
        probe("/volumes"),
      ]);
      return {
        backend: "hypeman",
        snapshots,
        volumes,
        terminal: true,
        networkPolicies: ["allow-all", "deny-all"],
        liveNetworkPolicy: false,
        credentialBrokering: await this.supportsCredentials(),
        credentialBrokeringDetails: {
          protocol: "https-header-injection",
          requiresNetwork: "allow-all",
          hostEnforcement: "unverified",
          destinationFirewall: false,
          rotation: true,
        },
        volumeOverlays: true,
        atomicVolumeClone: await this.supportsAtomicClone(),
        deadlineEnforcement: "guest-watchdog",
        runtimeCapabilitiesVerified: false,
        snapshotRuntimeSupport:
          "Endpoint exists; runtime support is checked when capturing a snapshot",
        requiresGuest: ["bun", "stty", "runuser", "useradd"],
        snapshotRestoreOverrides: (await this.supportsRootfs())
          ? ["env", "resources", "mounts", "networkPolicy", "credentials"]
          : ["env"],
        rootfsTransplant: await this.supportsRootfs(),
      };
    }
    const runtime = native.runtimes.find(
      (runtime) => runtime.name === native.default_runtime.name,
    );
    return {
      backend: "hypeman",
      snapshots: Boolean(
        runtime?.available && runtime.features.includes("snapshots"),
      ),
      volumes: native.features.includes("volumes"),
      terminal: native.features.includes("exec"),
      networkPolicies: ["allow-all", "deny-all"],
      liveNetworkPolicy: false,
      credentialBrokering: await this.supportsCredentials(),
      credentialBrokeringDetails: {
        protocol: "https-header-injection",
        requiresNetwork: "allow-all",
        hostEnforcement: native.host.os === "linux" ? "ipv4-tcp-only" : "none",
        destinationFirewall: false,
        rotation: true,
      },
      volumeOverlays: true,
      atomicVolumeClone: await this.supportsAtomicClone(),
      runtime: native.default_runtime,
      host: native.host,
      server: native.server,
      runtimeCapabilitiesVerified: true,
      deadlineEnforcement: "guest-watchdog",
      requiresGuest: ["bun", "stty", "runuser", "useradd"],
      snapshotRestoreOverrides: (await this.supportsRootfs())
        ? ["env", "resources", "mounts", "networkPolicy", "credentials"]
        : ["env"],
      rootfsTransplant: await this.supportsRootfs(),
    };
  }

  private validateCreate(options: BackendCreate) {
    if (
      options.networkPolicy !== "allow-all" &&
      options.networkPolicy !== "deny-all"
    ) {
      throw new SboxError(
        "unsupported_network_policy",
        "Hypeman supports allow-all and deny-all here. General destination policies require the mediated network backend; credential injection alone is not a destination firewall.",
        422,
      );
    }
    if (
      !Number.isSafeInteger(options.deadline) ||
      options.deadline <= Date.now()
    ) {
      throw new SboxError(
        "invalid_deadline",
        "Sandbox deadline must be in the future",
      );
    }
    const policies = normalizeCredentials(options.credentials);
    nativeCredentialSecrets(policies, options.credentialSecrets, true);
    if (Object.keys(policies).length && options.networkPolicy !== "allow-all")
      throw new SboxError(
        "credential_network_required",
        "Native credential brokering requires an attached network (allow-all)",
        422,
      );
    for (const mount of options.mounts) {
      if (
        mount.overlay &&
        (!mount.readOnly ||
          !Number.isSafeInteger(mount.overlaySizeBytes) ||
          mount.overlaySizeBytes! < 1024 * 1024)
      )
        throw new SboxError(
          "invalid_volume_overlay",
          "Volume overlays require a read-only base and overlaySizeBytes of at least 1 MiB",
          422,
        );
      if (!mount.overlay && mount.overlaySizeBytes !== undefined)
        throw new SboxError(
          "invalid_volume_overlay",
          "overlaySizeBytes requires overlay=true",
          422,
        );
    }
  }

  async create(options: BackendCreate): Promise<Instance> {
    return await this.createInstance(options);
  }

  private async createInstance(
    options: BackendCreate,
    initializeMountOwnership = true,
  ): Promise<Instance> {
    this.validateCreate(options);
    const policies = normalizeCredentials(options.credentials);
    const brokered = Object.keys(policies).length > 0;
    if (brokered && !(await this.supportsCredentials()))
      throw new SboxError(
        "credentials_unavailable",
        "The provider does not advertise the required credential brokering API",
        422,
      );
    const native = await this.client.request<NativeInstance>(
      "POST",
      "/instances",
      {
        name: options.name,
        image: options.image,
        size: `${options.resources.memoryMb}MB`,
        overlay_size: `${options.resources.diskMb}MB`,
        vcpus: options.resources.vcpus,
        // User env is applied only to command children, never to the root
        // watchdog/transport (e.g. LD_PRELOAD or BUN_OPTIONS must not affect it).
        env: {
          PATH,
          HOME: "/root",
          USER: "root",
          ...(brokered
            ? {
                [CREDENTIAL_MANIFEST]: encodeCredentialManifest(policies),
                ...Object.fromEntries(
                  Object.keys(policies).map((alias) => [
                    alias,
                    `sbox-initial-${crypto.randomUUID()}`,
                  ]),
                ),
              }
            : {}),
        },
        ...(brokered
          ? { credentials: nativeCredentialPolicies(policies) }
          : {}),
        network: {
          enabled: options.networkPolicy === "allow-all",
          ...(brokered
            ? { egress: { enabled: true, enforcement: { mode: "all" } } }
            : {}),
        },
        volumes: options.mounts.map((mount) => ({
          volume_id: mount.volumeId,
          mount_path: mount.path,
          readonly: mount.readOnly,
          ...(mount.overlay
            ? { overlay: true, overlay_size: `${mount.overlaySizeBytes}B` }
            : {}),
        })),
        entrypoint: ["bun", "-e", GUEST_WATCHDOG, "--"],
        cmd: [String(options.deadline)],
        restart_policy: { policy: "never" },
        skip_kernel_headers: true,
        tags: { "sbox-managed": "true" },
      },
    );
    this.credentialPolicies.set(native.id, policies);
    try {
      await this.waitRunning(native.id);
      await this.bootstrap(
        native.id,
        initializeMountOwnership ? options.mounts : [],
      );
      if (brokered) {
        await this.verifyCredentialTransport(native.id, policies);
        await this.rotateCredentials(native.id, options.credentialSecrets!);
      }
      return await this.get(native.id);
    } catch (error) {
      try {
        await this.delete(native.id);
      } catch {
        /* Preserve original boot error. */
      }
      throw error;
    }
  }

  async get(id: string): Promise<Instance> {
    return instance(
      await this.client.request<NativeInstance>(
        "GET",
        `/instances/${encode(id)}`,
      ),
    );
  }

  async start(id: string, deadline = Date.now() + 300_000): Promise<Instance> {
    await this.client.request("POST", `/instances/${encode(id)}/start`, {
      entrypoint: ["bun", "-e", GUEST_WATCHDOG, "--"],
      cmd: [String(deadline)],
    });
    await this.waitRunning(id);
    const policies = await this.getCredentialPolicies(id);
    if (Object.keys(policies).length) {
      try {
        await this.verifyCredentialTransport(id, policies);
      } catch (error) {
        try {
          await this.stop(id);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Credential proxy verification failed and the resumed instance could not be stopped",
          );
        }
        throw error;
      }
    }
    return await this.get(id);
  }

  async stop(id: string): Promise<void> {
    const current = await this.get(id);
    // Shutdown means the guest halted; Hypeman still owns a VMM and attached
    // disks until the instance is explicitly stopped.
    if (current.state === "Stopped") return;
    await this.client.request("POST", `/instances/${encode(id)}/stop`);
  }

  async delete(id: string): Promise<void> {
    await this.deleteResource(`/instances/${encode(id)}`);
    this.credentialPolicies.delete(id);
  }

  async setDeadline(id: string, deadline: number): Promise<void> {
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
      throw new SboxError(
        "invalid_deadline",
        "Sandbox deadline must be in the future",
      );
    // Atomic replacement prevents the watchdog from observing a truncated file.
    const command = [
      "bun",
      "-e",
      'const fs=require("node:fs");const p=process.argv.at(-2);const tmp=p+"."+crypto.randomUUID();fs.writeFileSync(tmp,process.argv.at(-1),{mode:0o600});fs.renameSync(tmp,p)',
      "--",
      DEADLINE_PATH,
      String(deadline),
    ];
    await this.checkedNative(id, command);
  }

  private async supportsCredentials(): Promise<boolean> {
    if (!this.credentialSupport) {
      this.credentialSupport = (async () => {
        try {
          const spec = await this.client.request<{
            components?: {
              schemas?: Record<
                string,
                { properties?: Record<string, unknown> }
              >;
            };
          }>("GET", "/spec.json");
          const schemas = spec?.components?.schemas;
          return Boolean(
            schemas?.CreateInstanceRequest?.properties?.credentials &&
              schemas?.CreateInstanceRequestNetworkEgress?.properties
                ?.enabled &&
              schemas?.CreateInstanceRequestCredential?.properties?.source &&
              schemas?.UpdateInstanceRequest?.properties?.env,
          );
        } catch (error) {
          if (
            error instanceof HypemanError &&
            [404, 501].includes(error.status)
          )
            return false;
          throw error;
        }
      })();
      void this.credentialSupport.catch(() => {
        this.credentialSupport = undefined;
      });
    }
    return await this.credentialSupport;
  }

  private getStorageCapabilities() {
    this.storageCapabilities ??= this.client.storageRequest<{
      protocol?: number;
      rootfsTransplant?: boolean;
      atomicVolumeClone?: boolean;
      consistency?: string;
    }>("GET", "/v1/capabilities");
    void this.storageCapabilities.catch(() => {
      this.storageCapabilities = undefined;
    });
    return this.storageCapabilities;
  }
  private async supportsRootfs(): Promise<boolean> {
    if (!this.client.storageConfigured) return false;
    this.rootfsSupport ??= this.getStorageCapabilities().then(
      (value) => value.protocol === 1 && value.rootfsTransplant === true,
    );
    void this.rootfsSupport.catch(() => {
      this.rootfsSupport = undefined;
    });
    return this.rootfsSupport;
  }
  private async supportsAtomicClone(): Promise<boolean> {
    if (!this.client.storageConfigured) return false;
    if (!this.atomicCloneSupport) {
      this.atomicCloneSupport = this.getStorageCapabilities().then(
        (capabilities) =>
          capabilities?.protocol === 1 &&
          capabilities.atomicVolumeClone === true &&
          capabilities.consistency === "crash-consistent",
      );
      void this.atomicCloneSupport.catch(() => {
        this.atomicCloneSupport = undefined;
      });
    }
    return await this.atomicCloneSupport;
  }

  private async getCredentialPolicies(id: string): Promise<CredentialPolicies> {
    let policies = this.credentialPolicies.get(id);
    if (!policies) {
      const native = await this.client.request<NativeInstance>(
        "GET",
        `/instances/${encode(id)}`,
      );
      policies = decodeCredentialManifest(native.env?.[CREDENTIAL_MANIFEST]);
      this.credentialPolicies.set(id, policies);
    }
    return policies;
  }

  private async verifyCredentialTransport(
    id: string,
    policies: CredentialPolicies,
  ): Promise<void> {
    await this.checkedNative(id, [
      "bun",
      "-e",
      String.raw`
for(const alias of JSON.parse(process.argv.at(-1))) {
  if(process.env[alias]!=="mock-"+alias) throw new Error("Provider did not redact guest credentials");
}
if(!process.env.HTTPS_PROXY || !require("node:fs").existsSync("/usr/local/share/ca-certificates/hypeman-egress-proxy.crt")) throw new Error("Provider credential proxy is not configured");
const url = new URL(process.env.HTTPS_PROXY);
// CONNECT is acknowledged before TLS/upstream traffic. This tests the actual
// proxy handler without sending credentials or contacting an external service.
await new Promise((resolve,reject) => {
  const socket = require('node:net').connect(Number(url.port || 80),url.hostname);
  let complete=false, response='';
  const finish=(error)=>{if(complete)return;complete=true;socket.destroy();error?reject(error):resolve()};
  socket.setTimeout(5000);
  socket.on('timeout',()=>finish(new Error('Provider credential proxy did not respond within five seconds')));
  socket.on('error',()=>finish(new Error('Provider credential proxy is unreachable')));
  socket.on('close',()=>{if(!complete)finish(new Error('Provider credential proxy closed before CONNECT acknowledgement'))});
  socket.on('connect',()=>socket.write('CONNECT sbox-credential-check.invalid:443 HTTP/1.1\r\nHost: sbox-credential-check.invalid:443\r\n\r\n'));
  socket.on('data',data=>{response+=data.toString();if(response.includes('\r\n\r\n'))finish(/^HTTP\/1\.[01] 200 /.test(response)?undefined:new Error('Provider credential proxy rejected CONNECT'));else if(response.length>8192)finish(new Error('Invalid provider credential proxy response'))});
});`,
      "--",
      JSON.stringify(Object.keys(policies)),
    ]);
  }

  /** Keys are logical source.env names, not guest aliases. Only values rotate. */
  async rotateCredentials(
    id: string,
    secrets: Record<string, string>,
  ): Promise<void> {
    const policies = await this.getCredentialPolicies(id);
    const env = nativeCredentialSecrets(policies, secrets);
    if (!Object.keys(env).length)
      throw new SboxError(
        "invalid_credentials",
        "Credential rotation requires at least one existing source value",
        422,
      );
    await this.client.request("PATCH", `/instances/${encode(id)}`, { env });
  }

  async exec(id: string, options: BackendExec): Promise<Execution> {
    const policies = await this.getCredentialPolicies(id);
    const brokered = Object.keys(policies).length > 0;
    options = { ...options, env: credentialEnvironment(policies, options.env) };
    const output = new OutputQueue();
    if (options.tty) return await this.terminal(id, options, output, brokered);
    const decoder = new BridgeDecoder();
    let result: { exitCode: number } | undefined;
    let bridgeError: Error | undefined;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    let transportResolve!: () => void;
    let transportReject!: (error: Error) => void;
    const transportReady = new Promise<void>((resolve, reject) => {
      transportResolve = resolve;
      transportReject = reject;
    });
    void transportReady.catch(() => {});
    const setup = bridgeStart({
      command: [options.cmd, ...options.args],
      cwd: options.cwd,
      env: commandEnvironment(options.user, options.env),
      user: options.user,
      timeoutMs: options.timeoutMs,
      brokered,
    });
    // The upstream non-TTY guest path buffers output. A raw PTY transports the
    // framed bridge, while the actual child still receives regular stdio pipes.
    const native = await this.client.exec(
      id,
      {
        command: [
          "/bin/sh",
          "-c",
          'stty raw -echo && exec "$@"',
          "sbox-bridge",
          ...bridgeCommand(),
        ],
        tty: true,
        cwd: "/",
        wait_for_agent: 30,
      },
      (bytes) => {
        for (const frame of decoder.push(bytes)) {
          if (frame.type === "ready") transportResolve();
          else if (frame.type === "started") readyResolve();
          else if (frame.type === "stdout" || frame.type === "stderr")
            output.push(frame.type, Buffer.from(frame.data, "base64"));
          else if (frame.type === "exit") result = { exitCode: frame.exitCode };
          else if (frame.type === "error")
            bridgeError = new Error(frame.message);
        }
      },
    );
    const exited = native.completion
      .then((code) => {
        decoder.finish();
        if (bridgeError) throw bridgeError;
        if (!result)
          throw new SboxError(
            "guest_bridge_failed",
            `Guest command bridge exited without a result (status ${code}). The image must include Bun, stty, and a sandbox user.`,
            502,
          );
        readyResolve();
        output.finish();
        return result;
      })
      .catch((error) => {
        transportReject(error);
        readyReject(error);
        output.finish(error);
        throw error;
      });
    void exited.catch(() => {});
    const startupTimeout = setTimeout(() => {
      const error = new SboxError(
        "guest_bridge_timeout",
        "Guest command bridge did not become ready within 30 seconds",
        504,
      );
      transportReject(error);
      readyReject(error);
      native.close();
    }, 30_000);
    try {
      await transportReady;
      native.write(setup);
      await ready;
    } finally {
      clearTimeout(startupTimeout);
    }
    if (!options.stdin && !result) native.write(bridgeInput("eof"));
    return {
      output,
      exited,
      async write(data) {
        native.write(bridgeInput("stdin", data));
      },
      async closeStdin() {
        native.write(bridgeInput("eof"));
      },
      async kill(signal = "SIGTERM") {
        if (!/^SIG(?:TERM|KILL|INT|HUP|QUIT|USR1|USR2|STOP|CONT)$/.test(signal))
          throw new SboxError("invalid_signal", "Unsupported process signal");
        native.write(bridgeInput("signal", signal));
      },
      async resize() {
        throw new SboxError(
          "not_a_terminal",
          "Only PTY commands can be resized",
        );
      },
    };
  }

  private async terminal(
    id: string,
    options: BackendExec,
    output: OutputQueue,
    brokered = false,
  ): Promise<Execution> {
    const pidFile = `/run/sbox/pty-${crypto.randomUUID()}.pid`;
    const env = {
      TERM: "xterm-256color",
      ...commandEnvironment(options.user, options.env),
    };
    const native = await this.client.exec(
      id,
      {
        command: ["bun", "-e", GUEST_TERMINAL, "--", pidFile],
        tty: true,
        cwd: options.cwd,
        // The provider audits command argv. The native env carries an inert JSON
        // configuration, never caller LD_PRELOAD/BUN_OPTIONS for this root helper.
        env: {
          PATH,
          HOME: "/root",
          SBOX_TERMINAL_OPTIONS: JSON.stringify({
            command: [options.cmd, ...options.args],
            cwd: options.cwd,
            user: options.user,
            env,
            brokered,
          }),
        },
        timeout: options.timeoutMs
          ? Math.max(1, Math.ceil(options.timeoutMs / 1000))
          : undefined,
        rows: options.rows ?? 24,
        cols: options.cols ?? 80,
        wait_for_agent: 30,
      },
      (bytes) => output.push("stdout", bytes),
    );
    const exited = native.completion
      .then((exitCode) => {
        output.finish();
        return { exitCode };
      })
      .catch((error) => {
        output.finish(error);
        throw error;
      });
    void exited.catch(() => {});
    const client = this;
    return {
      output,
      exited,
      async write(data) {
        native.write(data);
      },
      async closeStdin() {
        native.write(new Uint8Array([4]));
      },
      async resize(cols, rows) {
        if (
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols < 1 ||
          rows < 1 ||
          cols > 1000 ||
          rows > 1000
        )
          throw new SboxError(
            "invalid_terminal_size",
            "Terminal dimensions must be integers between 1 and 1000",
          );
        native.resize(rows, cols);
      },
      async kill(signal = "SIGTERM") {
        if (!/^SIG(?:TERM|KILL|INT|HUP|QUIT|USR1|USR2|STOP|CONT)$/.test(signal))
          throw new SboxError("invalid_signal", "Unsupported process signal");
        await client.checkedNative(id, [
          "bun",
          "-e",
          'const fs=require("node:fs");const pid=Number(fs.readFileSync(process.argv.at(-2),"utf8"));try{process.kill(-pid,process.argv.at(-1))}catch(e){if(e.code!=="ESRCH")throw e}',
          "--",
          pidFile,
          signal,
        ]);
      },
    };
  }

  async snapshot(
    id: string,
    name: string,
  ): Promise<{ id: string; sizeBytes?: number }> {
    if (!(await this.capabilities()).snapshots)
      throw new SboxError(
        "snapshots_unavailable",
        "The configured Hypeman runtime does not support snapshots on this host",
        422,
      );
    const native = await this.client.request<NativeInstance>(
      "GET",
      `/instances/${encode(id)}`,
    );
    if (
      native.volumes?.some((volume) => volume.overlay) &&
      (await this.supportsRootfs())
    )
      throw new SboxError(
        "OVERLAY_TRANSPLANT_UNAVAILABLE",
        "Root filesystem snapshots cannot preserve per-instance drive overlays",
        422,
      );
    await this.stop(id);
    if (native.volumes?.length && (await this.supportsRootfs())) {
      const info = await this.client.storageRequest<{
        resolvedImage: string;
        platform: string;
        sizeBytes: number;
      }>("GET", `/v1/rootfs/instances/${encode(id)}`);
      const carrierName = `${name}-capture`;
      let carrier: Instance | undefined;
      try {
        try {
          carrier = await this.get(carrierName);
        } catch (error) {
          if (!(error instanceof SboxError && error.status === 404))
            throw error;
        }
        const existing = await this.findSnapshot(id, name);
        if (existing) return existing;
        carrier ??= await this.createInstance(
          {
            name: carrierName,
            image: info.resolvedImage,
            resources: {
              vcpus: 1,
              memoryMb: 512,
              diskMb: info.sizeBytes / 1024 ** 2,
            },
            env: {},
            networkPolicy: "deny-all",
            mounts: [],
            deadline: Date.now() + 300_000,
          },
          false,
        );
        await this.stop(carrier.id);
        await this.client.storageRequest("POST", "/v1/rootfs/install", {
          source: { instanceId: id },
          targetId: carrier.id,
        });
        const captured = await this.client.request<{
          id: string;
          size_bytes?: number;
        }>("POST", `/instances/${encode(carrier.id)}/snapshots`, {
          kind: "Stopped",
          name,
        });
        await this.delete(carrier.id);
        return { id: captured.id, sizeBytes: captured.size_bytes };
      } catch (error) {
        // Resolve the deterministic carrier name even when POST succeeded but its reply was lost.
        if (!carrier) {
          try {
            carrier = await this.get(carrierName);
          } catch {}
        }
        if (carrier) await this.delete(carrier.id).catch(() => {});
        throw error;
      }
    }
    if (native.volumes?.some((volume) => !volume.readonly))
      throw new SboxError(
        "snapshot_writable_volume",
        "Snapshots of mounted writable drives require the host storage companion",
        422,
      );
    const snapshot = await this.client.request<{
      id: string;
      size_bytes?: number;
    }>("POST", `/instances/${encode(id)}/snapshots`, { kind: "Stopped", name });
    return { id: snapshot.id, sizeBytes: snapshot.size_bytes };
  }

  async restore(snapshotId: string, options: BackendCreate): Promise<Instance> {
    this.validateCreate(options);
    if (await this.supportsRootfs()) {
      if (options.mounts.some((mount) => mount.overlay))
        throw new SboxError(
          "OVERLAY_TRANSPLANT_UNAVAILABLE",
          "Root filesystem restore cannot preserve per-instance drive overlays",
          422,
        );
      const info = await this.client.storageRequest<{
        resolvedImage: string;
        platform: string;
        sizeBytes: number;
      }>("GET", `/v1/rootfs/snapshots/${encode(snapshotId)}`);
      if (options.resources.diskMb * 1024 ** 2 !== info.sizeBytes)
        throw new SboxError(
          "snapshot_disk_override",
          "Snapshot disk capacity must remain unchanged",
          422,
        );
      let target: Instance | undefined;
      try {
        target = await this.createInstance(
          { ...options, image: info.resolvedImage },
          false,
        );
        await this.stop(target.id);
        await this.client.storageRequest("POST", "/v1/rootfs/install", {
          source: { snapshotId },
          targetId: target.id,
        });
        const started = await this.start(target.id, options.deadline);
        await this.bootstrap(target.id, options.mounts);
        if (options.credentials && Object.keys(options.credentials).length)
          await this.rotateCredentials(target.id, options.credentialSecrets!);
        return started;
      } catch (error) {
        if (target) await this.delete(target.id).catch(() => {});
        throw error;
      }
    }

    const native = await this.client.request<NativeInstance>(
      "POST",
      `/snapshots/${encode(snapshotId)}/fork`,
      { name: options.name, target_state: "Stopped" },
    );
    try {
      const configured = await this.client.request<NativeInstance>(
        "GET",
        `/instances/${encode(native.id)}`,
      );
      const policies = decodeCredentialManifest(
        configured.env?.[CREDENTIAL_MANIFEST],
      );
      if (
        encodeCredentialManifest(policies) !==
        encodeCredentialManifest(normalizeCredentials(options.credentials))
      )
        throw new SboxError(
          "snapshot_credential_override",
          "Snapshot forks retain their credential policies; only secret values can change",
          422,
        );
      this.credentialPolicies.set(native.id, policies);
      if (configured.image && configured.image !== options.image)
        throw new SboxError(
          "snapshot_image_override",
          "Hypeman snapshot forks retain the source image; changing it during restore is not supported",
          422,
        );
      if (
        configured.vcpus !== undefined &&
        configured.vcpus !== options.resources.vcpus
      )
        throw new SboxError(
          "snapshot_resource_override",
          "Hypeman snapshot forks retain the source resources; changing them during restore is not supported",
          422,
        );
      if (
        (configured.network?.enabled !== false) !==
        (options.networkPolicy === "allow-all")
      )
        throw new SboxError(
          "snapshot_network_override",
          "Hypeman snapshot forks retain the source network policy; changing it during restore is not supported",
          422,
        );
      const mounts = configured.volumes ?? [];
      if (
        mounts.length !== options.mounts.length ||
        options.mounts.some(
          (mount) =>
            !mounts.some(
              (existing) =>
                existing.volume_id === mount.volumeId &&
                existing.mount_path === mount.path &&
                Boolean(existing.readonly) === mount.readOnly &&
                Boolean(existing.overlay) === Boolean(mount.overlay) &&
                (!mount.overlay ||
                  parseBytes(existing.overlay_size) === mount.overlaySizeBytes),
            ),
        )
      )
        throw new SboxError(
          "snapshot_mount_override",
          "Hypeman snapshot forks retain their original mounts; changing mounts during restore is not supported",
          422,
        );
      const started = await this.start(native.id, options.deadline);
      if (Object.keys(policies).length) {
        await this.rotateCredentials(native.id, options.credentialSecrets!);
      }
      return started;
    } catch (error) {
      try {
        await this.delete(native.id);
      } catch {
        /* Preserve original restore error. */
      }
      throw error;
    }
  }

  async findSnapshot(
    sourceId: string,
    name: string,
  ): Promise<{ id: string; sizeBytes?: number } | null> {
    const mediated = await this.supportsRootfs();
    const query = new URLSearchParams(
      mediated ? { name } : { source_instance_id: sourceId, name },
    );
    const snapshots = await this.client.request<
      Array<{
        id: string;
        name?: string;
        source_instance_id: string;
        source_instance_name?: string;
        size_bytes?: number;
      }>
    >("GET", `/snapshots?${query}`);
    const exact = snapshots.filter(
      (snapshot) =>
        (snapshot.source_instance_id === sourceId ||
          (mediated && snapshot.source_instance_name === `${name}-capture`)) &&
        snapshot.name === name,
    );
    if (exact.length > 1)
      throw new SboxError(
        "ambiguous_snapshot",
        "More than one native snapshot matched the recorded source and name",
        409,
      );
    const found = exact[0];
    if (found && mediated && found.source_instance_name === `${name}-capture`) {
      // Recovery is complete only after releasing the temporary carrier too.
      await this.delete(found.source_instance_id);
    }
    return found ? { id: found.id, sizeBytes: found.size_bytes } : null;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.deleteResource(`/snapshots/${encode(id)}`);
  }

  async createVolume(name: string, sizeBytes: number): Promise<{ id: string }> {
    return await this.client.request("POST", "/volumes", {
      id: name,
      name,
      size_gb: Math.max(1, Math.ceil(sizeBytes / 1024 ** 3)),
      tags: { "sbox-managed": "true" },
    });
  }

  async deleteVolume(id: string): Promise<void> {
    await this.deleteResource(`/volumes/${encode(id)}`);
  }

  /** Atomic raw-volume clone when configured; otherwise preserves file metadata by copying a stable source. */
  async cloneVolume(
    sourceId: string,
    name: string,
    sizeBytes: number,
  ): Promise<{ id: string }> {
    const source = await this.client.request<{
      id: string;
      attachments?: Array<{ readonly: boolean }>;
    }>("GET", `/volumes/${encode(sourceId)}`);
    const atomic = await this.supportsAtomicClone();
    if (this.client.storageConfigured && !atomic)
      throw new SboxError(
        "atomic_clone_unavailable",
        "Configured storage companion does not support the required atomic clone protocol",
        422,
      );
    if (
      !atomic &&
      source.attachments?.some((attachment) => !attachment.readonly)
    )
      throw new SboxError(
        "volume_writer_attached",
        "Copy snapshots require an unattached or read-only source; atomic snapshots of attached writers require a host storage companion",
        409,
      );
    const target = await this.createVolume(name, sizeBytes);
    const helperName = `${name}-copy`;
    let helper: Instance | undefined;
    let failure: unknown;
    try {
      if (atomic) {
        const result = await this.client.storageRequest<{ id: string }>(
          "POST",
          "/v1/volumes/clone",
          { sourceId: source.id, targetId: target.id },
        );
        if (result?.id !== target.id)
          throw new SboxError(
            "invalid_clone_result",
            "Storage companion returned an unexpected destination identity",
            502,
          );
      }
      helper = await this.createInstance(
        {
          name: helperName,
          image: "oven/bun:1-debian",
          resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
          env: {},
          networkPolicy: "deny-all",
          deadline: Date.now() + 30 * 60_000,
          mounts: [
            ...(atomic
              ? []
              : [
                  {
                    volumeId: source.id,
                    path: "/sbox-copy-source",
                    readOnly: true,
                  },
                ]),
            {
              volumeId: target.id,
              path: "/sbox-copy-destination",
              readOnly: false,
            },
          ],
        },
        false,
      );
      if (!atomic) {
        const copy = await this.exec(helper.id, {
          cmd: "cp",
          args: [
            "-a",
            "--preserve=all",
            "--sparse=always",
            "--",
            "/sbox-copy-source/.",
            "/sbox-copy-destination/",
          ],
          cwd: "/",
          env: {},
          user: "root",
          timeoutMs: 30 * 60_000,
        });
        let stderr = "";
        for await (const chunk of copy.output)
          if (chunk.stream === "stderr" && stderr.length < 4096)
            stderr += Buffer.from(chunk.data).toString();
        if ((await copy.exited).exitCode !== 0)
          throw new SboxError(
            "volume_copy_failed",
            `Volume copy failed: ${stderr.slice(0, 4096)}`,
            502,
          );
      }
      // Booting the destination read-write replays any captured ext4 journal.
      // Do not chown the cloned mount: its root directory is source metadata.
      await this.checkedNative(helper.id, [
        "sync",
        "-f",
        "/sbox-copy-destination",
      ]);
      return target;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // The caller journals the target before mutation and owns its cleanup.
      // A stable helper name also reconciles an uncertain native create reply.
      try {
        await this.delete(helper?.id ?? helperName);
      } catch (cleanup) {
        if (failure)
          throw new AggregateError(
            [failure, cleanup],
            "Volume copy failed and its helper still needs cleanup",
          );
        throw cleanup;
      }
    }
  }

  private async deleteResource(path: string): Promise<void> {
    try {
      await this.client.request("DELETE", path);
    } catch (error) {
      if (!(error instanceof HypemanError) || error.status !== 404) throw error;
    }
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    return await this.client.readFile(id, path);
  }
  async writeFile(
    id: string,
    path: string,
    data: Uint8Array,
    mode?: number,
  ): Promise<void> {
    await this.client.writeFile(id, path, data, mode);
  }

  private async bootstrap(
    id: string,
    mounts: BackendCreate["mounts"] = [],
  ): Promise<void> {
    await this.checkedNative(id, ["/bin/sh", "-c", BOOTSTRAP]);
    for (const mount of mounts) {
      if (!mount.readOnly || mount.overlay)
        await this.checkedNative(id, [
          "chown",
          "sandbox:sandbox",
          "--",
          mount.path,
        ]);
    }
  }

  private async checkedNative(id: string, command: string[]): Promise<void> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const session = await this.client.exec(
      id,
      { command, cwd: "/", wait_for_agent: 30, timeout: 60 },
      (data) => {
        bytes += data.length;
        if (bytes < 64 * 1024) chunks.push(data);
      },
    );
    const exitCode = await session.completion;
    if (exitCode !== 0)
      throw new SboxError(
        "guest_setup_failed",
        `Guest setup exited with ${exitCode}: ${Buffer.concat(chunks).toString("utf8").trim()}`,
        502,
      );
  }

  private async waitRunning(id: string): Promise<void> {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const current = await this.get(id);
      if (current.state === "Running") return;
      if (["Stopped", "Shutdown", "Unknown"].includes(current.state))
        throw new SboxError(
          "guest_boot_failed",
          `Hypeman instance entered ${current.state} during boot. Verify the image contains Bun and its runtime prerequisites.`,
          502,
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new SboxError(
      "guest_boot_timeout",
      "Hypeman instance did not become ready within two minutes",
      504,
    );
  }
}
