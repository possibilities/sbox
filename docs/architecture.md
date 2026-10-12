# Architecture and API

```
SDK / CLI / MCP
       │ HTTP JSON, NDJSON, WebSocket
       ▼
Bun control plane ─── SQLite WAL metadata + command logs
       │ authenticated Hypeman REST / WebSocket
       ▼
Hypeman ─── Linux microVM from an OCI image
                   │ native exec PTY carrying framed data
                   ▼
             Bun process bridge
                   │ separate stdio, user identity, process group
                   ▼
             coding harness / shell / application
```

The server can run on the same machine as Hypeman, or connect to its remote API. The SDK only communicates with the control plane. Files, HTTP previews, and preview WebSockets travel over the guest execution transport, so remote operation does not depend on routable guest IP addresses.

## State ownership

`SandboxService` owns lifecycle transitions. A sandbox is a named durable record; a session is a particular boot; a command belongs to one session. Per-sandbox locks serialize lifecycle and filesystem operations. A catalog lock protects name creation, drive attachment admission, and deletion. The database's unique index enforces name uniqueness.

SQLite runs in WAL mode. A process lock prevents two servers from using one data directory. Metadata is persisted before guest operations where possible; a failed operation retains the exact native instance ID for cleanup. There is no automatic retry of mutating provider requests. Requests with uncertain outcomes should be inspected by sandbox name before retrying.

Command output is stored as base64 bytes with monotonically increasing sequence numbers. Readers replay using an `after` cursor. Stored replay is a bounded rolling window; older records are evicted with `truncated:true`. Live subscribers receive all new records through separate bounded queues. Expired cursors and overflowing consumers fail explicitly. SDK reconnects never execute a command again. Metadata and completed logs remain until sandbox deletion; set operational retention appropriate for your workload.

After a control-plane restart, previously running commands become `SERVER_RESTARTED`; they are not replayed. Sandbox state is reconciled with Hypeman. Stop operations that failed because the host was unavailable retain their transitional state and are retried. Persistent stop captures a native stopped-filesystem snapshot with retention and lineage records. With the host companion it then releases the native instance and drive attachments; resume transplants the root overlay into a new VM with the desired configuration. Without the companion, the stopped instance disk remains the resume path. Root overlays and external drives have separate lifecycles.

## Execution protocol

Hypeman's native non-TTY exec path buffers output, and its protocol combines stdout and stderr. sbox starts a small Bun bridge over a raw native PTY. The actual guest child uses ordinary pipes or an interactive PTY, depending on the requested mode.

The process bridge carries JSON lines with base64 data, preserving arbitrary bytes and record boundaries. It handles stdin, EOF, stdout, stderr, process-group signals, and exit codes. Non-root execution resolves the user's supplementary groups through `runuser`. Guest processes receive an explicit environment; host environment variables and API tokens are not inherited. `HOME` and the default tool paths follow the requested user.

Do not install untrusted extensions into the control plane. The execution bridge runs in the VM; the production server never launches a host subprocess to execute submitted code. The separate test fixture deliberately uses temporary host subprocesses to test transport behavior and is not selectable from the CLI.

## Deadlines

The control plane stops expired sessions and kills commands that exceed `timeoutMs`. A Bun guest watchdog is the VM entrypoint; it exits at the session deadline, which makes Hypeman power off the guest while retaining its disk. Timeout extension updates its deadline atomically.

A detached supervisor on the control-plane host also watches the durable deadline records and uses Hypeman’s API to stop persistent instances or delete ephemeral ones. It survives API-process termination, receives credentials through stdin, verifies the exact native identity, and shares crash-released SQLite lease locks with lifecycle operations. Network/host failure can delay enforcement until Hypeman is reachable. Hypeman’s native deletion TTL is not used for persistent sandboxes because it deletes the writable disk.

## Authentication and exposure

The API binds to loopback by default. A non-loopback bind requires `SBOX_TOKEN` of at least 16 characters. Auth compares token digests in constant time. JSON-only mutation requests, hostname validation, and origin checks reject accidental browser cross-origin access. There is no permissive CORS configuration. This is a single-owner API: a token grants access to every sandbox in its data directory.

Hypeman credentials stay in the control plane, and are sent in authorization headers rather than URLs. Authenticated client requests reject redirects. The database is created with mode `0600` in a directory created with mode `0700`. It contains explicitly supplied guest environment values and should be protected as credential-bearing state. Logs can also contain application secrets.

Each exposed port gets its own preview hostname and a scoped bearer URL. The initial query credential is exchanged for an HttpOnly cookie and removed by a redirect. Possession of that preview URL grants application access. Preview credentials cannot invoke the sandbox API. The proxy removes its access cookie and control-plane Authorization header before forwarding, and preserves application cookies. Configure wildcard DNS and TLS for remote preview hostnames.

