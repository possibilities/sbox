# Network policies and credentials

Sbox’s API server uses an authenticated execution channel to mediate guest traffic. Hypeman creates the VM without an external network interface. Policy decisions, upstream TLS verification, and real credentials live on the control-plane host. This works with local or remote Hypeman: upstream connections originate from the control-plane host.

`allow-all` permits public destinations. `deny-all` blocks outbound requests. Loopback remains available inside the guest for applications and previews. Private, loopback, link-local, and multicast destinations on the control-plane host require an explicit matching `subnets.allow` entry; allowing a hostname alone does not grant access to internal addresses. Explicit subnet denies take precedence. Connections resolve and check their destinations before dialing. IPv4/IPv6 fallback uses only the addresses approved by that lookup; retries cannot perform an unchecked second lookup.

## Policies

```ts
import { Sandbox } from "@sbox/sandbox";

const sandbox = await Sandbox.create({
  networkPolicy: {
    allow: ["registry.npmjs.org", "api.openai.com", "api.anthropic.com"],
    subnets: { deny: ["169.254.0.0/16"] },
  },
});
```

An object maps destination hostnames to ordered HTTP rules. An empty rule array allows requests to that host. Matchers support `exact`, `startsWith`, and RE2 `regex`; request fields include path, method, headers, and query-string pairs. Each rule selects one action: request-header transforms, a synthetic response, or forwarding to another URL.

```ts
await sandbox.update({
  networkPolicy: {
    allow: {
      "api.example.com": [
        {
          match: { path: { startsWith: "/v1/" }, method: ["GET", "POST"] },
          transform: [
            { headers: { "x-service-key": process.env.SERVICE_KEY! } },
          ],
        },
        {
          response: {
            statusCode: 403,
            contentType: "text/plain",
            body: "This path is disabled",
          },
        },
      ],
      "fixture.example.com": [
        {
          response: {
            statusCode: 200,
            contentType: "application/json",
            body: '{"ok":true}',
          },
        },
      ],
    },
  },
});
```

Header transforms stay in private persisted policy records. Public sandbox and snapshot metadata redacts their values. Network updates close existing mediated connections before applying the new policy, including pooled connections; applications should retry interrupted requests when appropriate. Invalid policies fail before installation.

`forwardURL` sends the request to the configured proxy destination and supplies `vercel-forwarded-host`, `vercel-forwarded-scheme`, `vercel-forwarded-port`, and `vercel-forwarded-path` for routing. Caller-supplied forwarding and Sbox identity headers are stripped. The server signs `x-sbox-proxy-token` with its private Ed25519 key. The signature binds the source sandbox, original URL, destination URL, method, expiry, and a unique nonce. These are Sbox identities; the server does not mint Vercel tokens.

A custom proxy can verify them and recover the original request:

```ts
import {
  defineSandboxProxy,
  getSandboxProxyIdentity,
} from "@sbox/sandbox/proxy";

// Retrieve from your configured, authenticated control plane during setup.
const trusted = await getSandboxProxyIdentity({
  baseUrl: process.env.SBOX_URL!,
  token: process.env.SBOX_TOKEN!,
});

const handler = defineSandboxProxy(
  async (originalRequest, meta) => {
    console.log(meta.sandboxId);
    return fetch(originalRequest);
  },
  { ...trusted, audience: "https://proxy.example.com" },
);

Bun.serve({ port: 8080, fetch: handler }); // Behind TLS at the configured audience.
```

The verifier trusts only the explicitly configured key and issuer, checks the destination path and method, rejects expired or replayed tokens, and strips forwarding credentials before invoking the handler. It never fetches a verification URL supplied in a request. Configure `audience` when TLS terminates ahead of the application. The helper’s trusted-key options intentionally differ from Vercel’s automatic Vercel OIDC verification.

## Host-held credentials

Ordinary `env` values are intentionally visible to guest code. Use `credentials` and a separate `credentialSecrets` object when the guest should receive a mock value while the host injects the real header:

