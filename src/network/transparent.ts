import type { Backend, Execution } from "../backend.ts";
import {
  tunnelBinary,
  type TunnelAssetOptions,
  type TunnelArchitecture,
} from "./assets.ts";

export const TUNNEL_BINARY_PATH = "/run/sbox-network/tun2socks";
export const TUNNEL_PROGRAM_PATH = "/run/sbox-network/transparent.js";

/** Runs only inside the Linux guest. It uses the kernel ABI, so iproute2 is unnecessary. */
export const TRANSPARENT_GUEST_PROGRAM = String.raw`
const fs = require('node:fs');
const { dlopen, ptr, toArrayBuffer } = require('bun:ffi');
if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch)) throw Error('Unsupported tunnel platform');
const name = 'sboxtun0';
if (fs.readdirSync('/sys/class/net').some(n => n !== 'lo')) throw Error('Transparent networking requires a guest without native network interfaces');
const libc = dlopen('libc.so.6', {
  ioctl: { args: ['i32', 'u64', 'ptr'], returns: 'i32' },
  socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
  close: { args: ['i32'], returns: 'i32' },
  mknod: { args: ['cstring', 'u32', 'u64'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
});
const errno = () => Buffer.from(toArrayBuffer(libc.symbols.__errno_location(), 0, 4)).readInt32LE();
const fd = libc.symbols.socket(2, 2, 0);
if (fd < 0) throw Error('Cannot configure the tunnel socket');
function ioctl(code, data, socket = fd) {
  if (libc.symbols.ioctl(socket, code, ptr(data)) !== 0) throw Error('Tunnel ioctl ' + code.toString(16) + ' failed: errno ' + errno());
}
function request() { const b = Buffer.alloc(40); b.write(name); return b; }
function address(b, offset, bytes) { b.writeUInt16LE(2, offset); Buffer.from(bytes).copy(b, offset + 4); }
fs.mkdirSync('/dev/net', { recursive: true });
if (!fs.existsSync('/dev/net/tun') && libc.symbols.mknod(Buffer.from('/dev/net/tun\0'), 0o020600, 10 * 256 + 200) !== 0) throw Error('Cannot create the kernel TUN device');
const devStat = fs.statSync('/dev/net/tun');
if (!devStat.isCharacterDevice()) throw Error('/dev/net/tun is not a character device');
let tunnel, previousDns, installedDns = false, status = 1;
const dns = 'nameserver 127.0.0.53\noptions timeout:2 attempts:2\n';
let stopResolve;
const stopped = new Promise(resolve => { stopResolve = resolve; });
process.once('SIGTERM', stopResolve);
process.once('SIGINT', stopResolve);
(async () => { try { for await (const _ of Bun.stdin.stream()) {} } finally { stopResolve(); } })().catch(stopResolve);
try {
  tunnel = Bun.spawn(['/run/sbox-network/tun2socks', '--device', name, '--proxy', 'socks5://127.0.0.1:18082', '--loglevel', 'error', '--udp-timeout', '1m'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' },
  });
  let errorText = '';
  const drain = (async () => { for await (const chunk of tunnel.stderr) { if (errorText.length < 4096) errorText += Buffer.from(chunk).toString().slice(0, 4096 - errorText.length); } })();
  let exitCode;
  void tunnel.exited.then(code => { exitCode = code; stopResolve(); });
  for (let i = 0; i < 250 && !fs.existsSync('/sys/class/net/' + name + '/ifindex'); i++) {
    if (exitCode !== undefined) { await drain; throw Error('tun2socks exited before readiness: ' + errorText); }
    await Bun.sleep(20);
  }
  if (!fs.existsSync('/sys/class/net/' + name + '/ifindex')) throw Error('The kernel did not create a TUN interface');
  const ip = request(); address(ip, 16, [198, 19, 255, 254]); ioctl(0x8916, ip);
  const mask = request(); address(mask, 16, [255, 254, 0, 0]); ioctl(0x891c, mask);
  const flags = request(); ioctl(0x8913, flags); flags.writeUInt16LE(flags.readUInt16LE(16) | 1, 16); ioctl(0x8914, flags);
  const device = Buffer.from(name + '\0');
  const route = Buffer.alloc(120);
  address(route, 8, [0, 0, 0, 0]); address(route, 24, [0, 0, 0, 0]); address(route, 40, [0, 0, 0, 0]);
  route.writeUInt16LE(1, 56); route.writeBigUInt64LE(BigInt(ptr(device)), 88); ioctl(0x890b, route);
  // Linux in6_rtmsg: a default IPv6 route uses the same TUN descriptor.
  const ipv6fd = libc.symbols.socket(10, 2, 0);
  const ipv6 = ipv6fd >= 0;
  if (!ipv6 && errno() !== 97) throw Error('Cannot configure the IPv6 tunnel socket: errno ' + errno());
  if (ipv6) try {
    const ifindex = Number(fs.readFileSync('/sys/class/net/' + name + '/ifindex', 'utf8').trim());
    fs.writeFileSync('/proc/sys/net/ipv6/conf/' + name + '/accept_dad', '0');
    const ipv6addr = Buffer.alloc(24); ipv6addr[0] = 0xfd; ipv6addr[15] = 1;
    ipv6addr.writeUInt32LE(128, 16); ipv6addr.writeUInt32LE(ifindex, 20); ioctl(0x8916, ipv6addr, ipv6fd);
    const ipv6route = Buffer.alloc(80); ipv6route.writeUInt32LE(1, 56); ipv6route.writeUInt32LE(1, 72); ipv6route.writeInt32LE(ifindex, 76);
    ioctl(0x890b, ipv6route, ipv6fd);
  } finally { libc.symbols.close(ipv6fd); }
  previousDns = fs.existsSync('/etc/resolv.conf') ? fs.readFileSync('/etc/resolv.conf') : null;
  fs.writeFileSync('/etc/resolv.conf', dns); installedDns = true;
  console.log(JSON.stringify({ ready: true, ipv4: true, ipv6 }));
  await stopped;
  if (exitCode !== undefined) throw Error('tun2socks exited unexpectedly');
  status = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Tunnel setup failed');
} finally {
  if (tunnel) { tunnel.kill('SIGKILL'); await tunnel.exited.catch(() => {}); }
  if (installedDns) {
    try { if (fs.readFileSync('/etc/resolv.conf', 'utf8') === dns) { if (previousDns === null) fs.unlinkSync('/etc/resolv.conf'); else fs.writeFileSync('/etc/resolv.conf', previousDns); } } catch {}
  }
  libc.symbols.close(fd); libc.close();
}
process.exit(status);
`;