## HTTP API

`GET /health` reports that the control plane is running. `GET /v1/capabilities` requires API authentication and reports Hypeman feature support. The older Hypeman release without `/capabilities` is probed conservatively through read-only endpoints; check `runtimeCapabilitiesVerified` in the response.

All management operations use `POST /v1/rpc`:

```json
{
  "method": "sandbox.create",
  "params": {
    "name": "workspace",
    "networkPolicy": "deny-all",
    "timeout": 300000
  }
}
```

Successful responses are `{ "result": ..., "requestId": "..." }`. Failures use an appropriate HTTP status and `{ "error": { "code": "...", "message": "...", "details": ... }, "requestId": "..." }`. The SDK converts these into `APIError` instances. RPC bodies are capped at 24 MiB; stdout-based filesystem responses have a 16 MiB encoded-output budget. Binary files use streaming `GET`/`PUT /v1/sandboxes/:id/files` endpoints and guest stdin/stdout; they bypass the JSON/base64 ceiling.

| Namespace | Methods                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox   | `create`, `get`, `getOrCreate`, `list`, `resume`, `stop`, `delete`, `update`, `extendTimeout`, `snapshot`, `fork`, `sessions`, `snapshots`, `openInteractive` |
| Command   | `run`, `get`, `wait`, `poll`, `list`, `kill`, `stdin`, `closeStdin`                                                                                           |
| Files     | `file.read`, `file.write`, `file.mkdir`, `fs`                                                                                                                 |
| Snapshots | `get`, `list`, `delete`, `tree`                                                                                                                               |
| Drives    | `getOrCreate`, `get`, `list`, `fork`, `delete`                                                                                                                |
| Host      | `capabilities`                                                                                                                                                |

Methods use a dotted namespace, such as `command.run`. The `id` parameter means the target sandbox, command, snapshot, or drive. Sandbox and drive lookups accept a name or ID. Commands use `cmd`, `args`, `cwd`, `env`, `user`, `sudo`, `stdin`, and `timeoutMs`. `command.run` always returns a handle immediately; the SDK implements attached execution with `command.wait` and output streams.

`file.write` accepts `files: [{ path, data, mode? }]`, with `data` in base64. `file.read` returns `{data}` or `null` for a missing file. `fs` accepts a guest filesystem operation and structured arguments. Paths are guest paths, not control-plane paths. The SDK's Node-like facade preserves binary data, hidden files, newlines in filenames, filesystem error codes, and atomic append behavior.

Lists return `{ items, nextCursor }`. The SDK decorates them with resource aliases, async iteration, `pages()`, and `toArray()`. Standard lists use offset cursors and are not a transactionally stable view across concurrent mutations. Session handles include `sessionId` on execution and file calls so an ended session cannot silently target a new boot.

### Command logs

`GET /v1/commands/:id/logs?after=0` returns NDJSON:

```json
{"sequence":1,"stream":"stdout","data":"aGVsbG8K","timestamp":1700000000000}
{"type":"done","command":{"commandId":"cmd-...","status":"exited","exitCode":0}}
```

The final command includes its complete record in the real response. `data` is base64, not UTF-8. Resume from the last received sequence number. Disconnection does not cancel the command; use `command.kill` to do so.

### Interactive terminals

`sandbox.openInteractive` returns `{url, token}`. The URL is a single-use, 60-second ticket for `/v1/terminals/:ticket`. Connect using WebSocket, then send:

```json
{ "type": "start", "command": "bash", "args": ["-l"], "cols": 100, "rows": 30 }
```

After the start frame, binary messages are stdin/stdout. Resize with `{"type":"resize","cols":120,"rows":40}`. Signals use `{"type":"signal","signal":"SIGINT"}`. The server sends `{"type":"exit","code":0}` or `{"type":"error","message":"..."}`. Closing the socket kills the interactive process. The CLI restores local terminal settings when it exits.

## Operational limits

- One control-plane process and database writer; no fleet scheduling or tenant isolation.
- Defaults: 100 active sandboxes, 256 tracked commands, 16 MiB retained output per command; the programmatic server API can configure these.
- At most 15 exposed ports and four drives per sandbox; Hypeman host limits also apply.
- Public OCI images run without Docker. Building custom images requires separate build tooling.
- Some snapshots depend on the selected hypervisor and host OS. A capability probe cannot make an unsupported native operation work.
- Active writer drive captures require a filesystem with atomic reflinks. CPU/memory/mount overrides require the host companion; root disk capacity and base image changes are rejected.
- SDK compatibility is at the source API level described in the matrix, not at Vercel's REST endpoints or authentication protocol.
