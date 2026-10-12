import {
  ProxyIdentity,
  createProxyIdentity,
  type ProxyIdentityKeys,
} from "../network/identity.ts";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Server, ServerWebSocket } from "bun";
import type { Backend, Execution } from "../backend.ts";
import {
  MediatedNetwork,
  createNetworkAuthority,
  type NetworkAuthority,
} from "../network/index.ts";
import { HypemanBackend } from "../hypeman/index.ts";
import { SboxError, errorMessage, invariant } from "../errors.ts";
import type {
  CreateOptions,
  ExecOptions,
  SessionRecord,
  SnapshotRecord,
  DriveRecord,
  CommandRecord,
} from "../types.ts";
import { SandboxService } from "./service.ts";
import { Store } from "./store.ts";
import * as v from "./validation.ts";
import { preview, openPreviewSocket, type PreviewSocket } from "./preview.ts";
import { hypemanConnection } from "./config.ts";
import { snapshotTree } from "./snapshot-tree.ts";
import { spawnLeaseSupervisor, type LeaseSupervisorHandle } from "./leases.ts";

export { SandboxService, Store };
export interface ServerOptions {
  hostname?: string;
  port?: number;
  dataDir?: string;
  token?: string;
  hypemanUrl?: string;
  hypemanToken?: string;
  storageUrl?: string;
  storageToken?: string;
  leaseSupervisor?: boolean;
  leaseWorker?: { executable: string; workerArgs: string[] };
  publicUrl?: string;
  previewHost?: string;
  defaultImage?: string;
  backend?: Backend;
  store?: Store;
  maxSandboxes?: number;
  maxCommands?: number;
  maxOutputBytes?: number;
}
interface Ticket {
  sandboxId: string;
  options: ExecOptions;
  expires: number;
  cols: number;
  rows: number;
  sessionId?: string;
}
interface SocketData {
  prepared?: PreviewSocket;
  queuedBytes?: number;
  kind: "terminal" | "preview";
  ticket?: Ticket;
  execution?: Execution;
  started: boolean;
  pending: Array<string | Buffer>;
  pendingBytes: number;
  writeChain: Promise<void>;
  request?: Request;
  sandboxId?: string;
  port?: number;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "server.lock");
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    create();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    invariant(
      Number.isSafeInteger(pid) && !alive,
      "DATABASE_LOCKED",
      "Another sbox server owns this data directory. Use a separate --data-dir.",
      409,
    );
    unlinkSync(path);
    create();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}

