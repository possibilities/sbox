import type { Socket } from "node:net";
import type { Backend, Execution } from "../backend.ts";
import { SboxError } from "../errors.ts";
import { credentialEnvironment } from "../hypeman/credentials.ts";
import {
  createNetworkAuthority,
  NetworkCertificates,
  type NetworkAuthority,
} from "./certificates.ts";
import { prepareTunnel } from "./transparent.ts";
import { GUEST_NETWORK } from "./guest.ts";
import {
  PolicyProxy,
  type NetworkConfiguration,
  type PolicyProxyOptions,
} from "./proxy.ts";
export {
  createNetworkAuthority,
  NetworkCertificates,
  type NetworkAuthority,
} from "./certificates.ts";
export { validatePolicy, redactPolicy, CompiledPolicy } from "./policy.ts";
export type * from "./policy.ts";
export type { NetworkConfiguration } from "./proxy.ts";

export interface NetworkSession {
  /** Proxy variables and mock aliases; contains no real credentials. */
  readonly env: Record<string, string>;
  environment(env: Record<string, string>): Record<string, string>;
  update(configuration: NetworkConfiguration): void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}
export interface MediatedNetworkOptions {
  authority?: NetworkAuthority;
  lookup?: PolicyProxyOptions["lookup"];
  upstreamCA?: string;
  forwardIdentity?: PolicyProxyOptions["forwardIdentity"];
  transparent?: boolean;
}
/** Every attachment is an independent authenticated exec channel to a NIC-less VM. */
export class MediatedNetwork {
  private readonly authority: Promise<NetworkAuthority>;
  private readonly options: MediatedNetworkOptions;
  constructor(options: MediatedNetworkOptions = {}) {
    this.options = options;
    this.authority = options.authority
      ? Promise.resolve(options.authority)
      : createNetworkAuthority();
  }
  async attach(
    backend: Backend,
    id: string,
    initial: NetworkConfiguration,
  ): Promise<NetworkSession> {
    const authority = await this.authority;
    const proxy = new PolicyProxy(initial, {
      certificates: new NetworkCertificates(authority),
      lookup: this.options.lookup,
      upstreamCA: this.options.upstreamCA,
      forwardIdentity: this.options.forwardIdentity,
    });
    await proxy.listen();
    let execution: Execution;
    try {
      if (this.options.transparent !== false) await prepareTunnel(backend, id);
      execution = await backend.exec(id, {
        cmd: "bun",
        args: ["-e", GUEST_NETWORK],
        cwd: "/",
        env: {},
        user: "root",
        stdin: true,
      });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    const sockets = new Map<string, Socket>();
    const opening = new Set<string>();
    let datagramsPending = 0;
    const downstream = new WeakMap<Socket, { data: Buffer; offset: number }>();
    let configuration = structuredClone(initial),
      stopping = false,
      pending = "",
      queued = 0;
    let sending = Promise.resolve();
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    let closeResolve!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
    const send = (frame: unknown) => {
      const bytes = Buffer.from(JSON.stringify(frame) + "\n");
      queued += bytes.length;
      if (queued > 8 * 1024 * 1024) {
        void shutdown();
        throw new Error("Network transport exceeded its buffer limit");
      }
      sending = sending
        .then(() => execution.write(bytes))
        .finally(() => {
          queued -= bytes.length;
        });
      void sending.catch(() => shutdown());
      return sending;
    };
    const shutdown = async () => {
      if (stopping) return closed;
      stopping = true;
      readyReject(
        new SboxError(
          "NETWORK_UNAVAILABLE",
          "Mediated network transport closed",
          502,
        ),
      );
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
      opening.clear();
      const stopGuest = async () => {
        await execution.closeStdin().catch(() => {});
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const done = await Promise.race([
          execution.exited.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        clearTimeout(timeout);
        if (!done) await execution.kill("SIGKILL").catch(() => {});
      };
      await Promise.allSettled([proxy.close(), stopGuest()]);
      closeResolve();
    };
    const sendChunk = (id: string, socket: Socket) => {
      const pending = downstream.get(socket);
      if (!pending || pending.offset >= pending.data.length) {
        downstream.delete(socket);
        socket.resume();
        return;
      }
      const chunk = pending.data.subarray(
        pending.offset,
        pending.offset + 32768,
      );
      pending.offset += chunk.length;
      void send({ type: "data", id, data: chunk.toString("base64") });
    };
    const onFrame = (frame: {
      type?: string;
      id?: string;
      data?: string;
      message?: string;
      protocol?: string;
      host?: string;
      port?: number;
    }) => {
      if (frame.type === "ready") {
        readyResolve();
        return;
      }
      if (frame.type === "error")
        throw new Error("Guest network proxy initialization failed");
      if (!frame.id || !/^[1-9][0-9]{0,15}$/.test(frame.id))
        throw new Error("Invalid network stream ID");
      const id = frame.id;
      if (frame.type === "dns" || frame.type === "udp") {
        if (
          typeof frame.data !== "string" ||
          frame.data.length > 87384 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)
        )
          throw new Error("Invalid datagram");
        if (datagramsPending >= 128) return;
        const bytes = Buffer.from(frame.data, "base64");
        datagramsPending++;
        const operation =
          frame.type === "dns"
            ? proxy.answerDNS(bytes).then((data) => {
                if (!stopping)
                  return send({
                    type: "dns",
                    id,
                    data: data.toString("base64"),
                  });
              })
            : proxy.sendDatagram(id, bytes, (data) => {
                if (!stopping)
                  void send({ type: "udp", id, data: data.toString("base64") });
              });
        void operation
          .catch(() => {})
          .finally(() => {
            datagramsPending--;
          });
        return;
      }
      if (frame.type === "udp-close") {
        proxy.closeDatagrams(id);
        return;
      }
      if (frame.type === "open") {
        if (
          sockets.size + opening.size >= 128 ||
          sockets.has(id) ||
          opening.has(id)
        )
          throw new Error("Too many network streams or duplicate stream");
        if (frame.protocol !== "http" && frame.protocol !== "tcp")
          throw new Error("Invalid stream protocol");
        if (
          frame.protocol === "tcp" &&
          (typeof frame.host !== "string" || !Number.isInteger(frame.port))
        )
          throw new Error("Invalid TCP destination");
        opening.add(id);
        const connection =
          frame.protocol === "tcp"
            ? proxy.connectTCP(frame.host!, frame.port!)
            : proxy.connectProxy();
        void connection
          .then((socket) => {
            if (stopping || !opening.has(id)) {
              socket.destroy();
              return;
            }
            opening.delete(id);
            sockets.set(id, socket);
            socket.pause();
            socket.setTimeout(120000, () => socket.destroy());
            socket.on("data", (data) => {
              socket.pause();
              if (data.length > 2 * 1024 * 1024) {
                socket.destroy();
                return;
              }
              downstream.set(socket, {
                data: Buffer.isBuffer(data) ? data : Buffer.from(data),
                offset: 0,
              });
              sendChunk(id, socket);
            });
            socket.on("end", () => {
              if (!stopping) void send({ type: "end", id });
            });
            socket.on("error", () => {});
            socket.on("close", () => {
              sockets.delete(id);
              if (!stopping) void send({ type: "close", id });
            });
            void send({ type: "opened", id });
            socket.resume();
          })
          .catch(() => {
            opening.delete(id);
            if (!stopping) void send({ type: "close", id });
          });
        return;
      }
      if (frame.type === "close") opening.delete(id);
      const socket = sockets.get(id);
      if (!socket) return;
      if (frame.type === "data") {
        if (
          typeof frame.data !== "string" ||
          frame.data.length > 87384 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)
        )
          throw new Error("Invalid network payload");
        const bytes = Buffer.from(frame.data, "base64");
        if (bytes.length > 65536 || socket.writableLength > 1024 * 1024)
          throw new Error("Network stream exceeded buffer limit");
        socket.write(bytes, () => {
          if (!stopping) void send({ type: "ack", id });
        });
      } else if (frame.type === "ack") sendChunk(id, socket);
      else if (frame.type === "end") socket.end();
      else if (frame.type === "close") socket.destroy();
      else throw new Error("Unknown network frame");
    };
    void (async () => {
      try {
        for await (const chunk of execution.output) {
          if (stopping) break;
          if (chunk.stream === "stderr") continue;
          pending += Buffer.from(chunk.data).toString("utf8");
          if (pending.length > 256 * 1024)
            throw new Error("Oversized network frame");
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            onFrame(JSON.parse(line));
          }
        }
      } catch (error) {
        readyReject(
          error instanceof Error
            ? error
            : new Error("Network transport failed"),
        );
      } finally {
        await shutdown();
      }
    })();
    void execution.exited.finally(() => shutdown()).catch(() => {});
    const startup = setTimeout(() => {
      readyReject(
        new SboxError(
          "NETWORK_TIMEOUT",
          "Guest network proxy did not become ready",
          504,
        ),
      );
      void shutdown();
    }, 30_000);
    try {
      await send({
        type: "configure",
        cert: authority.cert,
        transparent: this.options.transparent !== false,
      });
      await ready;
    } catch (error) {
      await shutdown();
      throw error;
    } finally {
      clearTimeout(startup);
    }
    const environment = (env: Record<string, string>) => ({
      ...credentialEnvironment(configuration.credentials ?? {}, env),
      HTTP_PROXY: "http://127.0.0.1:18081",
      HTTPS_PROXY: "http://127.0.0.1:18081",
      http_proxy: "http://127.0.0.1:18081",
      https_proxy: "http://127.0.0.1:18081",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_EXTRA_CA_CERTS: "/etc/sbox/network-ca.pem",
      SSL_CERT_FILE: "/etc/sbox/network-ca-bundle.pem",
      REQUESTS_CA_BUNDLE: "/etc/sbox/network-ca-bundle.pem",
      CURL_CA_BUNDLE: "/etc/sbox/network-ca-bundle.pem",
    });
    return {
      get env() {
        return environment({});
      },
      environment,
      closed,
      update(next) {
        if (stopping)
          throw new SboxError(
            "NETWORK_UNAVAILABLE",
            "Mediated network is closed",
            502,
          );
        proxy.update(next);
        configuration = structuredClone(next);
      },
      close: shutdown,
    };
  }
}
