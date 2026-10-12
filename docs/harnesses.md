# Codex and Claude Code

sbox runs the real harness executable inside a Hypeman guest. The local CLI forwards stdin, stdout, stderr, signals, and exit status. `exec --stdin` uses pipes; `connect` allocates a PTY for interactive terminal applications. All commands work with a local or remote `SBOX_URL`.

## Prepare an image

The development image contains Bun, Node.js, Python, Git, a compiler toolchain, and a non-root `sandbox` user. Harness installation is opt-in. Set `CODEX_VERSION` and `CLAUDE_CODE_VERSION` to the package versions you intend to deploy, then build and publish an image accessible to your Hypeman host:

```sh
docker build -f images/Dockerfile -t registry.example.com/team/sbox-agents:1 \
  --build-arg CODEX_VERSION="$CODEX_VERSION" \
  --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" .
docker push registry.example.com/team/sbox-agents:1
```

An empty version skips that harness. The installed packages are `@openai/codex` and `@anthropic-ai/claude-code`. Image tags and local image availability depend on your Hypeman host's registry configuration; a Docker image on your laptop is not automatically available on a remote host.

For an image available only in your local Docker daemon, import it with Hypeman's CLI, for example `hypeman push local/sbox-agents:1 sandbox/sbox-agents:1`, then use `sandbox/sbox-agents:1` as the sandbox image. This is the local-image workflow in [Hypeman's sandbox image documentation](https://github.com/kernel/hypeman/blob/main/deploy/README.md#build-and-run-the-claude-code-sandbox). Published registry images can be pulled directly.

```sh
sbox create --name coding --persistent \
  --image registry.example.com/team/sbox-agents:1 --timeout 1800000
```

The working directory is `/vercel/sandbox`. Add `--source https://github.com/your-org/your-repo.git` to clone a repository at creation, or transfer files explicitly with `sbox cp` or the SDK. Commands accept the sandbox's name as well as its generated ID.

## Codex headless

Put `CODEX_API_KEY=...` in a local `.env.codex` file, restrict its permissions, and keep it out of version control. The following command supplies that file's variables only to this guest command:

```sh
chmod 600 .env.codex
sbox exec coding --harness codex --env-file .env.codex \
  --prompt 'Inspect this repository and explain the entry points'
```

The preset invokes `codex exec --json --skip-git-repo-check`, so it also works in a fresh workspace without a Git checkout. Arguments after `--` reach Codex unchanged. For a task that should edit files, pass `--sandbox workspace-write`; the preset preserves Codex's own permission defaults. To require Codex’s Git check, invoke `sbox exec coding -- codex exec ...` directly. API-key authentication through `CODEX_API_KEY` is documented for `codex exec`. See the [official OpenAI documentation for non-interactive mode](https://developers.openai.com/codex/noninteractive).

```sh
sbox exec coding --harness codex --env-file .env.codex \
  --prompt 'Add tests for the parser and run them' \
  -- --sandbox workspace-write
```

## Claude Code headless

Put `ANTHROPIC_API_KEY=...` in a separate local `.env.claude` file. The preset invokes `claude --print --output-format stream-json --verbose`:

```sh
chmod 600 .env.claude
sbox exec coding --harness claude --env-file .env.claude \
  --prompt 'Inspect this repository and explain the entry points'
```

Claude's print mode supports explicit tool permissions and turn limits. For example, allow editing and running tests with a bounded number of turns:

```sh
sbox exec coding --harness claude --env-file .env.claude \
  --prompt 'Add tests for the parser and run them' \
  -- --allowedTools 'Read,Edit,Write,Bash' --max-turns 10
```

Choose permissions appropriate to the task. sbox does not add approval bypass flags. The underlying flags and streaming format are described in [Claude Code's CLI reference](https://code.claude.com/docs/en/cli-reference) and [programmatic execution guide](https://code.claude.com/docs/en/headless).

## Interactive login and terminal sessions

Use a PTY to log in directly inside the guest. This keeps the harness's authentication files in the guest home directory:

```sh
sbox connect coding -- codex login --device-auth
sbox connect coding -- codex

sbox connect coding -- claude
```

Complete any device or browser flow using the URL displayed by the harness. A guest cannot open the host's browser for you. Claude may display a code to paste back when its callback endpoint is unreachable from the browser, a normal container scenario. See [Codex's CLI reference](https://developers.openai.com/codex/cli/reference) and [Claude authentication](https://code.claude.com/docs/en/authentication).

Guest login files survive while the sandbox's filesystem survives. Snapshots can therefore contain credentials; delete obsolete snapshots and sandboxes when they are no longer needed. sbox never mounts or copies `~/.codex`, `~/.claude`, SSH agents, or host credential stores automatically.

## Workspaces and background jobs

Transfer a local project into the guest and copy results back without buffering the complete files in memory:

```sh
sbox cp --recursive ./project coding:/vercel/sandbox
sbox cp --recursive coding:/vercel/sandbox ./project-result
```

The destination is the exact root of the copied tree, even if it already exists; source directory contents are merged there. Existing unrelated destination files remain. The copy preserves permission bits, empty directories, and relative symlinks that remain inside the selected tree. Special files and escaping symlinks are rejected. Files use temporary siblings and an atomic rename after transfer, so a failed file transfer preserves the previous destination. An interrupted tree copy may have completed some earlier files; a forced guest kill may leave a `.sbox-upload-*` temporary file. Dotfiles are included: choose the source directory explicitly and keep host credentials outside it.

Start a task in the background, then reconnect using its printed command ID:

```sh
sbox exec coding --detached --harness codex --env-file .env.codex \
  --prompt 'Add tests for the parser and run them' -- --sandbox workspace-write
sbox commands coding
sbox logs coding cmd-... --follow
sbox attach coding cmd-...
sbox wait coding cmd-...
sbox kill coding cmd-... --signal SIGTERM
```

`logs` without `--follow` prints a finite snapshot of retained output. `--after N` skips events through sequence N. Ctrl-C cancels `logs` or `wait` locally and leaves the guest command running. `attach` forwards signals to the existing process and returns its exit code; it does not start another process. Use `exec --detached --stdin` to leave guest stdin open for a later `attach --stdin`. Attached stdin EOF closes guest stdin. For terminal applications, use `connect`; reconnectable command streams are pipes rather than PTYs.

## Native protocols over stdio

These commands preserve stdout for the harness protocol and forward stderr separately:

```sh
# Codex's native app-server protocol (JSONL, not MCP or ACP).
sbox exec coding --harness codex --mode stdio

# Claude's bidirectional stream-json protocol.
sbox exec coding --harness claude --mode stdio --env-file .env.claude

# Any guest MCP server or other stdio executable.
sbox exec coding --stdin -- bun /vercel/sandbox/my-mcp-server.ts
```

For Codex app-server, authenticate interactively inside the guest first; the `CODEX_API_KEY` support documented for `exec` should not be assumed to apply to every Codex subcommand. A local protocol client can launch `sbox exec ...` as its subprocess. Client writes become guest stdin, including EOF. Guest stdout remains byte-for-byte output; sbox adds no IDs or banners to it. The CLI does not translate between different harness protocols.

The generic preset accepts arbitrary executables:

```sh
sbox exec coding --harness generic --mode stdio -- my-agent-server --stdio
```

OpenCode also has an `opencode` preset for `run` and `acp`. Codex and Claude ACP adapters, if desired, must be installed separately and launched using the generic preset. An example editor configuration for OpenCode is in [examples/zed-acp.json](../examples/zed-acp.json); its transport is documented in [OpenCode's CLI reference](https://opencode.ai/docs/cli/).

## Sandbox tools for a harness running elsewhere

`sbox mcp` exposes sandbox creation, list/get, stop/resume/delete, command execution, command listing/polling/signals, and text file reads/writes using MCP’s newline-delimited stdio transport. This allows a local Codex, Claude Code, or another MCP client to use sandbox tools without moving its own harness into the guest.

Configure a client using its supported stdio server settings:

```json
{
  "mcpServers": {
    "sbox": {
      "command": "sbox",
      "args": ["mcp"],
      "env": { "SBOX_URL": "http://127.0.0.1:7070" }
    }
  }
}
```

`mcpServers` is the Claude-style JSON configuration shape; use your client's schema if it differs. For Codex, register the same command with `codex mcp add sbox -- sbox mcp`, as described in the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp). If the server requires authentication, supply `SBOX_TOKEN` through the client's environment or secret configuration. Use an absolute executable path when a GUI application cannot resolve `sbox` on its PATH. The framing follows the [MCP stdio transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Attached MCP execution defaults to a 60-second timeout and accepts at most five minutes. For longer jobs, call `sandbox_exec` with `detached: true`; it returns a `commandId` immediately and uses the sandbox lifetime unless you explicitly supply `timeoutMs`. Call `sandbox_command_poll` with that ID and sandbox ID; pass the returned `nextCursor.after` and `nextCursor.offset` in the next request. Each response contains at most 64 KiB of source output. The cursor can resume inside a large log event, and base64 `logs` preserve exact bytes when UTF-8 characters span responses. `stdout` and `stderr` are text conveniences. `sandbox_command_kill` sends an explicit signal.

MCP cancellation notifications terminate the remote command for an active execution request, including cancellation while its creation response is in flight. Closing the stdio transport also cancels active attached work. Jobs whose detached execution request already completed remain running until they finish, time out, or receive an explicit signal. Sandbox get/list requests omit persisted environment values.

File reads are limited to 64 KiB and text writes to 512 KiB. The CLI and SDK support larger binary files and streamed output. MCP does not install the coding harness or silently supply model credentials.

## Remote execution and credential boundaries

Set `SBOX_URL` to the reachable control-plane URL and `SBOX_TOKEN` to its access token. A remote server should set `SBOX_PUBLIC_URL` to the URL reachable by clients so PTY tickets use the correct WebSocket address. Use TLS or an authenticated tunnel across untrusted networks.

Each control-plane token currently grants full access to that server's sandboxes. This implementation does not provide per-user authorization. Optional [credential brokering](networking.md) keeps real API tokens on the control-plane host and injects them only for configured destinations. Explicit environment variables are readable by guest code; sandbox-level variables are also persisted in the control plane's metadata. Guest sudo grants root inside the VM. The Hypeman VM is the isolation boundary, while a harness's own permission settings control what its agent may attempt.

Use separate sandbox instances for mutually untrusted workloads. Model inference requires a policy allowing the provider’s destinations. Domain allowlists, request transforms, brokered credentials, and live policy changes are supported. Package installation and OAuth may require additional domains; configure these deliberately.

## Verification

On 2026-10-11, a real Linux ARM64 Hypeman guest with two vCPUs, 1 GiB RAM, and a 4 GiB disk passed these checks through the sbox server and SDK:

- Commands ran as the non-root `sandbox` user.
- Node.js reported `v22.23.3`, Codex reported `codex-cli 0.162.1`, and Claude Code reported `2.1.296`.
- Codex app-server accepted an `initialize` request over streamed stdin, returned a protocol response, and exited successfully after stdin EOF.
- Claude's installed executable exposed the print, stream-json, and input-format options used by the preset.
- Approximately 276 MiB of compressed public package artifacts were transferred over command stdin and extracted inside the guest.
- Direct installation of both pinned harness packages from npm with `bun add -g` also passed as the `sandbox` user after correcting the test daemon's network configuration.

The first binary/protocol pass used public Linux ARM64 artifacts staged on the host because the isolated macOS test daemon initially used the wrong guest subnet. The Node archive was checked against the publisher's SHA-256 list. Correcting that daemon's VZ NAT subnet to `192.168.64.0/24` with gateway `192.168.64.1` restored guest HTTPS access and allowed the subsequent online installation test. No global host networking was changed. These checks used no model credentials and made no inference calls; all owned test VMs were deleted afterward. Docker image construction and authenticated model execution still require validation in the target deployment.

A subsequent live CLI check used a separate one-vCPU guest with 512 MiB RAM and a 2 GiB disk. A 20,971,523-byte binary workspace file round-tripped with its SHA-256 unchanged, and executable mode bits and an internal symlink survived. Detached command listing, finite log replay, SIGTERM, and wait returned the expected exit code 143. MCP cancellation terminated its actual guest command with exit code 137 and suppressed the cancelled response. That VM was also deleted.

A final check ran through the default server's mediated network in a fresh two-vCPU,
1 GiB guest with a 4 GiB disk. Its only interfaces were `lo` and `sboxtun0`.
Debian package installation, an HTTPS `curl` request to npm, and
`git ls-remote https://github.com/openai/codex.git HEAD` succeeded. Node.js
`22.23.3` was downloaded inside the guest from the official distribution site
and checked against the publisher's SHA-256 manifest. Bun then installed
Codex `0.162.1` and Claude Code `2.1.296` directly from npm; both version commands
passed, and Codex app-server returned its `initialize` result before exiting
successfully on stdin EOF. This validates the current TUN, DNS, certificate trust,
and package-manager path, without relying on a native guest NIC or host-staged
packages. No model credentials or inference calls were used. The VM, temporary
control plane, and its data directory were removed afterward.

## Reusable sandbox configuration

`create` and `run` accept `--config sandbox.json` with the SDK's sandbox options,
including network rules, brokered credentials, drive mounts, and snapshot retention.
For example:

```json
{
  "image": "sbox-agents:local",
  "resources": { "vcpus": 2, "memoryMb": 2048, "diskMb": 8192 },
  "networkPolicy": { "allow": ["api.anthropic.com"] },
  "credentials": {
    "ANTHROPIC_API_KEY": {
      "source": { "env": "ANTHROPIC_API_KEY" },
      "inject": [
        {
          "hosts": ["api.anthropic.com"],
          "as": { "header": "x-api-key", "format": "${value}" }
        }
      ]
    }
  },
  "mounts": { "/work": { "drive": "project", "mode": "read-write" } },
  "keepLastSnapshots": { "count": 3 }
}
```

Keep the actual provider key in a separately permissioned JSON file, such as
`secrets.json` containing `{"ANTHROPIC_API_KEY":"your-key"}`. Pass that file
explicitly; its contents are sent as `credentialSecrets`, so the key is absent
from the CLI argument list:

```sh
sbox create --config sandbox.json --secrets-file secrets.json --name coding
sbox exec coding --cwd /work --harness claude --prompt 'Review the project'
sbox drives fork project --name experiment
sbox update coding --config update.json
```

The credential example uses the host's HTTPS broker. The provider sees the real
header; guest code receives the broker's mock credential. Review the
[network policy and credential documentation](networking.md) for supported
transports and certificate trust requirements. The image must already contain
the harness, and extra domains needed for authentication or package installation
must be added explicitly.

Explicit flags override their corresponding config fields. `resources`, `env`,
`tags`, and `mounts` merge by key; a mount flag replaces that path's whole mount
entry. `ports`, `source`, and `networkPolicy` replace the configured value.
`--env-file` overlays config environment values, and `--env` wins over both.
`--secrets-file` overlays only the config's `credentialSecrets` map. All strings
remain literal: sbox does not expand environment variables, execute substitutions,
or read paths mentioned inside the JSON. Connection URL and token are separate
CLI options; they cannot be supplied by the sandbox config.

An update JSON contains only changed fields. Use `{ "env": {} }` to replace the
configured environment with an empty map, `{ "mounts": {} }` to clear future
session mounts, or `{ "keepLastSnapshots": null }` to disable automatic retention.
Creation-only `name`, `image`, `runtime`, and `source` fields are rejected on
`update`; `currentSnapshotId` selects a saved snapshot for the next session.
Resource, mount, and environment changes apply to the next session; network
policy and credential changes apply to the current mediated network. Config and
secret files must each be JSON objects no larger than 1 MiB. The control plane
validates the complete request before applying it.
