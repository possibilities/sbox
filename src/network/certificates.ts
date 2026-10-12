// @peculiar/x509's dependency injection requires this before its first import.
import "reflect-metadata";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  createPrivateKey,
  X509Certificate as NativeCertificate,
} from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const day = 86400000;
const hour = 3600000;
const skew = 5 * 60000;
const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" } as const;

/** Persist this pair atomically in host-only storage. Never send key to a guest. */
export interface NetworkAuthority {
  cert: string;
  key: string;
}
/** A host-side TLS identity for one explicit destination, never a wildcard. */
export interface NetworkIdentity {
  readonly cert: string;
  readonly key: string;
}
export interface NetworkCertificateOptions {
  /** Useful to test renewal; defaults to the host clock. */
  now?: () => number;
  maxCached?: number;
  maxPending?: number;
}

/** Generate a private root with a standard X.509 library and native WebCrypto. */
export async function createNetworkAuthority(
  options: { now?: number; validityMs?: number } = {},
): Promise<NetworkAuthority> {
  const now = options.now ?? Date.now(),
    validity = options.validityMs ?? 3650 * day;
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(validity) ||
    validity < day ||
    validity > 3650 * day
  )
    throw new TypeError("Invalid certificate authority validity");
  const keys = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: `CN=Sbox Network Authority ${crypto.randomUUID()}`,
      notBefore: new Date(now - skew),
      notAfter: new Date(now + validity),
      signingAlgorithm,
      keys,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
          true,
        ),
        await SubjectKeyIdentifierExtension.create(
          keys.publicKey,
          false,
          crypto,
        ),
      ],
    },
    crypto,
  );
  return {
    cert: certificate.toString("pem"),
    key: PemConverter.encode(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
      "PRIVATE KEY",
    ),
  };
}

/** Public trust material only; the bootstrapper installs this root-owned file. */
export function networkTrustFile(
  authority: Pick<NetworkAuthority, "cert">,
  path = "/etc/sbox/network-ca.pem",
) {
  const blocks = PemConverter.decodeWithHeaders(authority.cert);
  if (blocks.length !== 1 || blocks[0]?.type !== "CERTIFICATE")
    throw new TypeError("Expected one public CA certificate");
  return { path, content: authority.cert, mode: 0o444 } as const;
}

