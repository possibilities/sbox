import { SboxError } from "../errors.ts";
/** DNS names stay on the host; synthetic addresses bind subsequent TCP/UDP to them. */
export class NetworkDNS {
  private readonly byHost = new Map<string, string>();
  private readonly byAddress = new Map<string, string>();
  private next = 1;
  constructor(private readonly authorize: (host: string) => Promise<void>) {}
  hostname(address: string): string {
    return this.byAddress.get(address) ?? address;
  }
  async answer(packet: Uint8Array): Promise<Buffer> {
    const input = Buffer.from(packet);
    if (
      input.length < 12 ||
      input.length > 4096 ||
      input.readUInt16BE(4) !== 1 ||
      (input.readUInt16BE(2) & 0xf800) !== 0
    )
      throw new SboxError("INVALID_DNS", "Invalid DNS query", 400);
    let offset = 12;
    const labels: string[] = [];
    while (true) {
      if (offset >= input.length) throw new Error("Truncated DNS query");
      const length = input[offset++]!;
      if (length === 0) break;
      if (length > 63 || offset + length > input.length)
        throw new Error("Invalid DNS name");
      const label = input.subarray(offset, offset + length).toString("ascii");
      offset += length;
      if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Invalid DNS name");
      labels.push(label.toLowerCase());
    }
    if (offset + 4 > input.length || !labels.length)
      throw new Error("Invalid DNS question");
    const type = input.readUInt16BE(offset),
      qclass = input.readUInt16BE(offset + 2);
    offset += 4;
    const hostname = labels.join(".");
    if (hostname.length > 253) throw new Error("Invalid DNS name");
    const response = Buffer.alloc(offset);
    input.copy(response, 0, 0, offset);
    response.writeUInt16BE(0x8180, 2);
    response.writeUInt16BE(0, 6);
    response.writeUInt16BE(0, 8);
    response.writeUInt16BE(0, 10);
    try {
      if (qclass !== 1 || ![1, 28].includes(type))
        throw new Error("Unsupported DNS question");
      await this.authorize(hostname);
      if (type === 28) return response; // IPv4 TUN; AAAA NODATA makes clients prefer A.
      let address = this.byHost.get(hostname);
      if (!address) {
        if (this.byHost.size >= 8192)
          throw new Error("DNS mapping capacity exceeded");
        const value = this.next++;
        address = `198.${18 + ((value >>> 16) & 1)}.${(value >>> 8) & 255}.${value & 255}`;
        this.byHost.set(hostname, address);
        this.byAddress.set(address, hostname);
      }
      const answer = Buffer.alloc(16);
      answer.writeUInt16BE(0xc00c, 0);
      answer.writeUInt16BE(1, 2);
      answer.writeUInt16BE(1, 4);
      answer.writeUInt32BE(30, 6);
      answer.writeUInt16BE(4, 10);
      address.split(".").forEach((part, index) => {
        answer[12 + index] = Number(part);
      });
      response.writeUInt16BE(1, 6);
      return Buffer.concat([response, answer]);
    } catch {
      response.writeUInt16BE(0x8185, 2);
      return response;
    }
  }
}
export function parseSocksDatagram(packet: Uint8Array): {
  host: string;
  port: number;
  data: Buffer;
  header: Buffer;
} {
  const input = Buffer.from(packet);
  if (input.length < 7 || input[0] !== 0 || input[1] !== 0 || input[2] !== 0)
    throw new Error("Fragmented or malformed SOCKS datagram");
  const type = input[3];
  let host: string, offset: number;
  if (type === 1) {
    if (input.length < 10) throw new Error("Truncated SOCKS datagram");
    host = [...input.subarray(4, 8)].join(".");
    offset = 8;
  } else if (type === 3) {
    const length = input[4]!;
    offset = 5 + length;
    if (!length || offset + 2 > input.length)
      throw new Error("Truncated SOCKS domain");
    host = input.subarray(5, offset).toString("ascii");
  } else if (type === 4) {
    if (input.length < 22) throw new Error("Truncated SOCKS IPv6");
    host = Array.from({ length: 8 }, (_, index) =>
      input.readUInt16BE(4 + index * 2).toString(16),
    ).join(":");
    offset = 20;
  } else throw new Error("Unsupported SOCKS address type");
  const port = input.readUInt16BE(offset);
  if (!port) throw new Error("Invalid SOCKS port");
  return {
    host,
    port,
    header: input.subarray(0, offset + 2),
    data: input.subarray(offset + 2),
  };
}