```ts
const sandbox = await Sandbox.create({
  networkPolicy: { allow: ["api.openai.com", "api.anthropic.com"] },
  credentials: {
    OPENAI_API_KEY: {
      source: { env: "OPENAI_SECRET" },
      inject: [
        {
          hosts: ["api.openai.com"],
          as: { header: "Authorization", format: "Bearer ${value}" },
        },
      ],
    },
    ANTHROPIC_API_KEY: {
      source: { env: "ANTHROPIC_SECRET" },
      inject: [
        {
          hosts: ["api.anthropic.com"],
          as: { header: "x-api-key", format: "${value}" },
        },
      ],
    },
  },
  credentialSecrets: {
    OPENAI_SECRET: process.env.OPENAI_API_KEY!,
    ANTHROPIC_SECRET: process.env.ANTHROPIC_API_KEY!,
  },
});

await sandbox.update({
  credentialSecrets: { OPENAI_SECRET: "replacement-value" },
});
```

Aliases and source keys cannot also appear in sandbox `env`. The execution layer strips source keys and forces mock aliases after merging per-command environment variables. Real values are never sent to Hypeman’s instance configuration or copied into the guest filesystem. Secret values and the CA private key are stored in the protected control-plane database; snapshot inheritance copies them between private records rather than placing them in public snapshot metadata. A separate API token controls access to the server and must never be given to the guest.

Brokering is destination-scoped header injection for HTTPS API clients. Clients receive a public trust certificate through the configured certificate bundle. A client that pins its provider’s leaf certificate cannot accept interception and will fail; do not disable TLS verification to make it work. OAuth logins, arbitrary SSH credentials, and non-HTTP authentication are not automatically converted into brokered credentials.

## Transparent transport

The guest uses a TUN interface, a local SOCKS bridge, and a local DNS responder. Ordinary TCP and UDP applications therefore work without reading proxy environment variables. HTTP/TLS clients also receive proxy and trust-bundle environment variables. Real tests cover Node HTTP(S), raw TCP, binary UDP, package-registry HTTPS, and WebSocket forwarding.

When a policy contains HTTP rules or credential injection, HTTP and TLS traffic is inspected on arbitrary ports, including WebSocket upgrades. Matching, transforms, forwarding, and HTTPS credential injection happen before the upgrade; text and binary frames stream afterward. Policy changes close these tunnels. TLS inspection advertises HTTP/1.1; clients that require HTTP/2 without fallback are incompatible with inspected routes. Routes that require no inspection retain raw TCP, including HTTP/2.

Mixed policies have conservative boundaries. A wildcard does not authorize a literal IP alias around a named HTTP restriction, and the requested HTTP authority must match the tunnel destination. Opaque protocols such as SSH remain available to explicitly named destinations without HTTP rules; wildcard-only destinations cannot use opaque protocols when inspection rules exist. UDP in a mixed policy requires an explicit CIDR grant and is blocked for names with HTTP or credential rules, preventing QUIC from bypassing inspection. An explicit CIDR grant intentionally permits domain-policy bypass for other destinations; use narrow ranges. Subnet denies still win.

On first use, the host downloads the pinned `tun2socks` 2.7.0 release for the guest architecture. Both the archive and extracted executable are checked against fixed SHA-256 digests before installation. Verified files are cached under `~/.cache/sbox/tun2socks/2.7.0`; the guest never needs a Go toolchain or an `ip` executable. Release licenses are included in `licenses/`.

DNS names receive session-local synthetic IPv4 addresses; the host resolves and pins their real destinations when connecting. Hosts with IPv6 connectivity can reach IPv6 upstream addresses even when the guest kernel has no IPv6 support. Literal guest IPv6 sockets require an IPv6-capable kernel; the tested Hypeman VZ kernel currently lacks it. ICMP and arbitrary raw IP protocols are outside this TCP/UDP transport.

## Operational behavior

Network mediation depends on a live control plane. If its channel disappears, guest egress fails closed; a subsequent execution can reconnect the transport. VM lifetime enforcement has a separate detached supervisor, so stopping the API process does not remove the deadline controller.

Host proxy and TLS inspection listeners require random, per-listener transport capabilities. Only the authenticated host execution bridge supplies these bytes. They are never copied into the guest, and a guest with an explicit localhost grant cannot borrow another sandbox's listener or credentials.

The proxy places finite limits on connections, request headers, and buffered transport data. These prevent an unconsumed stream from growing memory indefinitely. HTTP streaming responses and binary request bodies do not require full-body buffering. The API reports its network capabilities at `/v1/capabilities`.