function hostname(input: string): { host: string; type: "dns" | "ip" } {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 1024 ||
    /[\s\0%/@?#\\]/u.test(input)
  )
    throw new TypeError("Invalid TLS destination hostname");
  const unbracketed =
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (isIP(unbracketed)) {
    // URL canonicalizes IPv6 compression/case; isIP above prevents URL coercion.
    const host =
      isIP(unbracketed) === 6
        ? new URL(`https://[${unbracketed}]/`).hostname.slice(1, -1)
        : unbracketed;
    return { host, type: "ip" };
  }
  if (/[\[\]:]/.test(input))
    throw new TypeError("Invalid TLS destination hostname");
  const host = domainToASCII(input.replace(/\.$/, "")).toLowerCase();
  if (
    !host ||
    host.length > 253 ||
    host
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new TypeError("Invalid TLS destination hostname");
  return { host, type: "dns" };
}

/** Short-lived leaf identities with LRU eviction and concurrent issuance deduplication. */
export class NetworkCertificates {
  private readonly issuer: X509Certificate;
  private readonly signingKey: Promise<CryptoKey>;
  private readonly now: () => number;
  private readonly maxCached: number;
  private readonly maxPending: number;
  private readonly cache = new Map<
    string,
    { identity: NetworkIdentity; expires: number }
  >();
  private readonly pending = new Map<string, Promise<NetworkIdentity>>();

  constructor(
    authority: NetworkAuthority,
    options: NetworkCertificateOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxCached = options.maxCached ?? 512;
    this.maxPending = options.maxPending ?? 32;
    if (
      ![this.maxCached, this.maxPending].every(
        (limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 4096,
      )
    )
      throw new TypeError("Invalid certificate cache limits");
    try {
      const certificates = PemConverter.decodeWithHeaders(authority.cert),
        keys = PemConverter.decodeWithHeaders(authority.key);
      if (
        certificates.length !== 1 ||
        certificates[0]?.type !== "CERTIFICATE" ||
        keys.length !== 1 ||
        keys[0]?.type !== "PRIVATE KEY"
      )
        throw new Error("Expected one certificate and PKCS#8 key");
      const native = new NativeCertificate(authority.cert);
      const privateKey = createPrivateKey(authority.key);
      if (
        !native.ca ||
        native.subject !== native.issuer ||
        !native.verify(native.publicKey) ||
        !native.checkPrivateKey(privateKey)
      )
        throw new Error("Certificate authority and signing key must match");
      this.issuer = new X509Certificate(authority.cert);
      const usages = this.issuer.getExtension(KeyUsagesExtension);
      if (!usages || !(usages.usages & KeyUsageFlags.keyCertSign))
        throw new Error("Certificate authority cannot sign certificates");
      this.assertValid();
      this.signingKey = crypto.subtle.importKey(
        "pkcs8",
        keys[0].rawData,
        algorithm,
        false,
        ["sign"],
      );
      // A malformed saved key is reported by issue(), never an unhandled rejection.
      void this.signingKey.catch(() => {});
    } catch {
      throw new Error(
        "Invalid, expired, or mismatched network certificate authority",
      );
    }
  }

  private assertValid(): number {
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      this.issuer.notBefore.getTime() > now ||
      this.issuer.notAfter.getTime() <= now + hour
    )
      throw new Error(
        "Network certificate authority is not valid for new TLS connections; rotate its trust material",
      );
    return now;
  }

  issue(destination: string): Promise<NetworkIdentity> {
    let normalized: ReturnType<typeof hostname>, now: number;
    try {
      normalized = hostname(destination);
      now = this.assertValid();
    } catch (error) {
      return Promise.reject(error);
    }
    const { host, type } = normalized;
    const cached = this.cache.get(host);
    if (cached && cached.expires > now + hour) {
      this.cache.delete(host);
      this.cache.set(host, cached);
      return Promise.resolve(cached.identity);
    }
    this.cache.delete(host);
    const current = this.pending.get(host);
    if (current) return current;
    if (this.pending.size >= this.maxPending)
      return Promise.reject(
        new Error("Too many concurrent TLS certificate requests"),
      );
    const task = this.generate(host, type, now)
      .then((entry) => {
        for (const [name, item] of this.cache)
          if (item.expires <= this.now() + hour) this.cache.delete(name);
        while (this.cache.size >= this.maxCached)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(host, entry);
        return entry.identity;
      })
      .finally(() => this.pending.delete(host));
    this.pending.set(host, task);
    return task;
  }

  private async generate(host: string, type: "dns" | "ip", now: number) {
    const keys = await crypto.subtle.generateKey(algorithm, true, [
      "sign",
      "verify",
    ]);
    const expires = Math.min(now + 7 * day, this.issuer.notAfter.getTime());
    const certificate = await X509CertificateGenerator.create(
      {
        subject: `CN=${host.length <= 64 ? host : "Sbox sandbox destination"}`,
        issuer: this.issuer.subject,
        publicKey: keys.publicKey,
        signingKey: await this.signingKey,
        signingAlgorithm,
        notBefore: new Date(
          Math.max(now - skew, this.issuer.notBefore.getTime()),
        ),
        notAfter: new Date(expires),
        extensions: [
          new BasicConstraintsExtension(false, undefined, true),
          new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
          new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
          new SubjectAlternativeNameExtension([{ type, value: host }]),
          await SubjectKeyIdentifierExtension.create(
            keys.publicKey,
            false,
            crypto,
          ),
          await AuthorityKeyIdentifierExtension.create(
            this.issuer.publicKey,
            false,
            crypto,
          ),
        ],
      },
      crypto,
    );
    return {
      expires,
      identity: Object.freeze({
        cert: certificate.toString("pem"),
        key: PemConverter.encode(
          await crypto.subtle.exportKey("pkcs8", keys.privateKey),
          "PRIVATE KEY",
        ),
      }),
    };
  }
}
