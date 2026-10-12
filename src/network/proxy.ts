import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import {
  createServer as createSecureServer,
  request as httpsRequest,
} from "node:https";
import {
  connect,
  createServer as createNetServer,
  isIP,
  BlockList,
  type Socket,
  type Server as NetServer,
} from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { NetworkDNS, parseSocksDatagram } from "./dns.ts";
import { pinnedLookup } from "./lookup.ts";
import type { ProxyIdentity } from "./identity.ts";
import { forwardUpgrade } from "./upgrade.ts";
import type { LookupAddress } from "node:dns";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TLSSocket, createSecureContext } from "node:tls";
import { SboxError } from "../errors.ts";
import type { CredentialPolicies } from "../types.ts";
import {
  normalizeCredentials,
  nativeCredentialSecrets,
} from "../hypeman/credentials.ts";
import { NetworkCertificates } from "./certificates.ts";
import {
  CompiledPolicy,
  domainMatches,
  normalizeHost,
  type NetworkPolicy,
  type NetworkPolicyRule,
} from "./policy.ts";

export interface NetworkConfiguration {
  policy: NetworkPolicy;
  credentials?: CredentialPolicies;
  credentialSecrets?: Record<string, string>;
  sandboxId?: string;
  sandboxName?: string;
}
export interface PolicyProxyOptions {
  certificates: NetworkCertificates;
  lookup?: (host: string) => Promise<LookupAddress[]>;
  /** Additional explicitly trusted upstream CA bundle, for private HTTPS services. */
  upstreamCA?: string;
  forwardIdentity?: ProxyIdentity;
}
const forbidden = (message = "Network policy denied this request") =>
  new SboxError("NETWORK_DENIED", message, 403);
