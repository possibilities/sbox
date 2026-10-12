import { BlockList, isIP } from "node:net";
import { RE2 } from "./re2.ts";
import { SboxError } from "../errors.ts";

export type NetworkPolicyMatcher =
  | { exact: string }
  | { startsWith: string }
  | { regex: string };
export type NetworkMatcher = NetworkPolicyMatcher;
export interface NetworkPolicyKeyValueMatcher {
  key?: NetworkPolicyMatcher;
  value?: NetworkPolicyMatcher;
}
export interface NetworkPolicyMatch {
  path?: NetworkPolicyMatcher;
  method?: string[];
  queryString?: NetworkPolicyKeyValueMatcher[];
  headers?: NetworkPolicyKeyValueMatcher[];
}
export interface NetworkTransformer {
  headers?: Record<string, string>;
}
export interface NetworkPolicyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
}
export type NetworkPolicyRule = { match?: NetworkPolicyMatch } & (
  | { transform: NetworkTransformer[]; forwardURL?: never; response?: never }
  | { forwardURL: string; transform?: never; response?: never }
  | { response: NetworkPolicyResponse; transform?: never; forwardURL?: never }
);
export type NetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: string[] | Record<string, NetworkPolicyRule[]>;
      subnets?: { allow?: string[]; deny?: string[] };
    };
export interface RequestDescription {
  url: URL;
  method: string;
  headers: Headers;
}
export interface PolicyDecision {
  allowed: boolean;
  rule?: NetworkPolicyRule;
}
const invalid = (message: string) =>
  new SboxError("INVALID_NETWORK_POLICY", message, 422);
const deniedHeaders =
  /^(?:host|connection|keep-alive|proxy-connection|proxy-authorization|transfer-encoding|content-length|trailer|upgrade|te|vercel-forwarded-.+|vercel-sandbox-oidc-token|x-sbox-.+)$/i;
