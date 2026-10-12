/**
 * Hypeman's exec socket merges stdout and stderr and has no stdin EOF or signal
 * messages. This small Bun program runs inside the VM and adds those semantics.
 * Transport payloads are base64 so arbitrary binary data survives JSON framing.
 */
const GUEST_BROKER_ENV = String.raw`
function withCredentialProxy(environment, brokered) {
  if (!brokered) return environment;
  const proxy = process.env.HTTPS_PROXY;
  if (!proxy || !require('node:fs').existsSync('/usr/local/share/ca-certificates/hypeman-egress-proxy.crt')) throw new Error('Provider credential proxy is unavailable');
  const url = new URL(proxy);
  if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid provider credential proxy URL');
  // Only provider-managed proxy values cross the transport environment boundary.
  return { ...environment, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/hypeman-egress-proxy.crt',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt', REQUESTS_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
  };
}
`;

export const GUEST_BRIDGE = String.raw`
${GUEST_BROKER_ENV}
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { constants } = require('node:os');
function run(options) {
let child;
let finished = false;
let timeout;
const frame = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const fail = (message) => { frame({ type: 'error', message }); process.exitCode = 127; };
const kill = (signal) => {
  if (!child || finished) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') frame({ type: 'error', message: error.message }); }
};
try {
  let command = options.command;
  let environment = withCredentialProxy(options.env ?? {}, options.brokered);
  if (options.user && options.user !== 'root' && options.user !== '0') {
    // runuser performs initgroups as well as UID/GID changes. Bun's uid/gid
    // spawn options clear supplementary groups, breaking shared group folders.
    // Apply caller env only after dropping privileges so LD_PRELOAD et al.
    // cannot influence the root helper itself.
    command = ['runuser', '-u', options.user, '--', 'env', '-i', '--', ...Object.entries(environment).map(([k,v]) => k + '=' + v), ...command];
    environment = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  }
  child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: environment,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.once('spawn', () => frame({ type: 'started', pid: child.pid }));
  for (const [type, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', data => {
      if (!frame({ type, data: data.toString('base64') })) {
        stream.pause(); process.stdout.once('drain', () => stream.resume());
      }
    });
  }
  child.stdin.on('error', error => { if (error.code !== 'EPIPE' && !finished) fail(error.message); });
  child.once('error', error => fail(error.message));
  child.once('close', (code, signal) => {
    finished = true;
    clearTimeout(timeout);
    const exitCode = code ?? (128 + (constants.signals[signal] || 0));
    frame({ type: 'exit', exitCode, signal });
    process.stdin.destroy();
    process.stdout.write('', () => process.exit(0));
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (finished) return;
    try {
      const input = JSON.parse(line);
      if (input.type === 'stdin' && typeof input.data === 'string') {
        if (!child.stdin.write(Buffer.from(input.data, 'base64'))) {
          process.stdin.pause(); child.stdin.once('drain', () => process.stdin.resume());
        }
      } else if (input.type === 'eof') child.stdin.end();
      else if (input.type === 'signal' && /^(SIGTERM|SIGKILL|SIGINT|SIGHUP|SIGQUIT|SIGUSR1|SIGUSR2|SIGSTOP|SIGCONT)$/.test(input.signal)) kill(input.signal);
      else throw new Error('Invalid command input frame');
    } catch (error) { fail(error.message); kill('SIGKILL'); }
  });
  process.stdin.once('end', () => { if (!finished) kill('SIGKILL'); });
  process.once('SIGTERM', () => kill('SIGTERM'));
  process.once('SIGINT', () => kill('SIGINT'));
  if (options.timeoutMs > 0) timeout = setTimeout(() => kill('SIGKILL'), options.timeoutMs);
} catch (error) { fail(error.message); }
}
const argument = process.argv.at(-1);
if (process.argv.length > 1 && argument && argument !== '--') {
  run(JSON.parse(Buffer.from(argument, 'base64url').toString()));
} else {
  const setup = createInterface({ input: process.stdin, crlfDelay: Infinity });
  setup.once('line', line => {
    setup.close();
    try {
      const frame = JSON.parse(line);
      if (frame.type !== 'start' || !Array.isArray(frame.options?.command)) throw new Error('Invalid command setup frame');
      run(frame.options);
    } catch (error) {
      process.stdout.write(JSON.stringify({ type: 'error', message: error.message }) + '\n', () => process.exit(127));
    }
  });
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
}
`;

/** Inherit the native PTY while keeping command secrets out of audit argv. */
export const GUEST_TERMINAL = String.raw`
${GUEST_BROKER_ENV}
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const fs = require('node:fs');
const options = JSON.parse(process.env.SBOX_TERMINAL_OPTIONS);
const pidFile = process.argv.at(-1);
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
let command = options.command;
let environment = withCredentialProxy(options.env, options.brokered);
if (options.user !== 'root' && options.user !== '0') {
  command = ['runuser', '-u', options.user, '--', 'env', '-i', '--', ...Object.entries(environment).map(([k,v]) => k + '=' + v), ...command];
  environment = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
}
const child = spawn(command[0], command.slice(1), {
  cwd: options.cwd, env: environment, stdio: 'inherit',
});
child.once('error', error => { console.error(error.message); process.exit(127); });
child.once('close', (code, signal) => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(code ?? (128 + (constants.signals[signal] || 0)));
});
`;

export interface BridgeOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  timeoutMs?: number;
  brokered?: boolean;
}

export type BridgeFrame =
  | { type: "ready" }
  | { type: "started"; pid: number }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number; signal?: string | null }
  | { type: "error"; message: string };

export function bridgeCommand(options?: BridgeOptions): string[] {
  return [
    "bun",
    "-e",
    GUEST_BRIDGE,
    "--",
    ...(options
      ? [Buffer.from(JSON.stringify(options)).toString("base64url")]
      : []),
  ];
}

export function bridgeStart(options: BridgeOptions): Uint8Array {
  return Buffer.from(JSON.stringify({ type: "start", options }) + "\n");
}

export function bridgeInput(
  type: "stdin" | "eof" | "signal",
  value?: Uint8Array | string,
): Uint8Array {
  const input =
    type === "stdin"
      ? { type, data: Buffer.from(value as Uint8Array).toString("base64") }
      : type === "signal"
        ? { type, signal: value }
        : { type };
  return Buffer.from(JSON.stringify(input) + "\n");
}

/** Incremental decoder handles arbitrary WebSocket frame boundaries. */
export class BridgeDecoder {
  private pending = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(data: Uint8Array): BridgeFrame[] {
    this.pending += this.decoder.decode(data, { stream: true });
    if (this.pending.length > 4 * 1024 * 1024)
      throw new Error("Guest command frame exceeded 4 MiB");
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    return lines.filter(Boolean).map((line) => {
      const frame = JSON.parse(line) as BridgeFrame;
      if (
        !["ready", "started", "stdout", "stderr", "exit", "error"].includes(
          frame.type,
        )
      ) {
        throw new Error("Invalid guest command frame");
      }
      return frame;
    });
  }

  finish(): void {
    this.pending += this.decoder.decode();
    if (this.pending.trim())
      throw new Error("Guest command stream ended with a partial frame");
  }
}