const internal = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  internal.addSubnet(ip, prefix, isIP(ip) === 4 ? "ipv4" : "ipv6");
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function cleanHeaders(source: Headers): Headers {
  const result = new Headers(source);
  for (const token of (result.get("connection") ?? "").split(","))
    if (token.trim()) result.delete(token.trim());
  for (const key of hop) result.delete(key);
  for (const key of [...result.keys()])
    if (
      key.startsWith("vercel-forwarded-") ||
      key === "vercel-sandbox-oidc-token" ||
      key.startsWith("x-sbox-")
    )
      result.delete(key);
  result.delete("host");
  return result;
}
function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
  return headers;
}
function sendError(response: ServerResponse, error: unknown) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const status = error instanceof SboxError ? error.status : 502;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(
    status === 403
      ? "Network policy denied this request"
      : status === 400
        ? "Invalid proxy request"
        : "Network proxy could not complete the request",
  );
}
export class PolicyProxy {
  private configuration: NetworkConfiguration;
  private policy: CompiledPolicy;
  private readonly sockets = new Set<Socket>();
  private readonly servers = new Set<Server | NetServer>();
  private readonly requests = new Set<ReturnType<typeof httpRequest>>();
  private readonly certificates: NetworkCertificates;
  private readonly lookup: (host: string) => Promise<LookupAddress[]>;
  private readonly upstreamCA?: string;
  private readonly forwardIdentity?: ProxyIdentity;
  private server?: Server;
  private proxyPort?: number;
  private readonly listenerTokens = new Map<number, Buffer>();
  private epoch = 0;
  private epochAbort = new AbortController();
  private closed = false;
  private readonly dns: NetworkDNS;
  private readonly datagrams = new Map<
    string,
    { socket: DatagramSocket; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly datagramTasks = new Map<string, Promise<void>>();
  private readonly cancelledDatagrams = new Set<string>();
  constructor(
    configuration: NetworkConfiguration,
    options: PolicyProxyOptions,
  ) {
    this.configuration = this.validate(configuration);
    this.policy = new CompiledPolicy(this.configuration.policy);
    this.certificates = options.certificates;
    this.upstreamCA = options.upstreamCA;
    this.forwardIdentity = options.forwardIdentity;
    this.lookup =
      options.lookup ??
      ((host) => dnsLookup(host, { all: true, verbatim: true }));
    this.dns = new NetworkDNS(async (host) => {
      if (this.configuration.policy === "deny-all") throw forbidden();
      if (!this.policy.hasDomain(host)) {
        if (
          typeof this.configuration.policy === "string" ||
          !this.configuration.policy.subnets?.allow?.length
        )
          throw forbidden();
        await this.resolve(new URL("https://" + host));
      }
    });
  }
  private validate(configuration: NetworkConfiguration): NetworkConfiguration {
    const credentials = normalizeCredentials(configuration.credentials);
    nativeCredentialSecrets(credentials, configuration.credentialSecrets, true);
    new CompiledPolicy(configuration.policy);
    return { ...structuredClone(configuration), credentials };
  }
  update(configuration: NetworkConfiguration): void {
    const next = this.validate(configuration),
      policy = new CompiledPolicy(next.policy);
    this.configuration = next;
    this.policy = policy;
    this.epoch++;
    this.epochAbort.abort();
    this.epochAbort = new AbortController();
    for (const request of this.requests) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    for (const entry of this.datagrams.values()) {
      clearTimeout(entry.timer);
      entry.socket.close();
    }
    this.datagrams.clear();
  }
  answerDNS(packet: Uint8Array): Promise<Buffer> {
    return this.dns.answer(packet);
  }
  private requiresInspection(host: string): boolean {
    const policy = this.configuration.policy;
    return (
      (typeof policy === "object" &&
        !Array.isArray(policy.allow) &&
        Object.entries(policy.allow ?? {}).some(
          ([domain, rules]) => domainMatches(domain, host) && rules.length > 0,
        )) ||
      Object.values(this.configuration.credentials ?? {}).some((policy) =>
        policy.inject.some((rule) =>
          rule.hosts.some((pattern) => domainMatches(pattern, host)),
        ),
      )
    );
  }
  private hasInspectionRules(): boolean {
    const policy = this.configuration.policy;
    return (
      Object.keys(this.configuration.credentials ?? {}).length > 0 ||
      (typeof policy === "object" &&
        !Array.isArray(policy.allow) &&
        Object.values(policy.allow ?? {}).some((rules) => rules.length > 0))
    );
  }
  private explicitlyNames(host: string): boolean {
    const policy = this.configuration.policy;
    if (typeof policy === "string") return false;
    return (
      Array.isArray(policy.allow)
        ? policy.allow
        : Object.keys(policy.allow ?? {})
    ).some((pattern) => pattern !== "*" && domainMatches(pattern, host));
  }
  async connectTCP(destination: string, port: number): Promise<Socket> {
    const host = normalizeHost(this.dns.hostname(destination));
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      (!isIP(host) && !/^[a-z0-9.-]{1,253}$/.test(host))
    )
      throw forbidden();
    const target = new URL(
      `${port === 80 ? "http" : "https"}://${isIP(host) === 6 ? "[" + host + "]" : host}:${port}`,
    );
    const epoch = this.epoch;
    const required = this.requiresInspection(host);
    const inspect =
      required ||
      this.hasInspectionRules() ||
      (typeof this.configuration.policy === "object" &&
        [80, 443].includes(port));
    if (!inspect) {
      const addresses = await this.resolveAddresses(target);
      if (epoch !== this.epoch || this.closed) throw forbidden();
      return await this.openSocket(host, port, addresses);
    }
    if (!required && this.hasInspectionRules()) {
      const addresses = await this.resolveAddresses(target);
      if (epoch !== this.epoch || this.closed) throw forbidden();
      // CIDRs are an explicit domain-policy bypass. Every chosen address must qualify.
      if (
        addresses.every(({ address }) =>
          this.policy.explicitlyAllowsAddress(address),
        )
      )
        return await this.openSocket(host, port, addresses);
      // A wildcard cannot authorize an IP alias around a named L7 policy.
      if (isIP(host)) throw forbidden();
      return await this.sniffedSocket(
        host,
        port,
        epoch,
        this.explicitlyNames(host) ? addresses : undefined,
      );
    }
    if (!this.policy.hasDomain(host)) await this.resolve(target);
    return await this.sniffedSocket(host, port, epoch);
  }
  private async sniffedSocket(
    host: string,
    port: number,
    epoch: number,
    opaqueAddresses?: LookupAddress[],
  ): Promise<Socket> {
    const listener = createNetServer((socket) => {
      this.sockets.add(socket);
      socket.setTimeout(15_000, () => socket.destroy());
      socket.on("error", () => {});
      socket.once("close", () => this.sockets.delete(socket));
      let buffered = Buffer.alloc(0),
        chosen = false,
        candidate: Socket | undefined;
      const bind = (upstream: Socket, initial?: Buffer) => {
        if (socket.destroyed || epoch !== this.epoch || this.closed) {
          upstream.destroy();
          return;
        }
        socket.setTimeout(120_000);
        socket.once("close", () => upstream.destroy());
        upstream.once("close", () => socket.destroy());
        upstream.on("error", () => socket.destroy());
        if (buffered.length) upstream.write(buffered);
        if (initial?.length) socket.write(initial);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
        upstream.resume();
      };
      const choose = (protocol?: string, initial?: Buffer) => {
        if (chosen) return;
        chosen = true;
        socket.off("data", inspect);
        socket.pause();
        if (epoch !== this.epoch || this.closed) {
          candidate?.destroy();
          socket.destroy();
          return;
        }
        if (!protocol) {
          if (candidate) {
            bind(candidate, initial);
            return;
          }
          if (!opaqueAddresses) {
            socket.destroy();
            return;
          }
          void this.openSocket(host, port, opaqueAddresses)
            .then((upstream) => bind(upstream))
            .catch(() => socket.destroy());
          return;
        }
        candidate?.destroy();
        const target = new URL(
          `${protocol}://${isIP(host) === 6 ? "[" + host + "]" : host}:${port}`,
        );
        void this.inspectionSocket(target, epoch)
          .then((upstream) => {
            if (socket.destroyed || epoch !== this.epoch || this.closed) {
              upstream.destroy();
              return;
            }
            bind(upstream);
          })
          .catch(() => socket.destroy());
      };
      const inspect = (first: Buffer | string) => {
        buffered = Buffer.concat([buffered, Buffer.from(first)]);
        if (buffered[0] === 0x16) {
          choose("https");
          return;
        }
        const end = buffered.indexOf("\r\n");
        if (end >= 0) {
          choose(
            /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ [^\r\n ]+ HTTP\/[12]\.[0-9]$/.test(
              buffered.subarray(0, end).toString("ascii"),
            )
              ? "http"
              : undefined,
          );
          return;
        }
        if (
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(
            buffered.subarray(0, 1).toString("ascii"),
          )
        ) {
          choose();
          return;
        }
        if (buffered.length > 8192) socket.destroy();
      };
      socket.on("data", inspect);
      // Explicit named opaque protocols may begin with a server greeting (SSH/SMTP).
      if (opaqueAddresses)
        void this.openSocket(host, port, opaqueAddresses)
          .then((upstream) => {
            if (chosen || socket.destroyed) {
              upstream.destroy();
              return;
            }
            candidate = upstream;
            upstream.once("data", (data) => {
              upstream.pause();
              if (!chosen) choose(undefined, Buffer.from(data));
            });
            socket.once("close", () => upstream.destroy());
          })
          .catch(() => {
            if (!chosen) socket.destroy();
          });
    });
    listener.maxConnections = 1;
    this.servers.add(listener);
    const listenerPort = await this.listenAuthenticated(listener);
    try {
      if (epoch !== this.epoch || this.closed) throw forbidden();
      const socket = await this.openSocket(
        "127.0.0.1",
        listenerPort,
        undefined,
        true,
      );
      socket.once("close", () => {
        listener.close();
        this.servers.delete(listener);
      });
      return socket;
    } catch (error) {
      listener.close();
      this.servers.delete(listener);
      throw error;
    }
  }
  private async inspectionSocket(target: URL, epoch: number): Promise<Socket> {
    const host = normalizeHost(target.hostname);
    const material =
      target.protocol === "http:"
        ? undefined
        : await this.certificates.issue(host);
    const server =
      target.protocol === "http:"
        ? createServer((request, response) => {
            void this.handle(request, response, target).catch((error) =>
              sendError(response, error),
            );
          })
        : createSecureServer(
            {
              ...material!,
              ALPNProtocols: ["http/1.1"],
            },
            (request, response) => {
              void this.handle(request, response, target).catch((error) =>
                sendError(response, error),
              );
            },
          );
    if (epoch !== this.epoch || this.closed) throw forbidden();
    this.track(server);
    server.on("upgrade", (request, socket, head) =>
      this.upgrade(request, socket as Socket, head, target),
    );
    const listenerPort = await this.listenAuthenticated(server, material);
    try {
      if (epoch !== this.epoch || this.closed) throw forbidden();
      const socket = await this.openSocket(
        "127.0.0.1",
        listenerPort,
        undefined,
        true,
      );
      socket.once("close", () => {
        server.close();
        this.servers.delete(server);
      });
      return socket;
    } catch (error) {
      server.close();
      this.servers.delete(server);
      throw error;
    }
  }
  private async openSocket(
    host: string,
    port: number,
    addresses?: LookupAddress[],
    authenticated = false,
  ): Promise<Socket> {
    const socket = connect({
      host,
      port,
      autoSelectFamily: !!addresses,
      ...(addresses
        ? {
            lookup: pinnedLookup(addresses),
            autoSelectFamilyAttemptTimeout: 250,
          }
        : {}),
    });
    this.sockets.add(socket);
    socket.setTimeout(120_000, () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    if (authenticated) {
      const token = this.listenerTokens.get(port);
      if (!token) {
        socket.destroy();
        throw forbidden();
      }
      socket.write(token);
    }
    return socket;
  }
  /** Only the authenticated exec bridge receives a socket with this host-only preface. */
  async connectProxy(): Promise<Socket> {
    if (this.proxyPort === undefined || this.closed) throw forbidden();
    return await this.openSocket("127.0.0.1", this.proxyPort, undefined, true);
  }
  private async listenAuthenticated(
    server: Server | NetServer,
    material?: { cert: string; key: string },
  ): Promise<number> {
    const token = randomBytes(32),
      waiting = new Set<Socket>();
    const secureContext = material ? createSecureContext(material) : undefined;
    const gate = createNetServer((socket) => {
      if (waiting.size >= 128) {
        socket.destroy();
        return;
      }
      waiting.add(socket);
      this.sockets.add(socket);
      socket.on("error", () => {});
      socket.setTimeout(1000, () => socket.destroy());
      socket.once("close", () => {
        waiting.delete(socket);
        this.sockets.delete(socket);
      });
      let input = Buffer.alloc(0);
      const authenticate = (chunk: Buffer | string) => {
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (input.length < token.length) return;
        socket.off("data", authenticate);
        waiting.delete(socket);
        if (!timingSafeEqual(input.subarray(0, token.length), token)) {
          socket.destroy();
          return;
        }
        socket.pause();
        socket.setTimeout(0);
        if (input.length > token.length)
          socket.unshift(input.subarray(token.length));
        if (secureContext) {
          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext,
            ALPNProtocols: ["http/1.1"],
          });
          secure.on("error", () => socket.destroy());
          server.emit("connection", secure);
          secure.resume();
        } else {
          server.emit("connection", socket);
          socket.resume();
        }
      };
      socket.on("data", authenticate);
    });
    this.servers.add(gate);
    await new Promise<void>((resolve, reject) => {
      gate.once("error", reject);
      gate.listen(0, "127.0.0.1", () => {
        gate.off("error", reject);
        resolve();
      });
    });
    const port = (gate.address() as { port: number }).port;
    this.listenerTokens.set(port, token);
    server.once("close", () => {
      gate.close();
      this.servers.delete(gate);
      this.listenerTokens.delete(port);
    });
    return port;
  }
  async sendDatagram(
    id: string,
    packet: Uint8Array,
    reply: (bytes: Buffer) => void,
  ): Promise<void> {
    if (this.datagramTasks.size >= 128 && !this.datagramTasks.has(id))
      throw forbidden("Too many datagram associations");
    const epoch = this.epoch;
    const task = (this.datagramTasks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          this.closed ||
          epoch !== this.epoch ||
          this.cancelledDatagrams.has(id)
        )
          throw forbidden();
        await this.relayDatagram(id, packet, reply);
      });
    this.datagramTasks.set(id, task);
    try {
      await task;
    } finally {
      if (this.datagramTasks.get(id) === task) {
        this.datagramTasks.delete(id);
        this.cancelledDatagrams.delete(id);
      }
    }
  }
  private async relayDatagram(
    id: string,
    packet: Uint8Array,
    reply: (bytes: Buffer) => void,
  ): Promise<void> {
    const decoded = parseSocksDatagram(packet);
    const host = normalizeHost(this.dns.hostname(decoded.host));
    if (this.requiresInspection(host))
      throw forbidden("UDP cannot bypass HTTP inspection");
    const epoch = this.epoch;
    const target = new URL(
      `http://${isIP(host) === 6 ? "[" + host + "]" : host}:${decoded.port}`,
    );
    const key = id + "|" + host + "|" + decoded.port;
    let entry = this.datagrams.get(key);
    if (!entry) {
      const address = await this.resolve(target);
      if (
        epoch !== this.epoch ||
        this.closed ||
        this.cancelledDatagrams.has(id)
      )
        throw forbidden();
      if (
        this.hasInspectionRules() &&
        !this.policy.explicitlyAllowsAddress(address.address)
      )
        throw forbidden(
          "Datagrams require an explicit CIDR grant when HTTP inspection rules exist",
        );
      if (this.datagrams.size >= 256)
        throw forbidden("Too many datagram destinations");
      const socket = createSocket(address.family === 4 ? "udp4" : "udp6");
      const remove = () => {
        const entry = this.datagrams.get(key);
        if (entry) {
          clearTimeout(entry.timer);
          this.datagrams.delete(key);
          socket.close();
        }
      };
      socket.on("error", remove);
      socket.on("message", (message) => {
        if (epoch === this.epoch && !this.closed)
          reply(Buffer.concat([decoded.header, message]));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(decoded.port, address.address, resolve);
      });
      if (
        epoch !== this.epoch ||
        this.closed ||
        this.cancelledDatagrams.has(id)
      ) {
        socket.close();
        throw forbidden();
      }
      entry = { socket, timer: setTimeout(remove, 30_000) };
      this.datagrams.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry!.socket.close();
      this.datagrams.delete(key);
    }, 30_000);
    entry.socket.send(decoded.data);
  }
  closeDatagrams(id: string): void {
    if (this.datagramTasks.has(id)) this.cancelledDatagrams.add(id);
    for (const [key, entry] of this.datagrams)
      if (key.startsWith(id + "|")) {
        clearTimeout(entry.timer);
        entry.socket.close();
        this.datagrams.delete(key);
      }
  }

  private track(server: Server) {
    this.servers.add(server);
    server.maxHeadersCount = 128;
    server.headersTimeout = 15_000;
    server.requestTimeout = 120_000;
    server.keepAliveTimeout = 5_000;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.setTimeout(120_000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("error", () => {});
  }
  async listen(): Promise<number> {
    if (this.server) throw new Error("Proxy already listening");
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) =>
        sendError(response, error),
      );
    });
    this.server = server;
    this.track(server);
    server.on("connect", (request, socket, head) => {
      void this.tunnel(request, socket as Socket, head).catch(() =>
        socket.destroy(),
      );
    });
    server.on("upgrade", (request, socket, head) =>
      this.upgrade(request, socket as Socket, head),
    );
    this.proxyPort = await this.listenAuthenticated(server);
    return this.proxyPort;
  }
  private async tunnel(request: IncomingMessage, socket: Socket, head: Buffer) {
    const epoch = this.epoch;
    if (this.closed || this.configuration.policy === "deny-all")
      throw forbidden();
    if (
      !request.url ||
      !/^\[[0-9a-f:.]+\]:[0-9]+$|^[A-Za-z0-9.-]+:[0-9]+$/i.test(request.url)
    )
      throw forbidden();
    const target = new URL("https://" + request.url);
    const port = Number(target.port || 443);
    if (port < 1 || port > 65535 || target.username || target.password)
      throw forbidden();
    if (!this.policy.hasDomain(target.hostname)) await this.resolve(target);
    const material = await this.certificates.issue(
      normalizeHost(target.hostname),
    );
    if (epoch !== this.epoch || this.closed || socket.destroyed) return;
    const server = createSecureServer(
      { ...material, ALPNProtocols: ["http/1.1"] },
      (inner, response) => {
        void this.handle(inner, response, target).catch((error) =>
          sendError(response, error),
        );
      },
    );
    this.track(server);
    server.on("upgrade", (request, connection, head) =>
      this.upgrade(request, connection as Socket, head, target),
    );
    const listenerPort = await this.listenAuthenticated(server, material);
    if (epoch !== this.epoch || this.closed || socket.destroyed) {
      server.close();
      this.servers.delete(server);
      return;
    }
    const upstream = await this.openSocket(
      "127.0.0.1",
      listenerPort,
      undefined,
      true,
    );
    this.sockets.add(upstream);
    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
      server.close();
      this.servers.delete(server);
      this.sockets.delete(upstream);
    };
    socket.once("close", cleanup);
    upstream.once("error", cleanup);
    upstream.once("close", cleanup);
    {
      if (socket.destroyed) return cleanup();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    }
  }
  private async resolve(url: URL, forwarded = false): Promise<LookupAddress> {
    return (await this.resolveAddresses(url, forwarded))[0]!;
  }
  private async resolveAddresses(
    url: URL,
    forwarded = false,
  ): Promise<LookupAddress[]> {
    const host = normalizeHost(url.hostname);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await this.lookup(host);
    if (
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some(
        ({ address, family }) =>
          ![4, 6].includes(family) || isIP(address) !== family,
      )
    )
      throw forbidden("Invalid or oversized DNS answer");
    const allowed = addresses.filter(
      ({ address, family }) =>
        !this.policy.deniesAddress(address) &&
        (forwarded || this.policy.addressAllowed(host, address)) &&
        (!internal.check(address, family === 4 ? "ipv4" : "ipv6") ||
          this.policy.explicitlyAllowsAddress(address)),
    );
    if (!allowed.length) throw forbidden();
    // Prefer IPv4 on hosts without working IPv6 while preserving vetted fallback.
    return allowed.sort((left, right) => left.family - right.family);
  }
  private async prepareRequest(request: IncomingMessage, tunnel?: URL) {
    if (this.closed) throw forbidden();
    const epoch = this.epoch;
    let url: URL;
    try {
      if (tunnel) {
        if (!request.url?.startsWith("/") || request.url.startsWith("//"))
          throw new Error("Invalid tunnel path");
        url = new URL(request.url, tunnel);
        if (url.origin !== tunnel.origin)
          throw new Error("Tunnel authority mismatch");
        if (
          normalizeHost(
            new URL("https://" + (request.headers.host ?? "")).hostname,
          ) !== normalizeHost(tunnel.hostname)
        )
          throw new Error("Tunnel host mismatch");
      } else {
        url = new URL(request.url ?? "");
        if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        !url.hostname
      )
        throw new Error("Invalid request URL");
    } catch {
      throw new SboxError(
        "INVALID_PROXY_REQUEST",
        "Invalid proxy request",
        400,
      );
    }
    const headers = cleanHeaders(incomingHeaders(request));
    const decision = this.policy.request({
      url,
      method: request.method ?? "GET",
      headers,
    });
    const rule = decision.rule;
    // Synthetic responses never contact a host. Literal IP deny rules still win.
    if (rule?.response) {
      if (
        isIP(normalizeHost(url.hostname)) &&
        this.policy.deniesAddress(normalizeHost(url.hostname))
      )
        throw forbidden();
      return { url, headers, rule, addresses: [] as LookupAddress[] };
    }
    const original = url;
    const forwarded = rule?.forwardURL !== undefined;
    if (forwarded) {
      url = new URL(rule!.forwardURL!);
      url.pathname = url.pathname.replace(/\/$/, "") + original.pathname;
      url.search = original.search;
      headers.set("vercel-forwarded-host", original.hostname);
      headers.set("vercel-forwarded-scheme", original.protocol.slice(0, -1));
      headers.set(
        "vercel-forwarded-port",
        original.port || (original.protocol === "https:" ? "443" : "80"),
      );
      headers.set("vercel-forwarded-path", original.pathname + original.search);
      if (this.configuration.sandboxId)
        headers.set("x-sbox-sandbox-id", this.configuration.sandboxId);
      if (this.forwardIdentity && this.configuration.sandboxId)
        headers.set(
          "x-sbox-proxy-token",
          this.forwardIdentity.sign({
            sandboxId: this.configuration.sandboxId,
            sandboxName: this.configuration.sandboxName,
            originalUrl: original.toString(),
            targetUrl: url.toString(),
            method: request.method ?? "GET",
          }),
        );
    }
    const addresses = await this.resolveAddresses(url, forwarded);
    if (epoch !== this.epoch || this.closed) throw forbidden();
    for (const transform of rule?.transform ?? [])
      for (const [name, value] of Object.entries(transform.headers ?? {}))
        headers.set(name, value);
    if (url.protocol === "https:")
      for (const policy of Object.values(this.configuration.credentials ?? {}))
        for (const inject of policy.inject)
          if (inject.hosts.some((host) => domainMatches(host, url.hostname)))
            headers.set(
              inject.as.header,
              inject.as.format.replaceAll(
                "${value}",
                this.configuration.credentialSecrets![policy.source.env]!,
              ),
            );
    headers.set("host", url.host);
    return { url, headers, rule, addresses };
  }
  private upgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    tunnel?: URL,
  ): void {
    const signal = this.epochAbort.signal;
    void (async () => {
      const prepared = await this.prepareRequest(request, tunnel);
      if (signal.aborted || socket.destroyed) {
        socket.destroy();
        return;
      }
      const reply = prepared.rule?.response;
      if (reply) {
        const headers = new Headers(reply.headers);
        if (reply.contentType) headers.set("content-type", reply.contentType);
        headers.set("connection", "close");
        headers.set(
          "content-length",
          String(Buffer.byteLength(reply.body ?? "")),
        );
        socket.end(
          `HTTP/1.1 ${reply.statusCode} Policy Response\r\n${[...headers].map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n${reply.body ?? ""}`,
        );
        return;
      }
      // Hop-by-hop headers are reconstructed only for a genuine upgrade request.
      prepared.headers.set("connection", request.headers.connection ?? "");
      prepared.headers.set("upgrade", String(request.headers.upgrade ?? ""));
      await forwardUpgrade(request, socket, head, {
        ...prepared,
        upstreamCA: this.upstreamCA,
        signal,
        onSocket: (upstream) => {
          this.sockets.add(upstream);
          upstream.once("close", () => this.sockets.delete(upstream));
        },
      });
    })().catch((error) => {
      if (socket.destroyed || signal.aborted) {
        socket.destroy();
        return;
      }
      const status = error instanceof SboxError ? error.status : 502;
      socket.end(
        `HTTP/1.1 ${status} Network Proxy Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    tunnel?: URL,
  ) {
    const { url, headers, rule, addresses } = await this.prepareRequest(
      request,
      tunnel,
    );
    if (rule?.response) {
      const reply = rule.response;
      response.writeHead(reply.statusCode, {
        ...reply.headers,
        ...(reply.contentType ? { "content-type": reply.contentType } : {}),
        "content-length": String(Buffer.byteLength(reply.body ?? "")),
      });
      response.end(request.method === "HEAD" ? undefined : reply.body);
      return;
    }
    const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    await new Promise<void>((resolve, reject) => {
      const upstream = makeRequest(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(headers),
          agent: false,
          ...{ autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
          lookup: pinnedLookup(addresses),
          servername: normalizeHost(url.hostname),
          ...(this.upstreamCA ? { ca: this.upstreamCA } : {}),
        },
        (reply) => {
          const outgoing = cleanHeaders(
            new Headers(
              Object.entries(reply.headers).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : Array.isArray(value)
                    ? value.map((item) => [key, item] as [string, string])
                    : [[key, value] as [string, string]],
              ),
            ),
          );
          // Preserve separate Set-Cookie fields rather than combining them.
          const resultHeaders: Record<string, string | string[]> =
            Object.fromEntries(outgoing);
          if (reply.headers["set-cookie"])
            resultHeaders["set-cookie"] = reply.headers["set-cookie"];
          response.writeHead(reply.statusCode ?? 502, resultHeaders);
          reply.pipe(response);
          reply.once("error", reject);
          reply.once("end", resolve);
        },
      );
      this.requests.add(upstream);
      upstream.setTimeout(120_000, () =>
        upstream.destroy(new Error("Upstream timeout")),
      );
      upstream.once("error", reject);
      upstream.once("close", () => this.requests.delete(upstream));
      request.once("aborted", () => upstream.destroy());
      response.once("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.epochAbort.abort();
    for (const request of this.requests) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    for (const entry of this.datagrams.values()) {
      clearTimeout(entry.timer);
      entry.socket.close();
    }
    this.datagrams.clear();
    await Promise.all(
      [...this.servers].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    this.servers.clear();
  }
}
