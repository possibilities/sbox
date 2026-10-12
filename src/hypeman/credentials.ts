import { isIP } from "node:net";
import { SboxError } from "../errors.ts";
import type { CredentialPolicies } from "../types.ts";

export const CREDENTIAL_MANIFEST = "SBOX_CREDENTIAL_MANIFEST";
const reserved =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|ENV|BASH_ENV|IFS|CDPATH|GLOBIGNORE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS|NODE_OPTIONS)$|^(?:LD_|BUN_|SBOX_|DYLD_)/i;
const invalid = (message: string) =>
  new SboxError("invalid_credentials", message, 422);

function envName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ||
    reserved.test(value)
  ) {
    throw invalid(
      "Credential names and source keys must be ordinary environment identifiers, not runtime or proxy configuration keys",
    );
  }
}

function hostPattern(value: unknown): string {
  if (typeof value !== "string")
    throw invalid("Credential hosts must be hostname patterns");
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return host;
  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  const labels = name.split(".");
  if (
    name.length > 253 ||
    (wildcard && labels.length < 2) ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw invalid(
      "Credential hosts must be exact hosts/IPs or single-level *.example.com wildcards, without schemes, ports, or paths",
    );
  }
  return host;
}

/** Canonical, nonsecret policy persisted on the provider for restart recovery. */
export function normalizeCredentials(
  input: CredentialPolicies = {},
): CredentialPolicies {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 64
  )
    throw invalid("Credentials must contain at most 64 named policies");
  const result: CredentialPolicies = Object.create(null);
  for (const alias of Object.keys(input).sort()) {
    envName(alias);
    const policy = input[alias];
    envName(policy?.source?.env);
    if (
      !Array.isArray(policy.inject) ||
      !policy.inject.length ||
      policy.inject.length > 64
    )
      throw invalid(
        "Each credential requires between 1 and 64 injection rules",
      );
    result[alias] = {
      source: { env: policy.source.env },
      inject: policy.inject.map((rule) => {
        if (
          !rule ||
          typeof rule !== "object" ||
          !Array.isArray(rule.hosts) ||
          !rule.hosts.length ||
          rule.hosts.length > 64
        )
          throw invalid(
            "Every credential injection rule requires explicit destination hosts",
          );
        const header = rule.as?.header;
        const format = rule.as?.format;
        if (
          typeof header !== "string" ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
          /^(?:host|content-length|connection|transfer-encoding|trailer|upgrade|proxy-authorization|proxy-connection)$/i.test(
            header,
          )
        )
          throw invalid(
            "Credential header must be a valid end-to-end HTTP header",
          );
        if (
          typeof format !== "string" ||
          !format.includes("${value}") ||
          format.length > 4096 ||
          /[\r\n\0]/.test(format)
        )
          throw invalid(
            "Credential header format must contain ${value} and cannot contain line breaks",
          );
        return {
          hosts: [...new Set(rule.hosts.map(hostPattern))].sort(),
          as: { header: header.toLowerCase(), format },
        };
      }),
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024)
    throw invalid("Combined credential policies must fit within 48 KiB");
  return result;
}

export function encodeCredentialManifest(policies: CredentialPolicies): string {
  return Buffer.from(JSON.stringify({ version: 1, policies })).toString(
    "base64url",
  );
}

export function decodeCredentialManifest(value?: string): CredentialPolicies {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (parsed.version !== 1 || !parsed.policies)
      throw new Error("Unsupported manifest");
    return normalizeCredentials(parsed.policies);
  } catch {
    throw new SboxError(
      "credential_manifest_invalid",
      "The provider credential manifest is invalid; refusing execution",
      502,
    );
  }
}

export function nativeCredentialPolicies(
  policies: CredentialPolicies,
): CredentialPolicies {
  return Object.fromEntries(
    Object.entries(policies).map(([alias, policy]) => [
      alias,
      { ...policy, source: { env: alias } },
    ]),
  );
}

/** Map logical source keys to native aliases; source keys never enter guest env. */
export function nativeCredentialSecrets(
  policies: CredentialPolicies,
  secrets: Record<string, string> = {},
  requireAll = false,
): Record<string, string> {
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets))
    throw invalid(
      "Credential secrets must be an object containing bound source keys",
    );
  const sources = new Set(
    Object.values(policies).map((policy) => policy.source.env),
  );
  for (const [key, value] of Object.entries(secrets)) {
    if (!sources.has(key))
      throw invalid(
        "Credential secrets contain a key with no matching source binding",
      );
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value !== value.trim() ||
      value.length > 16384 ||
      /[\r\n\0]/.test(value)
    )
      throw invalid(
        "Credential secrets must be nonempty header values up to 16 KiB without surrounding whitespace or line breaks",
      );
  }
  if (requireAll && [...sources].some((key) => !Object.hasOwn(secrets, key)))
    throw invalid("A secret value is required for every credential source");
  return Object.fromEntries(
    Object.entries(policies).flatMap(([alias, policy]) =>
      Object.hasOwn(secrets, policy.source.env)
        ? [[alias, secrets[policy.source.env]!]]
        : [],
    ),
  );
}

export function credentialEnvironment(
  policies: CredentialPolicies,
  env: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = Object.assign(
    Object.create(null),
    env,
  );
  delete result[CREDENTIAL_MANIFEST];
  for (const policy of Object.values(policies))
    delete result[policy.source.env];
  for (const alias of Object.keys(policies)) result[alias] = `mock-${alias}`;
  return result;
}