export async function startServer(
  options: ServerOptions = {},
): Promise<Server<SocketData>> {
  const hostname = options.hostname ?? process.env.SBOX_HOST ?? "127.0.0.1",
    port = options.port ?? Number(process.env.SBOX_PORT ?? 7070);
  v.integer(port, "port", 0, 65535);
  const token = options.token ?? process.env.SBOX_TOKEN;
  const isLocal = ["127.0.0.1", "::1", "localhost"].includes(hostname);
  invariant(
    isLocal || !!token,
    "AUTH_REQUIRED",
    "Set SBOX_TOKEN before binding to a non-loopback interface",
    400,
  );
  if (token)
    invariant(
      token.length >= 16,
      "WEAK_TOKEN",
      "SBOX_TOKEN must contain at least 16 characters",
    );
  const connection = options.backend
    ? undefined
    : await hypemanConnection({
        baseUrl: options.hypemanUrl ?? process.env.HYPEMAN_BASE_URL,
        apiKey: options.hypemanToken ?? process.env.HYPEMAN_API_KEY,
      });
  const backend =
    options.backend ??
    new HypemanBackend({
      ...connection!,
      storageUrl: options.storageUrl ?? process.env.SBOX_STORAGE_URL,
      storageToken: options.storageToken ?? process.env.SBOX_STORAGE_TOKEN,
    });
  const publicUrl = options.publicUrl ?? process.env.SBOX_PUBLIC_URL;
  const publicOrigin = publicUrl ? new URL(publicUrl) : undefined;
  if (publicOrigin)
    invariant(
      ["http:", "https:"].includes(publicOrigin.protocol) &&
        !publicOrigin.username &&
        !publicOrigin.password &&
        !publicOrigin.search &&
        !publicOrigin.hash &&
        publicOrigin.pathname === "/",
      "INVALID_ARGUMENT",
      "publicUrl must be an HTTP(S) origin without credentials or a path",
    );
  const previewHost =
    options.previewHost ?? process.env.SBOX_PREVIEW_HOST ?? "localhost";
  invariant(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(previewHost),
    "INVALID_ARGUMENT",
    "previewHost must be a DNS hostname",
  );
  const dataDir = resolve(
    options.dataDir ??
      process.env.SBOX_DATA_DIR ??
      join(homedir(), ".local/share/sbox"),
  );
  const release = options.store ? () => {} : acquireLock(dataDir);
  let store: Store;
  try {
    store = options.store ?? new Store(join(dataDir, "sbox.sqlite"));
  } catch (error) {
    release();
    throw error;
  }
  let boundPort = port;
  const supervise =
    !options.store && !!connection && options.leaseSupervisor !== false;
  let supervisor: LeaseSupervisorHandle | undefined;
  let previewKey = store.get<{ key: string }>("meta", "preview-key")?.key;
  if (!previewKey) {
    previewKey = randomBytes(32).toString("hex");
    store.put("meta", "preview-key", { key: previewKey });
  }
  const previewToken = (id: string, p: number) =>
    createHmac("sha256", previewKey).update(`${id}:${p}`).digest("base64url");
  const previewUrl = (id: string, p: number) => {
    const base = publicUrl
      ? new URL(publicUrl)
      : new URL(`http://localhost:${boundPort}`);
    base.hostname = `${id}-${p}.${previewHost}`;
    base.pathname = "/";
    base.searchParams.set("sbox_token", previewToken(id, p));
    return base.toString();
  };
  let network: MediatedNetwork | undefined;
  let forwardIdentity: ProxyIdentity | undefined;
  if (backend instanceof HypemanBackend) {
    try {
      let authority = store.get<NetworkAuthority>("meta", "network-authority");
      if (!authority) {
        authority = await createNetworkAuthority();
        store.put("meta", "network-authority", authority);
      }
      let signingKeys = store.get<ProxyIdentityKeys>("meta", "proxy-identity");
      if (!signingKeys) {
        signingKeys = createProxyIdentity();
        store.put("meta", "proxy-identity", signingKeys);
      }
      forwardIdentity = new ProxyIdentity(signingKeys);
      network = new MediatedNetwork({ authority, forwardIdentity });
    } catch (error) {
      if (!options.store) store.close();
      release();
      throw error;
    }
  }
  const service = new SandboxService(backend, store, {
    ...options,
    defaultImage: options.defaultImage ?? process.env.SBOX_IMAGE,
    previewUrl,
    leaseDataDir: supervise ? dataDir : undefined,
    network,
  });
  try {
    await service.initialize();
  } catch (e) {
    await service.close();
    release();
    if (!options.store) store.close();
    throw e;
  }
  const tickets = new Map<string, Ticket>();
  const publicHost = publicOrigin?.hostname;
  const authorized = (req: Request) =>
    !token || equal(req.headers.get("authorization") ?? "", `Bearer ${token}`);
  const failure = (e: unknown, requestId: string) => {
    const error =
      e instanceof SboxError
        ? e
        : new SboxError("INTERNAL_ERROR", errorMessage(e), 500);
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        requestId,
      },
      error.status,
    );
  };
  const issueTerminal = (ref: string, p: Record<string, unknown>) => {
    const s = service.get(ref);
    service.assertSession(s, p.sessionId as string | undefined);
    const opts = {
      cmd: typeof p.cmd === "string" ? p.cmd : "bash",
      args: Array.isArray(p.args) ? (p.args as string[]) : ["-l"],
      cwd: p.cwd as string | undefined,
      env: p.env as Record<string, string> | undefined,
      user: p.user as string | undefined,
      sudo: p.sudo as boolean | undefined,
    };
    v.command(opts);
    const cols = Number(p.cols ?? 80),
      rows = Number(p.rows ?? 24);
    v.integer(cols, "cols", 1, 1000);
    v.integer(rows, "rows", 1, 1000);
    for (const [key, ticket] of tickets)
      if (ticket.expires < Date.now()) tickets.delete(key);
    invariant(
      tickets.size < 1000,
      "CAPACITY_EXCEEDED",
      "Too many outstanding terminal tickets",
      429,
    );
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, {
      sandboxId: s.sandboxId,
      options: opts,
      expires: Date.now() + 60_000,
      cols,
      rows,
      sessionId: p.sessionId as string | undefined,
    });
    const base = new URL(
      publicUrl ??
        `http://${hostname === "::1" ? "[::1]" : hostname}:${boundPort}`,
    );
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `/v1/terminals/${ticket}`;
    return { url: base.toString(), token: ticket };
  };
  async function rpc(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case "sandbox.create":
        return (await service.create(p as CreateOptions)).sandbox;
      case "sandbox.getOrCreate":
        return service.create(p as CreateOptions, true);
      case "sandbox.get":
        return p.resume ? service.resume(p.id) : service.get(p.id);
      case "sandbox.list":
        return service.list(p);
      case "sandbox.resume":
        return service.resume(p.id);
      case "sandbox.stop":
        return service.stop(p.id, p.sessionId);
      case "sandbox.delete":
        await service.delete(p.id, p.deleteOrphanSnapshots);
        return null;
      case "sandbox.update": {
        const { id, sessionId, ...patch } = p;
        return service.update(id, patch, sessionId);
      }
      case "sandbox.extendTimeout":
        return service.extendTimeout(p.id, p.duration, p.sessionId);
      case "sandbox.snapshot":
        return service.makeSnapshot(p.id, p);
      case "sandbox.fork": {
        const { id, ...opts } = p;
        v.create(opts);
        return service.fork(id, opts);
      }
      case "sandbox.sessions":
        return service.page(
          store
            .all<SessionRecord>("session")
            .filter((s) => s.sandboxId === service.get(p.id).sandboxId),
          p,
        );
      case "sandbox.snapshots":
        return service.page(
          store
            .all<SnapshotRecord>("snapshot")
            .filter((s) => s.sandboxId === service.get(p.id).sandboxId),
          p,
        );
      case "sandbox.openInteractive":
        return issueTerminal(p.id, p);
      case "command.run": {
        const { id, ...opts } = p;
        return service.run(id, opts as ExecOptions);
      }
      case "command.get":
        return service.command(p.id);
      case "command.wait":
        return service.wait(p.id);
      case "command.poll":
        return service.poll(p.id, p.after, p.limit);
      case "command.list":
        return service.page(
          store
            .all<CommandRecord>("command")
            .filter((c) => c.sandboxId === service.get(p.id).sandboxId),
          p,
        );
      case "command.kill":
        return service.kill(p.id, p.signal);
      case "command.stdin":
        await service.stdin(p.id, p.data);
        return null;
      case "command.closeStdin":
        await service.stdin(p.id);
        return null;
      case "file.read":
        return service.readFile(p.id, p.path, p.user, p.sessionId);
      case "file.write":
        await service.writeFiles(p.id, p.files, p.user, p.sessionId);
        return null;
      case "file.mkdir":
        return service.fs(
          p.id,
          "mkdir",
          { path: p.path, options: { recursive: true } },
          p.user,
          p.sessionId,
        );
      case "fs":
        return service.fs(p.id, p.op, p.args, p.user, p.sessionId);
      case "snapshot.get":
        return service.snapshot(p.id);
      case "snapshot.list":
        return service.page(store.all<SnapshotRecord>("snapshot"), p);
      case "snapshot.delete":
        await service.deleteSnapshot(p.id);
        return null;
      case "snapshot.tree":
        return snapshotTree(
          store.all<SnapshotRecord>("snapshot"),
          p as {
            snapshotId: string;
            sortOrder?: "asc" | "desc";
            limit?: number;
            cursor?: string;
          },
        );
      case "drive.getOrCreate":
        return service.getOrCreateDrive(p.name, p.sizeBytes);
      case "drive.get":
        return service.drive(p.id);
      case "drive.list":
        return service.page(
          store.all<DriveRecord>("drive").filter((drive) => !drive.immutable),
          p,
        );
      case "drive.delete":
        await service.deleteDrive(p.id);
        return null;
      case "drive.fork":
        return service.forkDrive(p.id, p.name);
      case "proxy.identity":
        invariant(
          forwardIdentity,
          "PROXY_IDENTITY_UNAVAILABLE",
          "The configured backend does not provide signed forwarding identities",
          422,
        );
        return forwardIdentity.public;
      case "capabilities":
        return service.capabilities();
      default:
        throw new SboxError(
          "METHOD_NOT_FOUND",
          `Unknown method: ${method}`,
          404,
        );
    }
  }
  let server: Server<SocketData>;
  try {
    server = Bun.serve<SocketData>({
      hostname,
      port,
      maxRequestBodySize: 1024 ** 4,
      idleTimeout: 0,
      async fetch(request, server) {
        const requestId = randomBytes(8).toString("hex");
        try {
          const url = new URL(request.url);
          if (publicOrigin) url.protocol = publicOrigin.protocol;
          const host = url.hostname;
          const previewMatch = host.match(
            /^((?:sbx-)[a-f0-9]{24})-([0-9]+)\.(.+)$/,
          );
          if (previewMatch && previewMatch[3] === previewHost) {
            const sandboxId = previewMatch[1]!,
              port = Number(previewMatch[2]);
            service.get(sandboxId);
            const previewOrigin = request.headers.get("origin");
            invariant(
              !previewOrigin || previewOrigin === url.origin,
              "INVALID_ORIGIN",
              "Cross-origin preview requests are not allowed",
              403,
            );
            const expected = previewToken(sandboxId, port),
              query = url.searchParams.get("sbox_token");
            if (query && equal(query, expected)) {
              url.searchParams.delete("sbox_token");
              return new Response(null, {
                status: 303,
                headers: {
                  location: url.toString(),
                  "set-cookie": `sbox_preview=${expected}; HttpOnly; SameSite=Lax; Path=/${url.protocol === "https:" ? "; Secure" : ""}`,
                  "referrer-policy": "no-referrer",
                  "cache-control": "no-store",
                },
              });
            }
            const cookie = request.headers
              .get("cookie")
              ?.split(";")
              .map((x) => x.trim())
              .find((x) => x.startsWith("sbox_preview="))
              ?.slice("sbox_preview=".length);
            invariant(
              (cookie && equal(cookie, expected)) ||
                (token && authorized(request)),
              "UNAUTHORIZED",
              "Open the preview URL returned by domain() to authorize this preview",
              401,
            );
            if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
              const prepared = await openPreviewSocket(
                service,
                sandboxId,
                port,
                request,
                !!token && authorized(request),
                url,
              );
              if (
                server.upgrade(request, {
                  headers: prepared.protocol
                    ? { "sec-websocket-protocol": prepared.protocol }
                    : undefined,
                  data: {
                    kind: "preview",
                    prepared,
                    execution: prepared.execution,
                    started: true,
                    pending: [],
                    pendingBytes: 0,
                    writeChain: Promise.resolve(),
                    request,
                    sandboxId,
                    port,
                  },
                })
              )
                return;
              await prepared.execution.kill("SIGKILL").catch(() => {});
              throw new SboxError(
                "UPGRADE_FAILED",
                "WebSocket upgrade failed",
                400,
              );
            }
            return await preview(
              service,
              request,
              sandboxId,
              port,
              !!token && authorized(request),
              url,
            );
          }
          invariant(
            [hostname, "localhost", "127.0.0.1", "[::1]", publicHost].includes(
              host,
            ),
            "INVALID_HOST",
            "Unrecognized API hostname",
            403,
          );
          const origin = request.headers.get("origin");
          invariant(
            !origin || origin === url.origin,
            "INVALID_ORIGIN",
            "Cross-origin API requests are not allowed",
            403,
          );
          if (url.pathname === "/health" && request.method === "GET")
            return json({ ok: true, version: "0.1.0" });
          if (url.pathname.startsWith("/v1/terminals/")) {
            const key = url.pathname.split("/").at(-1)!,
              ticket = tickets.get(key);
            invariant(
              ticket && ticket.expires > Date.now(),
              "INVALID_TICKET",
              "Terminal ticket is invalid or expired",
              401,
            );
            if (
              server.upgrade(request, {
                data: {
                  kind: "terminal",
                  ticket,
                  started: false,
                  pending: [],
                  pendingBytes: 0,
                  writeChain: Promise.resolve(),
                },
              })
            ) {
              tickets.delete(key);
              return;
            }
            throw new SboxError(
              "UPGRADE_REQUIRED",
              "A WebSocket connection is required",
              426,
            );
          }
          invariant(
            authorized(request),
            "UNAUTHORIZED",
            "A valid bearer token is required",
            401,
          );
          if (
            url.pathname === "/v1/proxy-identity" &&
            request.method === "GET"
          ) {
            invariant(
              forwardIdentity,
              "PROXY_IDENTITY_UNAVAILABLE",
              "The configured backend does not provide signed forwarding identities",
              422,
            );
            return json(forwardIdentity.public);
          }
          if (url.pathname === "/v1/capabilities" && request.method === "GET")
            return json(await service.capabilities());
          const fileMatch = url.pathname.match(
            /^\/v1\/sandboxes\/([^/]+)\/files$/,
          );
          if (fileMatch && request.method === "GET") {
            return await service.readFileStream(
              decodeURIComponent(fileMatch[1]!),
              url.searchParams.get("path") ?? "",
              url.searchParams.get("user") ?? undefined,
              url.searchParams.get("sessionId") ?? undefined,
              request.signal,
            );
          }
          if (fileMatch && request.method === "PUT") {
            invariant(
              request.headers.get("content-type")?.split(";")[0] ===
                "application/octet-stream",
              "CONTENT_TYPE_REQUIRED",
              "Use application/octet-stream for file uploads",
              415,
            );
            const mode = url.searchParams.get("mode");
            await service.writeFileStream(
              decodeURIComponent(fileMatch[1]!),
              url.searchParams.get("path") ?? "",
              request,
              url.searchParams.get("user") ?? undefined,
              url.searchParams.get("sessionId") ?? undefined,
              mode === null ? undefined : Number(mode),
            );
            return new Response(null, {
              status: 204,
              headers: { "cache-control": "no-store" },
            });
          }
          const logMatch = url.pathname.match(
            /^\/v1\/commands\/([^/]+)\/logs$/,
          );
          if (logMatch && request.method === "GET") {
            const command = service.command(decodeURIComponent(logMatch[1]!)),
              after = Number(url.searchParams.get("after") ?? 0);
            v.integer(after, "after", 0, Number.MAX_SAFE_INTEGER);
            service.poll(command.commandId, after, 1);
            const abort = new AbortController();
            request.signal.addEventListener("abort", () => abort.abort(), {
              once: true,
            });
            const iterator = service.logs(
              command.commandId,
              after,
              abort.signal,
            );
            const encoder = new TextEncoder();
            return new Response(
              new ReadableStream({
                async pull(controller) {
                  try {
                    const next = await iterator.next();
                    if (next.done) controller.close();
                    else
                      controller.enqueue(
                        encoder.encode(JSON.stringify(next.value) + "\n"),
                      );
                  } catch (e) {
                    const error =
                      e instanceof SboxError
                        ? e
                        : new SboxError(
                            "LOG_STREAM_ERROR",
                            errorMessage(e),
                            502,
                          );
                    controller.enqueue(
                      encoder.encode(
                        JSON.stringify({
                          type: "error",
                          error: {
                            code: error.code,
                            message: error.message,
                            status: error.status,
                            details: error.details,
                          },
                        }) + "\n",
                      ),
                    );
                    controller.close();
                  }
                },
                async cancel() {
                  abort.abort();
                  await iterator.return(undefined);
                },
              }),
              {
                headers: {
                  "content-type": "application/x-ndjson",
                  "cache-control": "no-store",
                  "x-accel-buffering": "no",
                },
              },
            );
          }
          if (url.pathname === "/v1/rpc" && request.method === "POST") {
            invariant(
              request.headers.get("content-type")?.split(";")[0] ===
                "application/json",
              "CONTENT_TYPE_REQUIRED",
              "Use application/json",
              415,
            );
            let body: unknown;
            try {
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              if (request.body) {
                const reader = request.body.getReader();
                try {
                  for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    bytes += next.value.byteLength;
                    invariant(
                      bytes <= 24 * 1024 * 1024,
                      "PAYLOAD_TOO_LARGE",
                      "RPC request exceeds 24 MiB",
                      413,
                    );
                    chunks.push(next.value);
                  }
                } finally {
                  await reader.cancel().catch(() => {});
                  reader.releaseLock();
                }
              }
              body = JSON.parse(Buffer.concat(chunks).toString());
            } catch (error) {
              if (error instanceof SboxError) throw error;
              throw new SboxError(
                "INVALID_JSON",
                "Request body is not valid JSON",
              );
            }
            v.object(body);
            v.string(body.method, "method", 100);
            v.object(body.params ?? {});
            return json({
              result:
                (await rpc(
                  body.method,
                  (body.params ?? {}) as Record<string, any>,
                )) ?? null,
              requestId,
            });
          }
          throw new SboxError("NOT_FOUND", "Endpoint not found", 404);
        } catch (e) {
          return failure(e, requestId);
        }
      },
      websocket: {
        maxPayloadLength: 2 * 1024 * 1024,
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 0,
        open(ws) {
          if (ws.data.kind === "preview") void startPreview(ws);
        },
        message(ws, message) {
          const size =
            typeof message === "string"
              ? Buffer.byteLength(message)
              : message.byteLength;
          ws.data.queuedBytes = (ws.data.queuedBytes ?? 0) + size;
          if (ws.data.queuedBytes > 2 * 1024 * 1024) {
            ws.close(1009, "Input queue exceeded 2 MiB");
            return;
          }
          ws.data.writeChain = ws.data.writeChain
            .then(async () => {
              if (ws.data.kind === "preview") {
                const data =
                  typeof message === "string" ? message : Buffer.from(message);
                const frame =
                  JSON.stringify({
                    type: "message",
                    binary: typeof data !== "string",
                    data: Buffer.from(data).toString("base64"),
                  }) + "\n";
                if (!ws.data.started) {
                  ws.data.pendingBytes += Buffer.byteLength(frame);
                  invariant(
                    ws.data.pendingBytes <= 2 * 1024 * 1024,
                    "INPUT_LIMIT",
                    "Pending WebSocket input exceeded 2 MiB",
                  );
                  ws.data.pending.push(frame);
                } else await ws.data.execution!.write(Buffer.from(frame));
                return;
              }
              if (typeof message === "string") {
                const input = JSON.parse(message);
                v.object(input);
                if (input.type === "start") {
                  invariant(
                    !ws.data.started,
                    "ALREADY_STARTED",
                    "Terminal has already started",
                  );
                  ws.data.started = true;
                  await startTerminal(ws, input);
                  return;
                }
                if (input.type === "resize" || input.resize) {
                  const size = input.resize ?? input;
                  v.object(size);
                  v.integer(size.cols, "cols", 1, 1000);
                  v.integer(size.rows, "rows", 1, 1000);
                  await ws.data.execution?.resize(size.cols, size.rows);
                  return;
                }
                if (input.type === "signal") {
                  v.string(input.signal, "signal");
                  invariant(
                    ["SIGINT", "SIGTERM", "SIGKILL"].includes(input.signal),
                    "INVALID_ARGUMENT",
                    "Unsupported terminal signal",
                  );
                  await ws.data.execution?.kill(input.signal);
                  return;
                }
                throw new SboxError(
                  "INVALID_FRAME",
                  "Invalid terminal control frame",
                );
              }
              invariant(
                ws.data.execution,
                "NOT_STARTED",
                "Send a start frame before terminal input",
              );
              await ws.data.execution.write(Buffer.from(message));
            })
            .catch((e) => {
              ws.send(
                JSON.stringify({ type: "error", message: errorMessage(e) }),
              );
              ws.close(1011, "Terminal transport error");
            })
            .finally(() => {
              ws.data.queuedBytes = Math.max(
                0,
                (ws.data.queuedBytes ?? 0) - size,
              );
            });
        },
        close(ws) {
          void ws.data.execution?.kill("SIGKILL").catch(() => {});
        },
      },
    });
  } catch (error) {
    await service.close();
    if (!options.store) store.close();
    release();
    throw error;
  }
  boundPort = server.port!;
  async function startTerminal(
    ws: ServerWebSocket<SocketData>,
    input: Record<string, unknown>,
  ) {
    const ticket = ws.data.ticket!,
      opts = { ...ticket.options };
    if (typeof input.command === "string") opts.cmd = input.command;
    if (Array.isArray(input.args)) opts.args = input.args as string[];
    if (typeof input.cwd === "string") opts.cwd = input.cwd;
    if (input.env) {
      invariant(
        Array.isArray(input.env),
        "INVALID_ARGUMENT",
        "Terminal env must be an array of KEY=value strings",
      );
      opts.env = { ...opts.env };
      for (const pair of input.env) {
        v.string(pair, "env");
        const split = pair.indexOf("=");
        invariant(
          split > 0,
          "INVALID_ARGUMENT",
          "Invalid terminal environment",
        );
        opts.env[pair.slice(0, split)] = pair.slice(split + 1);
      }
    }
    v.command(opts);
    const cols = Number(input.cols ?? ticket.cols),
      rows = Number(input.rows ?? ticket.rows);
    v.integer(cols, "cols", 1, 1000);
    v.integer(rows, "rows", 1, 1000);
    const execution = await service.openExecution(
      ticket.sandboxId,
      {
        cmd: opts.cmd,
        args: opts.args ?? [],
        cwd: opts.cwd ?? "/vercel/sandbox",
        env: { ...opts.env },
        user: opts.sudo ? "root" : (opts.user ?? "sandbox"),
        stdin: true,
        tty: true,
        cols,
        rows,
      },
      ticket.sessionId,
    );
    ws.data.execution = execution;
    const result = execution.exited.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (ws.readyState !== 1) {
      await execution.kill("SIGKILL").catch(() => {});
      return;
    }
    void (async () => {
      try {
        for await (const event of execution.output) {
          if (ws.send(event.data) === 0)
            throw Error("Terminal output connection closed");
        }
        const outcome = await result;
        if ("error" in outcome) throw outcome.error;
        ws.send(JSON.stringify({ type: "exit", code: outcome.value.exitCode }));
        ws.close(1000);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: errorMessage(e) }));
        ws.close(1011);
      }
    })();
  }
  async function startPreview(ws: ServerWebSocket<SocketData>) {
    const prepared = ws.data.prepared!;
    const { execution, iterator, decoder } = prepared;
    let pending = prepared.pending;
    try {
      if (ws.readyState !== 1) return;
      for (;;) {
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
          const frame = JSON.parse(pending.slice(0, index));
          pending = pending.slice(index + 1);
          if (frame.type === "message") {
            const bytes = Buffer.from(frame.data, "base64");
            if (ws.send(frame.binary ? bytes : bytes.toString()) === 0)
              throw Error("Preview connection closed");
          } else if (frame.type === "close") {
            ws.close(
              [1005, 1006, 1015].includes(frame.code) ? 1000 : frame.code,
              frame.reason,
            );
            return;
          } else if (frame.type === "error")
            throw Error("Guest WebSocket connection failed");
        }
        const event = await iterator.next();
        if (event.done) break;
        if (event.value.stream !== "stdout") continue;
        pending += decoder.decode(event.value.data, { stream: true });
        invariant(
          pending.length < 4 * 1024 * 1024,
          "FRAME_LIMIT",
          "Preview WebSocket frame is too large",
        );
      }
      ws.close(1000);
    } catch {
      ws.close(1011, "Guest WebSocket connection failed");
    } finally {
      await execution.kill("SIGKILL").catch(() => {});
    }
  }
  const originalStop = server.stop.bind(server);
  let stopped = false;
  server.stop = async (force = true) => {
    if (stopped) return;
    stopped = true;
    await originalStop(force);
    await service.close();
    if (!options.store) store.close();
    release();
    supervisor?.release();
  };
  if (supervise) {
    try {
      supervisor = await spawnLeaseSupervisor(
        { dbPath: join(dataDir, "sbox.sqlite"), dataDir, ...connection! },
        options.leaseWorker,
      );
    } catch (error) {
      await server.stop(true);
      throw error;
    }
  }
  return server;
}
