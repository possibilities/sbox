#!/usr/bin/env bun
import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { Sandbox, Snapshot, Drive, APIError, type Command } from "../index.ts";
import {
  harnessCommand,
  type HarnessName,
  type HarnessMode,
} from "../harnesses/index.ts";
import type { CreateOptions, ExecOptions } from "../types.ts";
import type { ClientOptions } from "../sdk/client.ts";
import {
  parseArgs,
  flag,
  enabled,
  numberFlag,
  pairs,
  parseEnvFile,
  required,
  UsageError,
  type Arguments,
} from "./args.ts";
import { serveMcp } from "./mcp.ts";
import { observe, printLogs, writeOutput } from "./commands.ts";
import { copyPath } from "./copy.ts";
import { configuration, mergeOptions } from "./config.ts";

export const help = `sbox — local or remote Hypeman sandboxes

Usage: sbox [--url URL] [--token TOKEN] <command> [options] [-- guest argv...]

  serve                       Start the control plane (requires Hypeman)
  host serve                  Start the authenticated Hypeman storage companion
  create                      Create a sandbox; prints its ID
  update <id>                 Update sandbox configuration
  list                        List sandboxes
  get <id>                    Inspect a sandbox
  exec <id> -- <cmd> [args]    Stream a command; preserve its exit code
  commands <id>               List commands in a sandbox
  logs <id> <command>         Print retained output (--follow to stream)
  wait <id> <command>         Wait and return the command's exit code
  kill <id> <command>         Signal a command (--signal SIGTERM by default)
  attach <id> <command>       Reattach output/signals; --stdin forwards input
  run -- <cmd> [args]          Create, execute, then delete a sandbox
  run --harness <name>         Run codex, claude, opencode, or generic
  connect <id> [-- cmd args]   Open an interactive PTY (default: bash)
  stop <id>                   Stop a sandbox
  resume <id>                 Resume a stopped sandbox
  delete <id>                 Delete a sandbox
  snapshot <id>               Snapshot a sandbox (stops the source)
  snapshots [list|get|delete]  Manage snapshots
  drives [list|create|get|fork|delete]  Manage persistent drives
  cp <local> <id>:<path>       Stream a file; --recursive copies directories
  doctor                      Check control plane health and capabilities
  mcp                         Start a sandbox MCP server over stdio

Connection: --url (SBOX_URL, default http://127.0.0.1:7070), --token (SBOX_TOKEN)
Create/run/update: --config <JSON file> --secrets-file <JSON object>
            Explicit flags override config; env/tags/mounts/resources merge by key.
Create/run: --name --image --runtime --timeout <ms> --cpu --memory <MiB>
            --disk <MiB> --ports <comma-separated> --persistent --network <allow-all|deny-all>
            --source <git URL> --revision --snapshot <id> --tag KEY=VALUE
            --mount /guest/path=drive-id[:ro] --env KEY=VALUE --env-file <file>
Execution:  --cwd --user --sudo --stdin (-i) --detached (-d) --timeout <ms>
            --detached --stdin opens guest stdin for a later attach --stdin
Logs:       --after <sequence> skips previously consumed events; --follow (-f)
Copy:       --recursive (-r); reverse operands to download; destination is exact
Harness:    --harness <codex|claude|opencode|generic> --mode <run|stdio|acp>
            --prompt <text> --model <model>; args after -- are passed verbatim
Run:        --keep retains the created sandbox and prints its ID to stderr
Serve:      --host --port --data-dir --token --hypeman-url --hypeman-token
            --public-url --preview-host; HYPEMAN_BASE_URL/HYPEMAN_API_KEY supported
Host serve: --data-dir <Hypeman data root> --token <storage token>; default port 7071
            HYPEMAN_DATA_DIR/SBOX_STORAGE_TOKEN supported; token required
Output:     --json for machine-readable metadata. Command stdout stays unchanged.

Examples:
  sbox create --image sbox-runtime:local --timeout 300000
  sbox exec sbx-... -- bun --version
  sbox run --image sbox-runtime:local -- sh -lc 'echo hello; exit 0'
  sbox exec sbx-... --stdin -- python3 -u -
  sbox run --image sbox-agents:local --harness codex --prompt 'Explain this repo'
  sbox exec sbx-... --harness opencode --mode acp

Drive fork: sbox drives fork <drive-id> --name <new-name>
Config files accept networkPolicy, credentials, mounts, retention, and other SDK options.
Secret files map credential source names to values; paths in config are never read.
Secrets are supplied explicitly; host credentials are never copied.
`;