const WRITE_GUEST_FILE = String.raw`
const fs = require('node:fs');
const dir = '/run/sbox-network';
fs.mkdirSync(dir, {recursive:true,mode:0o700});
if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error('Invalid network directory');
fs.chmodSync(dir,0o700);
const [name,size,hash,mode] = JSON.parse(process.argv[1]);
if (!['tun2socks','transparent.js'].includes(name)) throw Error('Invalid network asset');
const temp = dir + '/.' + name + '.' + crypto.randomUUID();
const fd = fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,mode);
const digest = require('node:crypto').createHash('sha256');
let written = 0;
try {
  for await(const chunk of Bun.stdin.stream()) {
    written += chunk.byteLength;
    if(written>size) throw Error('Oversized network asset');
    digest.update(chunk);
    let offset=0;while(offset<chunk.byteLength)offset+=fs.writeSync(fd,chunk,offset,chunk.byteLength-offset);
  }
  if(written!==size || digest.digest('hex')!==hash)throw Error('Network asset integrity check failed');
  fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(temp,dir+'/'+name);
} finally {try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(temp);}catch{}}
`;
async function output(execution: Execution): Promise<string> {
  let result = "";
  for await (const part of execution.output) {
    result += Buffer.from(part.data).toString();
    if (result.length > 16_384)
      throw new Error("Network preparation produced excessive output");
  }
  return result;
}
async function install(
  backend: Backend,
  id: string,
  name: string,
  data: Uint8Array,
  mode: number,
): Promise<void> {
  const execution = await backend.exec(id, {
    cmd: "bun",
    args: [
      "-e",
      WRITE_GUEST_FILE,
      JSON.stringify([
        name,
        data.byteLength,
        new Bun.CryptoHasher("sha256").update(data).digest("hex"),
        mode,
      ]),
    ],
    cwd: "/",
    env: {},
    user: "root",
    stdin: true,
    timeoutMs: 120_000,
  });
  const drain = output(execution);
  void drain.catch(() => execution.kill("SIGKILL").catch(() => {}));
  try {
    for (let offset = 0; offset < data.byteLength; offset += 128 * 1024)
      await execution.write(data.subarray(offset, offset + 128 * 1024));
    await execution.closeStdin();
    const [result, status] = await Promise.all([drain, execution.exited]);
    if (status.exitCode !== 0)
      throw new Error(
        `Unable to install the transparent network helper: ${result.trim()}`,
      );
  } catch (error) {
    await execution.kill("SIGKILL").catch(() => {});
    throw error;
  }
}

/** Installs verified assets. Start PROGRAM with piped stdin after SOCKS and DNS listeners are ready. */
export async function prepareTunnel(
  backend: Backend,
  id: string,
  options: TunnelAssetOptions = {},
): Promise<void> {
  const probe = await backend.exec(id, {
    cmd: "bun",
    args: ["-e", 'console.log(process.platform+":"+process.arch)'],
    cwd: "/",
    env: {},
    user: "root",
    timeoutMs: 10_000,
  });
  const [platform, status] = await Promise.all([output(probe), probe.exited]);
  if (status.exitCode !== 0 || !/^linux:(arm64|x64)\s*$/.test(platform))
    throw new Error(
      "Transparent networking requires a Linux arm64 or x64 guest with Bun",
    );
  const architecture = platform.trim().split(":")[1] as TunnelArchitecture;
  await install(
    backend,
    id,
    "tun2socks",
    await tunnelBinary(architecture, options),
    0o700,
  );
  await install(
    backend,
    id,
    "transparent.js",
    Buffer.from(TRANSPARENT_GUEST_PROGRAM),
    0o700,
  );
}
