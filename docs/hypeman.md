# Hypeman implementation notes

The adapter uses the official [Hypeman HTTP API](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/openapi.yaml) and its native execution and copy WebSockets. The implementation was checked against upstream commit `ac8e683f7f0877794b288995520b6075772e865e` and tested with a real v0.3.0 VM on Apple's Virtualization framework. It works against a local or remote Hypeman server; no Docker daemon or host shell execution is used for sandbox workloads.

## Host prerequisites

Install and start [Hypeman](https://github.com/kernel/hypeman#quick-start) on the desired host. Linux requires KVM; Apple Silicon uses Apple's Virtualization framework. Configure the Sbox service with `HYPEMAN_BASE_URL` and `HYPEMAN_API_KEY`. The API key is sent in an Authorization header on both HTTP and WebSocket connections. Use HTTPS for a remote server that is not on a trusted network.

**Direct native networking on macOS with the v0.3.0 release:** explicitly configure the VZ NAT subnet. The default Sbox server uses NIC-less mediated networking, so this is needed only when using the native adapter directly. That release otherwise allocates Linux's default `10.100.0.0/16` addresses even though Apple's NAT uses `192.168.64.0/24`, causing unreachable outbound traffic. Current upstream main fixes this. In the Hypeman server YAML:

```yaml
hypervisor:
  default: vz
network:
  subnet_cidr: 192.168.64.0/24
  subnet_gateway: 192.168.64.1
  dns_server: 1.1.1.1
```

Restart the Hypeman server after changing its configuration and create a fresh sandbox. This configuration was verified with successful HTTPS requests to npm's registry and `example.com` from an actual allow-all guest. It does not require changing macOS's global networking configuration.

The default image is `oven/bun:1-debian`. Custom images must provide `bun`, `/bin/sh`, `stty`, `runuser`, `useradd`, `id`, and standard filesystem tools in their PATH. The adapter creates the `sandbox` user, `/home/sandbox`, and `/vercel/sandbox` on first boot. The supplied development image adds popular language runtimes and coding tools. Commands run as `sandbox` unless root is explicitly requested. PTYs use `runuser`; regular commands also use the selected UID, GID, and supplementary groups through `runuser`.

## Execution transport

Hypeman exposes `GET /instances/{id}/exec` as a WebSocket. Its first text message contains an argument array, environment, working directory, and PTY configuration. Binary messages carry input/output and the final text message contains `exitCode`. PTY resize messages are `{ "resize": { "rows": 24, "cols": 80 } }`. See the [native exec handler](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/cmd/api/api/exec.go).

Two upstream behaviors require a guest bridge:

- The public socket merges stdout and stderr.
- The [guest's non-PTY execution path](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/system/guest_agent/exec.go) buffers output until process exit.

Regular commands therefore run through a small inline Bun program over a raw, non-echoing PTY. Their actual child process has ordinary piped stdin/stdout/stderr. The bridge sends JSON lines with base64 binary payloads and supports stdin EOF, process-group signals, deadlines, and separate output streams. The adapter waits for the bridge's readiness frame before sending configuration over stdin, preventing a terminal's initial echo from corrupting framing. This keeps caller arguments and environment out of Hypeman's audited command array and avoids encoding the entire configuration into one size-limited Linux argument. Interactive terminals inherit native PTYs through a small Bun helper, with their configuration in the native environment. `runuser` establishes the target user's supplementary groups; an explicit environment is applied afterward, so removed environment keys do not leak from the transport and caller loader variables cannot affect the root helper. No permanent guest server or publicly reachable guest agent is required.

File copies use [Hypeman's native copy WebSocket](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/cmd/api/api/cp.go), including explicit completion acknowledgements and file-size verification. The default buffered native download limit is 256 MiB.

## Lifetimes and persistent state

Hypeman's native `ttl` and `expires_at` [delete the instance and writable disk](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/instances/ttl_reaper.go). Sbox intentionally does not use these fields. A root-owned guest watchdog exits the VM entrypoint when its deadline passes; Hypeman then [cleanly shuts down the VM](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/system/init/mode_exec.go), retaining the writable disk. The control plane also enforces its recorded deadlines. Timeout extensions atomically replace the watchdog's deadline file. Starts and snapshot restores receive fresh deadlines.

The guest watchdog is supplemented by Sbox’s detached control-plane-host supervisor. The supervisor survives API-process termination, observes durable deadlines, verifies the exact native instance identity, and stops persistent or deletes ephemeral VMs through Hypeman. Guest root cannot change that host record. Enforcement still requires the control-plane host to run and Hypeman to be reachable. Native deletion TTL is unsuitable for persistent sandboxes.

On v0.3.0, guests without an external NIC also boot with loopback down. The watchdog enables the existing `lo` interface using Linux's interface-control ioctl through Bun FFI when needed. This lets services listen on `127.0.0.1` while deny-all remains in force: no external NIC or route is added. The operation runs on every boot, including snapshot restores.

## Capability limits

The service reports backend capabilities instead of silently simulating unavailable host features.

| Feature                          | Behavior                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation                        | A Hypeman microVM on the configured hypervisor                                                                                                                                                                                                                                                                                                                |
| Networking                       | The default server omits the native NIC and mediates outbound traffic through exec. The lower-level native adapter still supports attached `allow-all` and NIC-less `deny-all`.                                                                                                                                                                               |
| Destination policies             | The control-plane proxy enforces domain/CIDR rules, HTTP matchers, transforms, forwarding, synthetic responses, and live updates. Native Hypeman firewall behavior is not used as the enforcement boundary.                                                                                                                                                   |
| Native credential brokering      | Destination-scoped HTTPS header injection with live rotation. Guest commands receive mock values; real values stay on the host. Requires a functioning native egress proxy and `allow-all`. This does not implement a destination firewall.                                                                                                                   |
| Snapshots                        | Stopped filesystem snapshots. Availability is checked against `/capabilities` for the configured runtime. Released v0.3.0 lacks that endpoint, so Sbox probes the snapshot API and marks runtime support unverified until capture. Source stays stopped.                                                                                                      |
| Snapshot restore                 | With the companion, transplants only the root overlay into a fresh stopped VM, preserving its new CPU/memory/network/mount configuration before start. Base image digest/platform and disk capacity must match. Without it, native fork restrictions apply.                                                                                                   |
| Drive generations                | Sources without writable native attachments can be copied into independent volumes. With the optional host storage companion, active writers can be captured using atomic filesystem clones. Readonly generations can be shared or used as independent writable overlays. Overlay instances use native stop/start rather than root-only snapshot replacement. |
| Writable drives and VM snapshots | The companion copies a stopped root overlay into a drive-free snapshot carrier, then uses native stopped snapshots for image retention and cleanup. External drive contents remain separate.                                                                                                                                                                  |
| Terminal output                  | A PTY combines stdout and stderr by definition. Ordinary commands retain separate streams.                                                                                                                                                                                                                                                                    |
| Preview access                   | The control plane proxies through guest execution, so private VM IPs need not be routable from the client.                                                                                                                                                                                                                                                    |

Unit tests use an in-process HTTP/WebSocket protocol fixture and real local Bun bridge subprocesses. They cover binary transfer, streaming before exit, separate stderr, stdin EOF, signals, disconnects, capability failures, and preservation of disks on timeout. Run the opt-in live suite against an explicitly configured Hypeman server to verify the complete hypervisor path.

## Brokered credentials

The default server uses Sbox’s [NIC-less mediated broker](networking.md), tested on real VZ guests with HTTPS injection, rotation, live deny updates, binary uploads, and blocked direct connections. The following describes the optional lower-level native adapter path.

Both Hypeman v0.3.0 and the checked upstream commit expose credentials in `POST /instances` and rotation in `PATCH /instances/{id}`. Sbox probes the provider's `/spec.json` for these fields. `credentialBrokering: true` reports this API support; it does not certify that the host proxy is reachable. Creation verifies guest redaction, the proxy CA, and an actual HTTP CONNECT acknowledgement before installing real secret values. A failed check deletes the new instance and fails the request.

Credentials are separate from ordinary guest environment variables:

```ts
const sandbox = await Sandbox.create({
  networkPolicy: "allow-all",
  credentials: {
    API_KEY: {
      source: { env: "PROVIDER_SECRET" },
      inject: [
        {
          hosts: ["api.example.com"],
          as: { header: "Authorization", format: "Bearer ${value}" },
        },
      ],
    },
  },
  credentialSecrets: { PROVIDER_SECRET: process.env.PROVIDER_SECRET! },
});
```

The guest sees `API_KEY=mock-API_KEY` and no `PROVIDER_SECRET`. The host substitutes the real header for matching HTTPS destinations. Host patterns are exact hostnames/IP addresses or single-level wildcards such as `*.example.com`. Plain HTTP receives no real secret. Credential policies are immutable across native snapshot restores; values can rotate. Native rotation requires a running instance; the service stores updates for stopped sandboxes and applies them on resume.

The native [config disk builder](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/instances/configdisk.go) replaces credential aliases in the guest environment, but does not remove a differently named source key. Sbox deliberately rewrites native source bindings to their aliases and never sends logical source keys in native env. Creation initially supplies disposable values, then rotates after checking the guest. The adapter reconstructs commands from explicit environment values, strips logical credential sources, restores mock aliases, and selectively forwards the provider's proxy and CA configuration. Regular commands and PTYs follow the same rule. A nonsecret policy manifest supports recovery after adapter restarts; public sandbox records do not include secrets.

An injection rule limits where that credential is substituted; it does not restrict all guest traffic. The native [Linux enforcement](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/egressproxy/enforce_linux.go) blocks direct IPv4 TCP forwarding except traffic to the gateway. It does not cover UDP/DNS, IPv6, or all host services. [Other hosts](https://github.com/kernel/hypeman/blob/ac8e683f7f0877794b288995520b6075772e865e/lib/egressproxy/enforce_other.go) have no native direct-traffic enforcement. The adapter therefore reports credential injection separately from general network policy enforcement.

On the tested macOS v0.3.0 host, broker creation verified mock environment values and proxy CA setup, but the native proxy accepted TCP connections without acknowledging CONNECT requests. The readiness check now rejects this condition within five seconds before installing real secrets. Actual HTTPS injection and rotation were covered by adapter protocol tests, but have not passed a full guest-to-upstream live test on this host. A working provider proxy is required; do not treat the capability flag as an operational health check. On VZ, the NAT gateway interface must also exist before Hypeman can bind its proxy listener.

## Immutable volume copies and overlays

`cloneVolume` normally creates a temporary NIC-less helper VM with the source mounted readonly and a new destination mounted writable. It runs `cp -a --preserve=all --sparse=always`, syncs, and removes the helper. This preserves permissions, owners, timestamps, links, extended attributes, and sparse files supported by the guest filesystem. The source must have no writable native attachments. Hypeman retains attachments for stopped instances; stopping a writer alone does not make its volume available to a copy helper. The service coordinates its own writers, but direct native API access remains trusted administration.

With `storageUrl` and `storageToken` configured, the adapter probes the authenticated companion's protocol and `atomicVolumeClone` capability. It creates the destination through Hypeman, asks the companion to atomically clone the raw volume, and boots a helper with only the destination attached writable to replay its ext4 journal and sync. The helper does not change the volume root's ownership. No source attachment or guest freeze is needed. Snapshot/configuration replacement of per-instance `overlay:true` mounts is rejected before stopping or replacing a VM; ordinary stop/start preserves those writes. Companion errors never downgrade to a file copy.

The companion requires APFS `clonefile` on macOS or a filesystem supporting Linux `FICLONE`, with equal-sized source and destination volumes. This yields a crash-consistent filesystem image: application data still buffered in guest memory is not included, and applications may need their usual recovery procedure. It is not an application-consistent database backup. The companion is a separate trusted host process with its own bearer token; its token is never forwarded to Hypeman or a guest.

The caller journals destination ownership before cloning. If a copy or clone fails, the adapter removes its temporary helper and leaves the destination for the caller's recovery or cleanup. Native readonly mounts can be shared, while `overlay: true` with `overlaySizeBytes` adds an independent writable layer over a readonly base. Bootstrap ownership changes apply to that layer, preserving the base. Real VZ tests verified binary data, file modes, hardlinks, symlinks, sparse files, and isolation between a writable overlay and a simultaneous readonly mount of its base. A separate APFS live test captured an actively written volume while its original writer continued, then recovered and reopened the clone readonly with exact durable binary contents and preserved root-directory ownership and permissions. The test also confirmed that unflushed guest data may be absent from a crash-consistent image.

## Configurable filesystem restores

The host companion exposes authenticated root-image info and install endpoints. It accepts stopped, Sbox-owned instances and immutable native stopped snapshots only. Paths, native IDs, ownership names, image digests, architecture, disk sizes, and regular-file identities are checked before a root overlay is replaced. The companion never copies source instance metadata or `config.ext4`, so the replacement retains its desired configuration. A journal and fsynced atomic rename make retries idempotent; a completed install is not repeated after the target boots.

Mounted snapshots use a temporary drive-free carrier named from the durable snapshot ID. Native snapshots retain the base OCI image against Hypeman image garbage collection. The original VM is deleted after a successful persistent stop, releasing its drive attachments. A real VZ test verified snapshot capture with a writable drive, independent drive reassignment, restoration into a VM with different CPU/memory and a replacement drive, root-file rollback, and a fork without inherited mounts.
