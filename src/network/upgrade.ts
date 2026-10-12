import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import {
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ClientRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity } from "node:tls";

export interface UpgradeOptions {
  /** Final destination, after policy transforms and forwarding rules. */
  url: URL;
  /** Policy-filtered request headers, including explicit credential injection. */
  headers: Headers | OutgoingHttpHeaders;
  /** Every address must already be authorized. The helper never performs DNS lookup. */
  addresses: LookupAddress[];
  upstreamCA?: string;
  onSocket?: (socket: Socket) => void;
  signal?: AbortSignal;
  /** Guards sequential address retries against a policy change during connection. */
  isActive?: () => boolean;
  handshakeTimeoutMs?: number;
}
const websocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const hasToken = (value: string | string[] | undefined, token: string) =>
  (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .some((part) => part.trim().toLowerCase() === token);
const single = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

function responseHead(response: IncomingMessage, upgraded: boolean): string {
  const status = response.statusCode ?? 502;
  const reason = (response.statusMessage ?? "").replace(/[\r\n]/g, "");
  const headers: string[] = [`HTTP/1.1 ${status} ${reason}`];
  const omit = new Set([
    "connection",
    "upgrade",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "trailer",
  ]);
  for (const token of (single(response.headers.connection) ?? "").split(","))
    omit.add(token.trim().toLowerCase());
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]!,
      value = response.rawHeaders[i + 1]!;
    if (!omit.has(name.toLowerCase())) headers.push(`${name}: ${value}`);
  }
  headers.push(
    upgraded
      ? "Connection: Upgrade\r\nUpgrade: websocket"
      : "Connection: close",
    "",
    "",
  );
  return headers.join("\r\n");
}

/** Forward an already authorized WebSocket handshake and its byte stream. */
export async function forwardUpgrade(
  request: IncomingMessage,
  downstream: Socket,
  head: Buffer,
  options: UpgradeOptions,
): Promise<void> {
  const url = new URL(options.url);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid WebSocket destination");
  const input =
    options.headers instanceof Headers
      ? Object.fromEntries(options.headers)
      : options.headers;
  const headers: OutgoingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(input))
    headers[name.toLowerCase()] = value;
  const key = single(
    headers["sec-websocket-key"] as string | string[] | undefined,
  );
  if (
    request.method !== "GET" ||
    !hasToken(headers.upgrade as string | string[] | undefined, "websocket") ||
    !hasToken(headers.connection as string | string[] | undefined, "upgrade") ||
    headers["sec-websocket-version"] !== "13" ||
    !key ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    Buffer.from(key, "base64").length !== 16 ||
    head.byteLength > 1024 * 1024
  )
    throw new Error("Invalid WebSocket handshake");
  if (
    !options.addresses.length ||
    options.addresses.length > 64 ||
    options.addresses.some(
      ({ address, family }) =>
        ![4, 6].includes(family) || isIP(address) !== family,
    )
  )
    throw new Error("No valid authorized upstream addresses");
  headers.host = url.host;
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers["proxy-authorization"];
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const controller = new AbortController();
  const abort = () => controller.abort();
  downstream.once("close", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted || downstream.destroyed) abort();
  let accepted = false;
  let active: ClientRequest | undefined;
  const timeout = setTimeout(abort, options.handshakeTimeoutMs ?? 10_000);
  const ensureActive = () => {
    if (controller.signal.aborted || options.isActive?.() === false)
      throw new Error("WebSocket forwarding cancelled");
  };
  try {
    for (const address of options.addresses) {
      ensureActive();
      try {
        await new Promise<void>((resolve, reject) => {
          let responded = false;
          let outbound: ClientRequest;
          let connectTimer: ReturnType<typeof setTimeout>;
          const fail = (error: Error) => {
            if (responded) return;
            clearTimeout(connectTimer);
            outbound?.destroy();
            reject(error);
          };
          outbound = active = (
            url.protocol === "https:" ? httpsRequest : httpRequest
          )({
            protocol: url.protocol,
            hostname: address.address,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers,
            agent: false,
            family: address.family,
            servername: isIP(host) ? undefined : host,
            ca: options.upstreamCA,
            rejectUnauthorized: true,
            checkServerIdentity: (_serverName, certificate) =>
              checkServerIdentity(host, certificate),
            maxHeaderSize: 32 * 1024,
            signal: controller.signal,
          });
          connectTimer = setTimeout(
            () => fail(new Error("WebSocket upstream connection timed out")),
            Math.min(2000, options.handshakeTimeoutMs ?? 10000),
          );
          outbound.on("socket", (socket) => {
            socket.once(
              url.protocol === "https:" ? "secureConnect" : "connect",
              () => clearTimeout(connectTimer),
            );
            try {
              ensureActive();
              options.onSocket?.(socket);
            } catch (error) {
              socket.destroy();
              fail(error as Error);
            }
          });
          outbound.once("error", fail);
          outbound.once("response", (response) => {
            clearTimeout(connectTimer);
            responded = true;
            accepted = true;
            clearTimeout(timeout);
            if (controller.signal.aborted || options.isActive?.() === false) {
              response.destroy();
              downstream.destroy();
              resolve();
              return;
            }
            downstream.write(responseHead(response, false));
            const cancelResponse = () => {
              response.destroy();
              downstream.destroy();
            };
            controller.signal.addEventListener("abort", cancelResponse, {
              once: true,
            });
            response.on("error", () => downstream.destroy());
            downstream.once("close", () => {
              controller.signal.removeEventListener("abort", cancelResponse);
              response.destroy();
              resolve();
            });
            response.pipe(downstream);
          });
          outbound.once("upgrade", (response, upstream, upstreamHead) => {
            clearTimeout(connectTimer);
            responded = true;
            accepted = true;
            clearTimeout(timeout);
            const accept = createHash("sha1")
              .update(key + websocketMagic)
              .digest("base64");
            const protocol = single(response.headers["sec-websocket-protocol"]);
            const offered = (
              single(
                headers["sec-websocket-protocol"] as
                  | string
                  | string[]
                  | undefined,
              ) ?? ""
            )
              .split(",")
              .map((part) => part.trim());
            if (
              response.statusCode !== 101 ||
              !hasToken(response.headers.upgrade, "websocket") ||
              !hasToken(response.headers.connection, "upgrade") ||
              response.headers["sec-websocket-accept"] !== accept ||
              (protocol !== undefined &&
                (!offered.includes(protocol) || protocol.includes(","))) ||
              controller.signal.aborted ||
              options.isActive?.() === false
            ) {
              upstream.destroy();
              downstream.destroy();
              resolve();
              return;
            }
            const close = () => {
              controller.signal.removeEventListener("abort", close);
              upstream.destroy();
              downstream.destroy();
              resolve();
            };
            controller.signal.addEventListener("abort", close, { once: true });
            upstream.on("error", close);
            downstream.on("error", close);
            upstream.once("close", close);
            downstream.once("close", close);
            downstream.write(responseHead(response, true));
            if (upstreamHead.length) downstream.write(upstreamHead);
            if (head.length) upstream.write(head);
            downstream.pipe(upstream);
            upstream.pipe(downstream);
            downstream.resume();
          });
          outbound.end();
        });
        return;
      } catch (error) {
        if (
          accepted ||
          controller.signal.aborted ||
          options.isActive?.() === false ||
          address === options.addresses.at(-1)
        )
          throw error;
      }
    }
    throw new Error("Unable to connect to an authorized WebSocket upstream");
  } finally {
    clearTimeout(timeout);
    downstream.off("close", abort);
    options.signal?.removeEventListener("abort", abort);
    active?.destroy();
  }
}
