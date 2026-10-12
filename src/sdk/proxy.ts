import { Client, type ClientOptions, type SignalOptions } from "./client.ts";
import type { ProxyIdentityPublic } from "../network/identity.ts";
import {
  proxyIdentityVerifier,
  type ProxyIdentityVerifierOptions,
} from "../network/identity.ts";
export interface ProxyMeta {
  host: string;
  sandboxId: string;
  sandboxName?: string;
}
export type ProxyHandler = (
  request: Request,
  meta: ProxyMeta,
) => Response | Promise<Response>;
export type InvalidRequestProxyHandler = (
  request: Request,
  error: Error,
) => Response | Promise<Response>;
/** Verify Sbox forwarding identities using a public key obtained from a trusted control plane. */
export function defineSandboxProxy(
  handler: ProxyHandler,
  options: ProxyIdentityVerifierOptions,
  invalidRequestHandler: InvalidRequestProxyHandler = () =>
    new Response("Forbidden", { status: 403 }),
) {
  const verify = proxyIdentityVerifier(options);
  return async (request: Request): Promise<Response> => {
    let verified: Request, meta: ProxyMeta;
    try {
      const identity = verify(request);
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()])
        if (
          key.startsWith("x-sbox-") ||
          key.startsWith("vercel-forwarded-") ||
          key === "vercel-sandbox-oidc-token"
        )
          headers.delete(key);
      headers.set("host", new URL(identity.originalUrl).host);
      verified = new Request(identity.originalUrl, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: "half",
      } as RequestInit);
      meta = {
        host: new URL(identity.targetUrl).host,
        sandboxId: identity.sandboxId,
        sandboxName: identity.sandboxName,
      };
    } catch (error) {
      return invalidRequestHandler(
        request,
        error instanceof Error ? error : new Error("Invalid proxy identity"),
      );
    }
    return handler(verified, meta);
  };
}
export type {
  ProxyIdentityPublic,
  ProxyIdentityVerifierOptions,
} from "../network/identity.ts";

export async function getSandboxProxyIdentity(
  options: ClientOptions & SignalOptions = {},
): Promise<ProxyIdentityPublic> {
  return new Client(options).rpc("proxy.identity", {}, options);
}