async function environment(args: Arguments): Promise<Record<string, string>> {
  const env: Record<string, string> = Object.create(null);
  for (const path of args.flags.get("env-file") ?? [])
    Object.assign(env, parseEnvFile(await readFile(path, "utf8")));
  return Object.assign(env, pairs(args.flags.get("env") ?? [], "--env"));
}

export async function createOptions(args: Arguments, update = false) {
  if (update) {
    for (const name of [
      "name",
      "image",
      "runtime",
      "source",
      "revision",
      "snapshot",
    ]) {
      if (args.flags.has(name))
        throw new UsageError(`--${name} cannot update an existing sandbox`);
    }
  }
  const base = await configuration(args, update);
  const network = flag(args, "network");
  if (network !== undefined && !["allow-all", "deny-all"].includes(network))
    throw new UsageError("--network must be allow-all or deny-all");
  const ports = flag(args, "ports")
    ?.split(",")
    .map((value) => Number(value));
  if (
    ports?.some(
      (port) => !Number.isSafeInteger(port) || port < 1 || port > 65535,
    )
  )
    throw new UsageError(
      "--ports must be comma-separated integers from 1 to 65535",
    );
  const mounts: NonNullable<CreateOptions["mounts"]> = {};
  for (const [path, value] of Object.entries(
    pairs(args.flags.get("mount") ?? [], "--mount"),
  )) {
    if (!path.startsWith("/"))
      throw new UsageError("Mount paths must be absolute");
    const readOnly = value.endsWith(":ro");
    mounts[path] = { driveId: readOnly ? value.slice(0, -3) : value, readOnly };
  }
  const source = flag(args, "source"),
    snapshotId = flag(args, "snapshot");
  if (source && snapshotId)
    throw new UsageError("--source and --snapshot are mutually exclusive");
  const explicit = {
    name: flag(args, "name"),
    image: flag(args, "image"),
    runtime: flag(args, "runtime"),
    timeout: numberFlag(args, "timeout"),
    persistent: args.flags.has("persistent")
      ? enabled(args, "persistent")
      : undefined,
    resources: ["cpu", "memory", "disk"].some((name) => args.flags.has(name))
      ? {
          ...(args.flags.has("cpu") ? { vcpus: numberFlag(args, "cpu") } : {}),
          ...(args.flags.has("memory")
            ? { memoryMb: numberFlag(args, "memory") }
            : {}),
          ...(args.flags.has("disk")
            ? { diskMb: numberFlag(args, "disk") }
            : {}),
        }
      : undefined,
    ports,
    networkPolicy: network as "allow-all" | "deny-all" | undefined,
    env:
      args.flags.has("env") || args.flags.has("env-file")
        ? await environment(args)
        : undefined,
    tags: args.flags.has("tag")
      ? pairs(args.flags.get("tag")!, "--tag")
      : undefined,
    mounts: args.flags.has("mount") ? mounts : undefined,
    source: snapshotId
      ? { type: "snapshot", snapshotId }
      : source
        ? { type: "git", url: source, revision: flag(args, "revision") }
        : undefined,
  } satisfies CreateOptions;
  if (args.flags.has("revision") && !source) {
    if (snapshotId || base.source?.type !== "git")
      throw new UsageError(
        "--revision requires a Git source in --source or --config",
      );
    explicit.source = { ...base.source, revision: flag(args, "revision") };
  }
  const merged = mergeOptions(base, explicit);
  if (update && Object.keys(merged).length === 0)
    throw new UsageError(
      "update requires --config or explicit configuration flags",
    );
  return merged;
}