const matcherCache = new Map<string, RE2>();
function object(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} must be an object`);
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw invalid(`Unknown ${label} property: ${key}`);
}
function text(
  value: unknown,
  label: string,
  max = 4096,
): asserts value is string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw invalid(
      `${label} must be a string of at most ${max} characters without NUL bytes`,
    );
}
function headers(value: unknown) {
  object(value, "headers");
  if (Object.keys(value).length > 128) throw invalid("Too many policy headers");
  for (const [name, valueText] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || deniedHeaders.test(name))
      throw invalid("Policy headers cannot alter routing or HTTP framing");
    text(valueText, "header value", 16384);
    if (/[\r\n]/.test(valueText))
      throw invalid("Header values cannot contain line breaks");
  }
}
export function normalizeHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
export function domainMatches(pattern: string, hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    pattern === "*" ||
    pattern === host ||
    (pattern.startsWith("*.") &&
      host.endsWith(pattern.slice(1)) &&
      host !== pattern.slice(2))
  );
}
function domain(value: unknown): string {
  text(value, "domain", 253);
  const normalized = normalizeHost(value);
  if (normalized === "*" || isIP(normalized)) return normalized;
  const name = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (
    !name ||
    name
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw invalid(
      "Allow entries must be hostnames, IPs, *.domain wildcards, or *",
    );
  return normalized;
}
function compileRegex(source: string): RE2 {
  let regex = matcherCache.get(source);
  if (!regex) {
    try {
      regex = new RE2(source, "u");
    } catch {
      throw invalid("Policy regex must be a valid RE2 expression");
    }
    if (matcherCache.size >= 512)
      matcherCache.delete(matcherCache.keys().next().value!);
    matcherCache.set(source, regex);
  }
  return regex;
}
function matcher(value: unknown) {
  object(value, "matcher");
  keys(value, ["exact", "startsWith", "regex"], "matcher");
  const entries = Object.entries(value);
  if (entries.length !== 1)
    throw invalid(
      "A matcher requires exactly one of exact, startsWith, or regex",
    );
  text(entries[0]![1], "matcher value");
  if (entries[0]![0] === "regex") compileRegex(entries[0]![1] as string);
}
function matches(value: string, pattern: NetworkPolicyMatcher): boolean {
  if ("exact" in pattern) return value === pattern.exact;
  if ("startsWith" in pattern) return value.startsWith(pattern.startsWith);
  return compileRegex(pattern.regex).test(value);
}
function match(value: unknown) {
  object(value, "request matcher");
  keys(value, ["path", "method", "queryString", "headers"], "request matcher");
  if (value.path !== undefined) matcher(value.path);
  if (value.method !== undefined) {
    if (
      !Array.isArray(value.method) ||
      !value.method.length ||
      value.method.length > 64 ||
      value.method.some(
        (method) => typeof method !== "string" || !/^[A-Z]+$/.test(method),
      )
    )
      throw invalid(
        "Methods must be a nonempty list of uppercase HTTP methods",
      );
  }
  for (const key of ["queryString", "headers"])
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 128)
        throw invalid("Entry matchers must be arrays of at most 128 entries");
      for (const item of value[key] as unknown[]) {
        object(item, "entry matcher");
        keys(item, ["key", "value"], "entry matcher");
        if (item.key === undefined && item.value === undefined)
          throw invalid("Entry matcher requires key or value");
        if (item.key !== undefined) matcher(item.key);
        if (item.value !== undefined) matcher(item.value);
      }
    }
}
function rule(value: unknown): asserts value is NetworkPolicyRule {
  object(value, "rule");
  keys(value, ["match", "transform", "forwardURL", "response"], "rule");
  if (value.match !== undefined) match(value.match);
  if (
    ["transform", "forwardURL", "response"].filter(
      (key) => value[key] !== undefined,
    ).length !== 1
  )
    throw invalid(
      "Each rule requires exactly one of transform, forwardURL, or response",
    );
  if (value.transform !== undefined) {
    if (!Array.isArray(value.transform) || value.transform.length > 128)
      throw invalid("Transforms must be an array of at most 128 entries");
    for (const transform of value.transform) {
      object(transform, "transform");
      keys(transform, ["headers"], "transform");
      if (transform.headers !== undefined) headers(transform.headers);
    }
  }
  if (value.forwardURL !== undefined) {
    text(value.forwardURL, "forwardURL");
    let url: URL;
    try {
      url = new URL(value.forwardURL);
    } catch {
      throw invalid("forwardURL must be an HTTPS URL");
    }
    if (
      url.protocol !== "https:" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw invalid(
        "forwardURL must use HTTPS without credentials, query, or fragment",
      );
  }
  if (value.response !== undefined) {
    object(value.response, "response");
    keys(
      value.response,
      ["statusCode", "headers", "body", "contentType"],
      "response",
    );
    const response = value.response;
    if (
      !Number.isInteger(response.statusCode) ||
      Number(response.statusCode) < 200 ||
      Number(response.statusCode) > 599
    )
      throw invalid("Response statusCode must be between 200 and 599");
    if (response.headers !== undefined) headers(response.headers);
    if (response.contentType !== undefined) {
      text(response.contentType, "contentType");
      if (/[\r\n]/.test(response.contentType))
        throw invalid("Invalid contentType");
    }
    if (response.body !== undefined) {
      text(response.body, "response body", 1024 * 1024);
      if (
        !response.contentType ||
        [204, 205, 304].includes(Number(response.statusCode))
      )
        throw invalid(
          "Response bodies require contentType and a status that permits a body",
        );
    }
  }
}
function subnetList(values: unknown): BlockList {
  if (!Array.isArray(values) || values.length > 256)
    throw invalid("CIDRs must be arrays of at most 256 entries");
  const block = new BlockList();
  for (const cidr of values) {
    text(cidr, "CIDR", 128);
    const [ip, prefix, ...rest] = cidr.split("/");
    const family = isIP(ip!);
    if (
      !family ||
      prefix === undefined ||
      !/^[0-9]+$/.test(prefix) ||
      rest.length ||
      Number(prefix) > (family === 4 ? 32 : 128)
    )
      throw invalid("Invalid IPv4 or IPv6 CIDR");
    try {
      block.addSubnet(ip!, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    } catch {
      throw invalid("Invalid CIDR");
    }
  }
  return block;
}
export function validatePolicy(value: unknown): asserts value is NetworkPolicy {
  if (value === "allow-all" || value === "deny-all") return;
  object(value, "network policy");
  keys(value, ["allow", "subnets"], "network policy");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
    throw invalid("Network policy is too large");
  if (value.allow !== undefined) {
    const entries = Array.isArray(value.allow)
      ? value.allow.map((host) => [host, []] as const)
      : Object.entries((object(value.allow, "allow"), value.allow));
    if (entries.length > 1024) throw invalid("Too many allowed domains");
    const seen = new Set<string>();
    for (const [host, rules] of entries) {
      const name = domain(host);
      if (seen.has(name)) throw invalid("Duplicate normalized domain");
      seen.add(name);
      if (!Array.isArray(rules) || rules.length > 256)
        throw invalid("Domain rules must be an array of at most 256 entries");
      for (const entry of rules) rule(entry);
    }
  }
  if (value.subnets !== undefined) {
    object(value.subnets, "subnets");
    keys(value.subnets, ["allow", "deny"], "subnets");
    if (value.subnets.allow !== undefined) subnetList(value.subnets.allow);
    if (value.subnets.deny !== undefined) subnetList(value.subnets.deny);
  }
}
export function redactPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (typeof policy === "string") return policy;
  const result = structuredClone(policy);
  if (result.allow && !Array.isArray(result.allow))
    for (const rules of Object.values(result.allow))
      for (const rule of rules)
        for (const transform of rule.transform ?? [])
          if (transform.headers)
            for (const key of Object.keys(transform.headers))
              transform.headers[key] = "<redacted>";
  return result;
}
function matchesRequest(
  request: RequestDescription,
  match?: NetworkPolicyMatch,
): boolean {
  if (!match) return true;
  if (match.path && !matches(request.url.pathname, match.path)) return false;
  if (match.method && !match.method.includes(request.method)) return false;
  const entriesMatch = (
    patterns: NetworkPolicyKeyValueMatcher[] | undefined,
    entries: Array<[string, string]>,
  ) =>
    !patterns ||
    patterns.every((pattern) =>
      entries.some(
        ([key, value]) =>
          (!pattern.key || matches(key, pattern.key)) &&
          (!pattern.value || matches(value, pattern.value)),
      ),
    );
  return (
    entriesMatch(match.queryString, [...request.url.searchParams]) &&
    entriesMatch(match.headers, [...request.headers])
  );
}
export class CompiledPolicy {
  readonly policy: NetworkPolicy;
  private readonly domains: Array<[string, NetworkPolicyRule[]]>;
  private readonly allowed: BlockList;
  private readonly denied: BlockList;
  constructor(policy: NetworkPolicy) {
    validatePolicy(policy);
    this.policy = structuredClone(policy);
    this.domains =
      typeof policy === "string"
        ? []
        : Object.entries(
            Array.isArray(policy.allow)
              ? Object.fromEntries(policy.allow.map((host) => [host, []]))
              : (policy.allow ?? {}),
          ).map(([host, rules]) => [domain(host), rules]);
    // Exact hosts take precedence over increasingly broad wildcard domains.
    this.domains.sort(
      ([a], [b]) =>
        Number(a === "*") - Number(b === "*") ||
        Number(a.startsWith("*.")) - Number(b.startsWith("*.")) ||
        b.length - a.length,
    );
    this.allowed = subnetList(
      typeof policy === "string" ? [] : (policy.subnets?.allow ?? []),
    );
    this.denied = subnetList(
      typeof policy === "string" ? [] : (policy.subnets?.deny ?? []),
    );
  }
  addressAllowed(host: string, address: string): boolean {
    const family = isIP(address);
    if (!family) return false;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (this.policy === "deny-all" || this.denied.check(address, type))
      return false;
    return (
      this.policy === "allow-all" ||
      this.allowed.check(address, type) ||
      this.domains.some(([pattern]) => domainMatches(pattern, host))
    );
  }
  deniesAddress(address: string): boolean {
    const family = isIP(address);
    return (
      !family ||
      this.policy === "deny-all" ||
      this.denied.check(address, family === 4 ? "ipv4" : "ipv6")
    );
  }
  explicitlyAllowsAddress(address: string): boolean {
    const family = isIP(address);
    return Boolean(
      family && this.allowed.check(address, family === 4 ? "ipv4" : "ipv6"),
    );
  }
  /** Early domain decision supports synthetic responses without performing DNS. */
  request(request: RequestDescription): PolicyDecision {
    if (this.policy === "deny-all") return { allowed: false };
    const entry = this.domains.find(([pattern]) =>
      domainMatches(pattern, request.url.hostname),
    );
    if (entry)
      return {
        allowed: true,
        rule: entry[1].find((rule) => matchesRequest(request, rule.match)),
      };
    // A CIDR-only grant must be decided after resolution by addressAllowed.
    return { allowed: this.policy === "allow-all" };
  }
  hasDomain(host: string): boolean {
    return (
      this.policy === "allow-all" ||
      this.domains.some(([pattern]) => domainMatches(pattern, host))
    );
  }
}
