# sbox

A Bun and TypeScript sandbox platform backed by [Hypeman](https://github.com/kernel/hypeman) microVMs. Run the control plane locally or connect it to a remote Hypeman host. Use a Vercel-style SDK, the `sbox` CLI, or an MCP server with Codex, Claude Code, and other tools.

**Real VMs, persistent workspaces, streaming commands, and interactive terminals.** There is no production fallback that executes guest commands on your host.

This is an independent implementation, not an official Vercel or Kernel product. Its SDK follows common Vercel Sandbox patterns, but it uses its own HTTP protocol. The [compatibility matrix](docs/compatibility.md) describes its API coverage and differences from Vercel’s hosted service. An optional host companion enables atomic drive captures and restores with changed VM configuration.

## Start locally

Prerequisites: Bun 1.3+ and a running [Hypeman installation](https://github.com/kernel/hypeman#quick-start). Hypeman supports Linux with KVM and Apple Silicon macOS. Docker is **not** required to run a published OCI image.

```sh
bun install
bun run src/cli/index.ts serve
```

The server reads Hypeman's `~/.config/hypeman/cli.yaml`, or `HYPEMAN_BASE_URL` and `HYPEMAN_API_KEY`. It binds to `127.0.0.1:7070` and keeps its database under `~/.local/share/sbox`. Override these with `SBOX_HOST`, `SBOX_PORT`, and `SBOX_DATA_DIR`. The control plane mediates guest networking over Hypeman’s execution channel; guest workloads have no native external network interface.

In another terminal:

```sh
bun run src/cli/index.ts create --name hello --network deny-all
bun run src/cli/index.ts exec hello -- bun -e 'console.log("hello from a VM")'
bun run src/cli/index.ts stop hello
bun run src/cli/index.ts resume hello
bun run src/cli/index.ts delete hello
```

For an executable:

```sh
bun run build
./dist/sbox --help
```

The default image is `oven/bun:1-debian`, which runs Bun immediately. For git, Node, Python, build tools, or coding agents, use the [development image](#development-image) or another compatible OCI image. Custom images must contain Bun, `/bin/sh`, `stty`, `runuser`, `useradd`, and a standard Linux user database. The adapter prepares the non-root `sandbox` user and `/vercel/sandbox` workspace.

## TypeScript SDK

Within this repository:

```ts
import { Sandbox } from "./src/index.ts";

const sandbox = await Sandbox.create({
  name: "analysis",
  networkPolicy: "deny-all",
  timeout: 60_000,
  resources: { vcpus: 2, memoryMb: 1024 },
});

try {
  await sandbox.writeFiles([{ path: "input.txt", content: "hello\n" }]);
  const result = await sandbox.runCommand("bun", [
    "-e",
    "console.log(await Bun.file('input.txt').text())",
  ]);
  console.log(await result.stdout());
  console.log(result.exitCode);
} finally {
  await sandbox.stop();
}
```

The package exports `Sandbox`, `Session`, `Command`, `CommandFinished`, `Snapshot`, `Drive`, `APIError`, and types. Local consumers can use a workspace or file dependency on `@sbox/sandbox`. This repository has not been published to npm.

Commands execute argument arrays directly. For pipes and shell syntax, run `bash -lc` explicitly. A nonzero exit code resolves normally; transport errors, command deadlines, and sandbox expiration reject. `sudo: true` runs a command as root inside the VM.

```ts
const command = await sandbox.runCommand({
  cmd: "bun",
  args: ["run", "server.ts"],
  detached: true,
});
for await (const { stream, data } of command.logs()) {
  process[stream].write(data);
}
const finished = await command.wait();
```

Detached command handles can be reattached with `sandbox.getCommand(commandId)`. `logs()` decodes UTF-8 incrementally; `rawLogs()` returns exact bytes. Streams reconnect using stored sequence numbers, without rerunning the command. Output retention defaults to a rolling 16 MiB per command; live subscribers continue receiving output beyond that limit. `command.truncated` reports evicted history, and an expired replay cursor raises `LOGS_EXPIRED` rather than returning an incomplete transcript.

Use `stdin: true` with a detached command and `writeStdin` / `closeStdin`, or pass a Node `Readable` for attached execution. Both stdout and stderr accept caller-owned `Writable` streams.

## Persistence, snapshots, and drives

Named sandboxes are persistent by default. `stop()` preserves the root filesystem and captures an automatic snapshot when supported; the next command or file operation starts a new session. Running processes do not survive. `onResume` restarts services for the calling SDK handle; `getOrCreate` also supports `onCreate`.

Set `persistent: false` for disposable work: stopping deletes the VM and its disk. The CLI's `run` command deletes its sandbox on completion unless `--keep` is used.

```ts
const snapshot = await sandbox.snapshot(); // stops the source
const fork = await Sandbox.create({
  source: { type: "snapshot", snapshotId: snapshot.snapshotId },
});
```

Snapshots preserve the root filesystem separately from external drives. Retention is configurable using `snapshotExpiration` and `keepLastSnapshots`. The [host companion](#host-storage-companion) enables snapshots with mounted drives and restores with changed CPU, memory, or mounts. Without it, persistent resume retains the original VM disk and configuration. Forks do not inherit drive mounts.

```ts
import { Drive, Sandbox } from "./src/index.ts";
const cache = await Drive.getOrCreate({ name: "cache", sizeBytes: 1024 ** 3 });
const box = await Sandbox.create({ mounts: { "/data": cache } });
```

A writable drive attachment is exclusive. With the host companion, a persistent stop releases its attachment; otherwise delete the old sandbox to release it. Deleting a sandbox does not delete its drives. `drive.snapshot()` returns an immutable mount descriptor, captured when mounted, while `drive.fork({ name })` creates a writable copy. Ordinary readonly mounts remain live views of their source.

## Previews and interactive terminals

Expose a port and bind your application to `0.0.0.0` or loopback inside the VM:

```ts
const box = await Sandbox.create({ ports: [3000] });
await box.runCommand({
  cmd: "bun",
  args: ["run", "server.ts"],
  detached: true,
});
console.log(box.domain(3000));
```

Local URLs use a unique `*.localhost` hostname. The initial URL contains a preview-scoped access token; opening it exchanges that token for an HttpOnly cookie and removes it from the URL. Possession of that URL grants access to the exposed application. HTTP requests and WebSocket traffic travel through the guest execution transport, so the control plane does not require direct access to private VM addresses. Request bodies are capped at 16 MiB. Start your application before opening its preview.

`bun run src/cli/index.ts connect hello` opens an interactive PTY with terminal resizing, binary input/output, and signal handling. SDK integrations use `openInteractive()` to obtain a single-use WebSocket ticket, valid for 60 seconds. The protocol is documented in [the architecture guide](docs/architecture.md).

## Codex and Claude Code

The [harness guide](docs/harnesses.md) covers headless execution, interactive login, Codex app-server, Claude stream-json, MCP, and explicit credential injection. It includes examples for local and remote operation.

```sh
# An image containing the harnesses is required.
bun run src/cli/index.ts run --image sbox-agents:local \
  --harness codex --prompt 'Explain this repository' --env-file .agent.env

bun run src/cli/index.ts run --image sbox-agents:local \
  --harness claude --prompt 'Review this project' --env-file .agent.env

# Expose sandbox tools to a coding harness through MCP stdio.
bun run src/cli/index.ts mcp
```

Credentials are opt-in. The service does not import your host's agent logins, SSH keys, environment, or home directory into a VM. Model-provider credentials given to the guest can be read by guest code. For supported API clients, use [host-held credential brokering and destination policies](docs/networking.md) to keep real tokens outside the guest.

## Host storage companion

Run the optional companion beside Hypeman, as the same host user, to capture actively written drives and restore snapshots with changed CPU, memory, or mounts:

```sh
# On the Hypeman host. Use the data_dir from its server configuration.
export SBOX_STORAGE_TOKEN='replace-with-a-separate-long-random-secret'
bun run src/cli/index.ts host serve --data-dir /path/to/hypeman-data

# On the control-plane host, before starting sbox serve:
export SBOX_STORAGE_URL=http://127.0.0.1:7071
export SBOX_STORAGE_TOKEN='the-same-storage-companion-secret'
```

For remote Hypeman, the companion runs on that remote host and its URL must be reachable from the control plane. Use TLS or a trusted tunnel. Active drive captures require APFS or Linux reflink support and are crash-consistent; sync application data when a stricter consistency point matters. CPU, memory, environment, and mount updates apply to the next session. Without the companion, ordinary filesystem snapshots and persistent stop/start remain available, but VM configuration overrides and snapshots with mounted writable drives are restricted.

## Development image

[images/Dockerfile](images/Dockerfile) provides Bun, Node, Python, git, ripgrep, compilers, sudo, and a non-root workspace. Install agent versions explicitly at build time:

```sh
docker build -f images/Dockerfile -t sbox-runtime:local .

# Set versions you have reviewed; no agent package is installed by default.
docker build -f images/Dockerfile -t sbox-agents:local \
  --build-arg CODEX_VERSION="$CODEX_VERSION" \
  --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" .
```

Push custom images to an OCI registry reachable by the Hypeman host, or import them using Hypeman's image tooling. A local Docker tag alone is not automatically visible to a remote Hypeman server. Set `SBOX_IMAGE` to make your development image the server default. `runtime: "bun"` works with the default image; other legacy runtime aliases require an explicitly selected compatible image.

## Remote operation

The SDK talks to the same API whether the server is local or remote:

```sh
# On the control-plane host; Hypeman may be local or another remote host.
export SBOX_TOKEN='replace-with-a-long-random-secret'
export HYPEMAN_BASE_URL='http://your-hypeman-host:4973'
export HYPEMAN_API_KEY='your-hypeman-token'
bun run src/cli/index.ts serve --host 0.0.0.0 --port 7070 \
  --public-url https://sbox.example.com --preview-host previews.example.com

# On the client:
export SBOX_URL='https://sbox.example.com'
export SBOX_TOKEN='the-same-control-plane-secret'
bun run src/cli/index.ts list
```

Put a TLS reverse proxy in front of the server and configure wildcard DNS/TLS for `*.previews.example.com` if you use remote previews. Remote binds require a bearer token of at least 16 characters. The server is a single-owner control plane, with one database writer per data directory; it is not a multi-tenant service or fleet scheduler. Keep its API and Hypeman's API on trusted infrastructure.

## Verification

```sh
bun run check       # strict TypeScript + protocol, SDK, CLI, server, and guest bridge tests
bun run build       # standalone Bun executable

# Opt-in tests create and delete real VMs on the configured Hypeman host.
bun run test:live
```

The test-only provider launches subprocesses in disposable directories to exercise the HTTP and SDK layers. It cannot be selected by the production CLI. The live suites use actual Hypeman VMs and clean up their own resources; the storage suite additionally requires `SBOX_STORAGE_URL` and `SBOX_STORAGE_TOKEN`. See [Hypeman implementation notes](docs/hypeman.md) for tested protocols and host-dependent limits.

[Architecture and API](docs/architecture.md) · [Compatibility](docs/compatibility.md) · [Harnesses](docs/harnesses.md)