async function execOptions(args: Arguments): Promise<ExecOptions> {
  const harness = flag(args, "harness");
  const env = await environment(args);
  let command: ExecOptions;
  if (harness) {
    const generic = harness === "generic";
    command = harnessCommand({
      harness: harness as HarnessName,
      mode: flag(args, "mode") as HarnessMode | undefined,
      prompt: flag(args, "prompt"),
      model: flag(args, "model"),
      cwd: flag(args, "cwd"),
      env,
      command: generic ? args.command[0] : undefined,
      args: generic ? args.command.slice(1) : args.command,
    });
  } else {
    command = {
      cmd: required(args.command[0], "guest command after --"),
      args: args.command.slice(1),
      env,
      cwd: flag(args, "cwd"),
      stdin: enabled(args, "stdin"),
    };
  }
  return {
    ...command,
    stdin: command.stdin || enabled(args, "stdin"),
    user: flag(args, "user"),
    sudo: enabled(args, "sudo"),
    timeoutMs: numberFlag(args, "timeout"),
    detached: true,
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function printMetadata(
  value: { toJSON?: () => unknown },
  json: boolean,
  fallback?: string,
): void {
  if (json || !fallback) print(value.toJSON ? value.toJSON() : value);
  else process.stdout.write(`${fallback}\n`);
}
function listTable(rows: Array<Record<string, unknown>>, keys: string[]): void {
  if (!rows.length) {
    process.stdout.write("No results.\n");
    return;
  }
  const widths = keys.map((key) =>
    Math.min(
      60,
      Math.max(key.length, ...rows.map((row) => String(row[key] ?? "").length)),
    ),
  );
  const line = (row: Record<string, unknown>) =>
    keys
      .map((key, i) =>
        String(row[key] ?? "")
          .slice(0, 60)
          .padEnd(widths[i]!),
      )
      .join("  ")
      .trimEnd();
  process.stdout.write(
    `${line(Object.fromEntries(keys.map((key) => [key, key.toUpperCase()])))}\n${rows.map(line).join("\n")}\n`,
  );
}

/** Stream without buffering command output; detach and preserve host stdin on completion. */
export async function streamCommand(
  command: Command,
  forwardStdin: boolean,
  after?: number,
): Promise<number> {
  let input = Promise.resolve();
  let inputError: unknown;
  let finished = false;
  let interrupts = 0;
  const ended = (error: unknown) =>
    error instanceof APIError &&
    ["COMMAND_ENDED", "COMMAND_FINISHED"].includes(error.code);
  const interrupt = () => {
    void command.kill(++interrupts > 1 ? "SIGKILL" : "SIGINT").catch(() => {});
  };
  const terminate = () => {
    void command.kill("SIGTERM").catch(() => {});
  };
  const onData = (data: Buffer | string) => {
    process.stdin.pause();
    input = input
      .then(() => (finished ? undefined : command.writeStdin(data)))
      .then(() => {
        if (!finished) process.stdin.resume();
      })
      .catch((error) => {
        if (!finished && !ended(error)) {
          inputError = error;
          void command.kill().catch(() => {});
        }
      });
  };
  const onEnd = () => {
    input = input
      .then(() => (finished ? undefined : command.closeStdin()))
      .catch((error) => {
        if (!finished && command.exitCode === null && !ended(error))
          inputError = error;
      });
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (forwardStdin) {
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    if (process.stdin.readableEnded) onEnd();
    else process.stdin.resume();
  }
  try {
    for await (const log of command.rawLogs({ after })) {
      const destination =
        log.stream === "stdout" ? process.stdout : process.stderr;
      await writeOutput(destination, log.data);
    }
    finished = true;
    const result = await command.wait();
    if (inputError && result.exitCode === 0) throw inputError;
    return result.exitCode;
  } finally {
    finished = true;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    if (forwardStdin) {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
    }
  }
}

async function connect(sandbox: Sandbox, args: Arguments): Promise<number> {
  const command = args.command.length
    ? args.command
    : [flag(args, "shell") ?? "bash"];
  const session = await sandbox.openInteractive({
    cmd: command[0]!,
    args: command.slice(1),
    cwd: flag(args, "cwd"),
    env: await environment(args),
    user: flag(args, "user"),
    sudo: enabled(args, "sudo"),
  });
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(session.url);
    socket.binaryType = "arraybuffer";
    let exitCode = 0,
      closed = false,
      opened = false;
    const wasRaw = process.stdin.isRaw;
    const resize = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: process.stdout.columns ?? 80,
            rows: process.stdout.rows ?? 24,
          }),
        );
    };
    const data = (chunk: Buffer) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
    };
    const end = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(new Uint8Array([4]));
    };
    const interrupt = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(new Uint8Array([3]));
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      process.stdin.off("data", data);
      process.stdin.off("end", end);
      process.stdout.off("resize", resize);
      process.off("SIGINT", interrupt);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    };
    socket.onopen = () => {
      opened = true;
      socket.send(
        JSON.stringify({
          type: "start",
          cols: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        }),
      );
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on("data", data);
      process.stdin.once("end", end);
      process.stdout.on("resize", resize);
      process.on("SIGINT", interrupt);
      process.stdin.resume();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        process.stdout.write(Buffer.from(event.data as ArrayBuffer));
        return;
      }
      try {
        const message = JSON.parse(event.data) as {
          type: string;
          code?: number;
          message?: string;
        };
        if (message.type === "exit") {
          exitCode = message.code ?? 0;
          socket.close();
        }
        if (message.type === "error") {
          cleanup();
          socket.close();
          reject(new Error(message.message ?? "Terminal failed"));
        }
      } catch {
        process.stdout.write(event.data);
      }
    };
    socket.onerror = () => {
      cleanup();
      socket.close();
      reject(new Error("Terminal connection failed"));
    };
    socket.onclose = (event) => {
      cleanup();
      if (!opened || (event.code !== 1000 && event.code !== 1005))
        reject(new Error(`Terminal disconnected (${event.code})`));
      else resolve(exitCode);
    };
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "__lease-worker") {
    try {
      const { runLeaseSupervisorFromStdin } = await import(
        "../server/leases.ts"
      );
      await runLeaseSupervisorFromStdin();
      return 0;
    } catch {
      return 1;
    }
  }
  const args = parseArgs(argv);
  if (enabled(args, "version")) {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  if (enabled(args, "help") || !args.positionals.length) {
    process.stdout.write(help);
    return 0;
  }
  const [action, target, extra] = args.positionals;
  if (
    (args.flags.has("config") || args.flags.has("secrets-file")) &&
    !["create", "run", "update"].includes(action!)
  )
    throw new UsageError(
      "--config and --secrets-file apply only to create, run, and update",
    );
  const connection: ClientOptions = {
    baseUrl: flag(args, "url"),
    token: flag(args, "token"),
  };
  const json = enabled(args, "json");
  const get = () =>
    Sandbox.get({ ...connection, sandboxId: required(target, "sandbox ID") });
  switch (action) {
    case "host": {
      if (target !== "serve") throw new UsageError("host expects serve");
      const { startHostServer } = await import("../host/index.ts");
      const server = await startHostServer({
        hostname: flag(args, "host") ?? "127.0.0.1",
        port: numberFlag(args, "port", 7071),
        dataDir: required(
          flag(args, "data-dir") ?? process.env.HYPEMAN_DATA_DIR,
          "Hypeman data directory (--data-dir or HYPEMAN_DATA_DIR)",
        ),
        token: required(
          flag(args, "token") ?? process.env.SBOX_STORAGE_TOKEN,
          "storage token (--token or SBOX_STORAGE_TOKEN)",
        ),
        hypemanUrl: flag(args, "hypeman-url") ?? process.env.HYPEMAN_BASE_URL,
        hypemanToken:
          flag(args, "hypeman-token") ?? process.env.HYPEMAN_API_KEY,
        publicUrl: flag(args, "public-url"),
      });
      process.stderr.write(
        `sbox storage companion listening on ${server.url}\n`,
      );
      const stop = () => {
        void server.stop(true);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return 0;
    }
    case "serve": {
      const { startServer } = await import("../server/index.ts");
      const server = await startServer({
        hostname: flag(args, "host") ?? process.env.SBOX_HOST ?? "127.0.0.1",
        port: numberFlag(args, "port", Number(process.env.SBOX_PORT ?? 7070)),
        dataDir: flag(args, "data-dir") ?? process.env.SBOX_DATA_DIR,
        token: connection.token ?? process.env.SBOX_TOKEN,
        hypemanUrl: flag(args, "hypeman-url") ?? process.env.HYPEMAN_BASE_URL,
        hypemanToken:
          flag(args, "hypeman-token") ?? process.env.HYPEMAN_API_KEY,
        publicUrl: flag(args, "public-url") ?? process.env.SBOX_PUBLIC_URL,
        previewHost:
          flag(args, "preview-host") ?? process.env.SBOX_PREVIEW_HOST,
        leaseWorker: Bun.main.startsWith("/$bunfs/")
          ? { executable: process.execPath, workerArgs: ["__lease-worker"] }
          : undefined,
      });
      process.stderr.write(`sbox listening on ${server.url}\n`);
      const stop = () => {
        void server.stop(true);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return 0;
    }
    case "create": {
      const sandbox = await Sandbox.create({
        ...(await createOptions(args)),
        ...connection,
      });
      printMetadata(sandbox, json, sandbox.sandboxId);
      return 0;
    }
    case "update": {
      const patch = await createOptions(args, true);
      const sandbox = await get();
      await sandbox.update(patch);
      printMetadata(sandbox, json, sandbox.sandboxId);
      return 0;
    }
    case "list": {
      const result = await Sandbox.list({
        ...connection,
        limit: numberFlag(args, "limit"),
        cursor: flag(args, "cursor"),
      });
      if (json) print(result);
      else
        listTable(result.items as unknown as Array<Record<string, unknown>>, [
          "sandboxId",
          "name",
          "status",
          "image",
        ]);
      return 0;
    }
    case "get":
      printMetadata(await get(), true);
      return 0;
    case "stop": {
      const sandbox = await get();
      await sandbox.stop();
      printMetadata(sandbox, json, sandbox.sandboxId);
      return 0;
    }
    case "delete": {
      const sandbox = await get();
      await sandbox.delete();
      printMetadata(sandbox, json, sandbox.sandboxId);
      return 0;
    }
    case "resume": {
      const sandbox = await get();
      await sandbox.resume();
      printMetadata(sandbox, json, sandbox.sandboxId);
      return 0;
    }
    case "exec": {
      const options = await execOptions(args);
      const command = await (await get()).runCommand(options);
      if (enabled(args, "detached")) {
        printMetadata(command, json, command.commandId);
        return 0;
      }
      return streamCommand(command, !!options.stdin);
    }
    case "commands": {
      const result = await (
        await get()
      ).listCommands({
        limit: numberFlag(args, "limit"),
        cursor: flag(args, "cursor"),
      });
      if (json) print(result);
      else
        listTable(result.items as unknown as Array<Record<string, unknown>>, [
          "commandId",
          "cmd",
          "status",
          "exitCode",
        ]);
      return 0;
    }
    case "logs":
    case "wait":
    case "kill":
    case "attach": {
      const command = await (
        await get()
      ).getCommand(required(extra, "command ID"));
      if (action === "kill") {
        await command.kill(flag(args, "signal") ?? "SIGTERM");
        if (json)
          print({
            commandId: command.commandId,
            signal: flag(args, "signal") ?? "SIGTERM",
          });
        return 0;
      }
      if (action === "attach")
        return streamCommand(
          command,
          enabled(args, "stdin"),
          numberFlag(args, "after"),
        );
      return observe(async (signal) => {
        if (action === "logs") {
          await printLogs(command, {
            signal,
            after: numberFlag(args, "after"),
            follow: enabled(args, "follow"),
          });
          return 0;
        }
        const result = await command.wait({ signal });
        if (json) print(result.toJSON());
        return result.exitCode;
      });
    }
    case "run": {
      const options = await execOptions(args);
      if (enabled(args, "detached"))
        throw new UsageError(
          "Use create then exec --detached to manage background commands",
        );
      const sandbox = await Sandbox.create({
        ...(await createOptions(args)),
        ...connection,
      });
      if (enabled(args, "keep"))
        process.stderr.write(`Sandbox: ${sandbox.sandboxId}\n`);
      try {
        return await streamCommand(
          await sandbox.runCommand(options),
          !!options.stdin,
        );
      } finally {
        if (!enabled(args, "keep")) await sandbox.delete();
      }
    }
    case "connect":
      return connect(await get(), args);
    case "snapshot": {
      const snapshot = await (
        await get()
      ).snapshot({
        name: flag(args, "name"),
        expiration: numberFlag(args, "expires"),
      });
      printMetadata(snapshot, json, snapshot.snapshotId);
      return 0;
    }
    case "snapshots": {
      if (!target || target === "list") {
        print(
          await Snapshot.list({
            ...connection,
            limit: numberFlag(args, "limit"),
            cursor: flag(args, "cursor"),
          }),
        );
        return 0;
      }
      const snapshot = await Snapshot.get({
        ...connection,
        snapshotId: required(extra, "snapshot ID"),
      });
      if (target === "get") printMetadata(snapshot, true);
      else if (target === "delete") {
        await snapshot.delete();
        process.stdout.write(`${snapshot.snapshotId}\n`);
      } else throw new UsageError("snapshots expects list, get, or delete");
      return 0;
    }
    case "drives": {
      if (!target || target === "list") {
        print(
          await Drive.list({
            ...connection,
            limit: numberFlag(args, "limit"),
            cursor: flag(args, "cursor"),
          }),
        );
        return 0;
      }
      if (target === "create") {
        const drive = await Drive.getOrCreate({
          ...connection,
          name: required(flag(args, "name") ?? extra, "drive name"),
          sizeBytes: numberFlag(args, "size", 1024 * 1024 * 1024),
        });
        printMetadata(drive, json, drive.driveId);
        return 0;
      }
      const drive = await Drive.get({
        ...connection,
        driveId: required(extra, "drive ID"),
      });
      if (target === "fork") {
        const fork = await drive.fork({
          name: required(flag(args, "name"), "fork name (--name)"),
        });
        printMetadata(fork, json, fork.driveId);
      } else if (target === "get") printMetadata(drive, true);
      else if (target === "delete") {
        await drive.delete();
        process.stdout.write(`${drive.driveId}\n`);
      } else
        throw new UsageError(
          "drives expects list, create, get, fork, or delete",
        );
      return 0;
    }
    case "cp": {
      const src = required(target, "source path"),
        dst = required(extra, "destination path");
      const remote = (value: string) => /^([^/:]+):(.+)$/.exec(value);
      const from = remote(src),
        to = remote(dst);
      if (Boolean(from) === Boolean(to))
        throw new UsageError(
          "cp requires one local path and one sandboxId:/guest/path",
        );
      if (to) {
        const sandbox = await Sandbox.get({ ...connection, sandboxId: to[1]! });
        return observe(async (signal) => {
          await copyPath(sandbox, "upload", src, to[2]!, {
            recursive: enabled(args, "recursive"),
            signal,
          });
          return 0;
        });
      } else {
        const sandbox = await Sandbox.get({
          ...connection,
          sandboxId: from![1]!,
        });
        return observe(async (signal) => {
          await copyPath(sandbox, "download", from![2]!, dst, {
            recursive: enabled(args, "recursive"),
            signal,
          });
          return 0;
        });
      }
    }
    case "doctor": {
      const baseUrl = (
        connection.baseUrl ??
        process.env.SBOX_URL ??
        "http://127.0.0.1:7070"
      ).replace(/\/+$/, "");
      const token = connection.token ?? process.env.SBOX_TOKEN;
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      const health = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!health.ok)
        throw new Error(`Health check failed: HTTP ${health.status}`);
      const capabilities = await fetch(`${baseUrl}/v1/capabilities`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!capabilities.ok)
        throw new Error(
          `Capabilities check failed: HTTP ${capabilities.status}`,
        );
      print({
        url: baseUrl,
        health: await health.json(),
        capabilities: await capabilities.json(),
        bun: Bun.version,
      });
      return 0;
    }
    case "mcp":
      await serveMcp(connection);
      return 0;
    default:
      throw new UsageError(`Unknown command: ${action}. Run sbox --help.`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `sbox: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
