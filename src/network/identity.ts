import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { invariant } from "../errors.ts";

export interface ProxyIdentityKeys {
  issuer: string;
  privateKey: string;
  publicKey: string;
}
export interface ProxyIdentityPublic {
  issuer: string;
  publicKey: string;
  keyId: string;
  algorithm: "Ed25519";
}
export interface ProxyIdentityRequest {
  sandboxId: string;
  sandboxName?: string;
  originalUrl: string;
  targetUrl: string;
  method: string;
}
export interface ProxyIdentityClaims extends ProxyIdentityRequest {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}
export function createProxyIdentity(): ProxyIdentityKeys {
  const keys = generateKeyPairSync("ed25519");
  return {
    issuer: `urn:sbox:${crypto.randomUUID()}`,
    privateKey: keys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKey: keys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
  };
}
function validUrl(value: unknown): URL {
  invariant(
    typeof value === "string" && value.length <= 8192,
    "INVALID_PROXY_IDENTITY",
    "Invalid proxy URL",
    403,
  );
  const url = new URL(value);
  invariant(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "INVALID_PROXY_IDENTITY",
    "Invalid proxy URL",
    403,
  );
  return url;
}
const keyId = (key: KeyObject) =>
  createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 24);
/** Private signing material never leaves the control-plane host. */
export class ProxyIdentity {
  private readonly key: KeyObject;
  readonly public: ProxyIdentityPublic;
  constructor(keys: ProxyIdentityKeys) {
    this.key = createPrivateKey(keys.privateKey);
    const publicKey = createPublicKey(keys.publicKey);
    invariant(
      this.key.asymmetricKeyType === "ed25519" &&
        publicKey.asymmetricKeyType === "ed25519" &&
        keyId(createPublicKey(this.key)) === keyId(publicKey),
      "INVALID_PROXY_IDENTITY",
      "Forwarding identity keys must be a matching Ed25519 pair",
    );
    invariant(
      /^urn:sbox:[a-zA-Z0-9-]{1,128}$/.test(keys.issuer),
      "INVALID_PROXY_IDENTITY",
      "Invalid forwarding identity issuer",
    );
    this.public = {
      issuer: keys.issuer,
      publicKey: keys.publicKey,
      keyId: keyId(publicKey),
      algorithm: "Ed25519",
    };
  }
  sign(request: ProxyIdentityRequest): string {
    validUrl(request.originalUrl);
    const target = validUrl(request.targetUrl);
    invariant(
      /^sbx-[a-f0-9]{24}$/.test(request.sandboxId) &&
        /^[A-Z]{1,32}$/.test(request.method),
      "INVALID_PROXY_IDENTITY",
      "Invalid forwarding request identity",
    );
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({
        alg: "EdDSA",
        typ: "sbox-proxy+jwt",
        kid: this.public.keyId,
      }),
    ).toString("base64url");
    const claims: ProxyIdentityClaims = {
      ...request,
      iss: this.public.issuer,
      aud: target.origin,
      iat: now,
      exp: now + 30,
      jti: crypto.randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const unsigned = header + "." + payload;
    return (
      unsigned +
      "." +
      sign(null, Buffer.from(unsigned), this.key).toString("base64url")
    );
  }
}
export interface ProxyIdentityVerifierOptions
  extends Pick<ProxyIdentityPublic, "issuer" | "publicKey"> {
  audience?: string;
}
/** Explicit trusted key and issuer; a request cannot select its own verification endpoint. */
export function proxyIdentityVerifier(options: ProxyIdentityVerifierOptions) {
  const key = createPublicKey(options.publicKey);
  invariant(
    key.asymmetricKeyType === "ed25519",
    "INVALID_PROXY_IDENTITY",
    "Expected an Ed25519 public key",
  );
  const expectedKeyId = keyId(key);
  const audience = options.audience
    ? validUrl(options.audience).origin
    : undefined;
  const seen = new Map<string, number>();
  let nextPrune = 0;
  return (request: Request): ProxyIdentityClaims => {
    const token = request.headers.get("x-sbox-proxy-token");
    invariant(
      token && token.length <= 32768 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token),
      "INVALID_PROXY_IDENTITY",
      "Missing or invalid proxy signature",
      403,
    );
    const [headerText, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const header = JSON.parse(Buffer.from(headerText, "base64url").toString());
    invariant(
      header.alg === "EdDSA" &&
        header.typ === "sbox-proxy+jwt" &&
        header.kid === expectedKeyId &&
        verify(
          null,
          Buffer.from(headerText + "." + payload),
          key,
          Buffer.from(signature, "base64url"),
        ),
      "INVALID_PROXY_IDENTITY",
      "Proxy signature verification failed",
      403,
    );
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as ProxyIdentityClaims;
    const now = Math.floor(Date.now() / 1000);
    const original = validUrl(claims.originalUrl),
      target = validUrl(claims.targetUrl),
      received = new URL(request.url);
    invariant(
      claims.iss === options.issuer &&
        claims.aud === (audience ?? received.origin) &&
        target.origin === claims.aud &&
        target.pathname === received.pathname &&
        target.search === received.search &&
        claims.method === request.method &&
        Number.isSafeInteger(claims.iat) &&
        Number.isSafeInteger(claims.exp) &&
        claims.iat <= now + 5 &&
        claims.exp > now &&
        claims.exp - claims.iat <= 30 &&
        claims.exp > claims.iat &&
        typeof claims.jti === "string" &&
        /^[a-f0-9-]{36}$/.test(claims.jti) &&
        typeof claims.sandboxId === "string" &&
        /^sbx-[a-f0-9]{24}$/.test(claims.sandboxId),
      "INVALID_PROXY_IDENTITY",
      "Proxy identity does not match this request or has expired",
      403,
    );
    invariant(
      !claims.sandboxName ||
        (typeof claims.sandboxName === "string" &&
          claims.sandboxName.length <= 63),
      "INVALID_PROXY_IDENTITY",
      "Invalid sandbox name",
      403,
    );
    if (now >= nextPrune) {
      for (const [nonce, expires] of seen)
        if (expires <= now) seen.delete(nonce);
      nextPrune = now + 1;
    }
    invariant(
      !seen.has(claims.jti) && seen.size < 10_000,
      "INVALID_PROXY_IDENTITY",
      "Proxy token was replayed or verification capacity was exceeded",
      403,
    );
    seen.set(claims.jti, claims.exp);
    return {
      ...claims,
      originalUrl: original.toString(),
      targetUrl: target.toString(),
    };
  };
}
