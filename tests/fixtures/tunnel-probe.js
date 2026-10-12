// Executed only inside a disposable NIC-less Linux VM by the opt-in live test.
const fs = require("node:fs");
const { get } = require("node:http");
const { createSocket } = require("node:dgram");
const { createServer } = require("node:net");
const beforeDns = fs.readFileSync("/etc/resolv.conf", "utf8");
const udp = createSocket("udp4");
await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
const udpPort = udp.address().port;
const sockets = new Set();
let tcpDestination, udpDestination;
udp.on("message", (message, peer) => {
  udpDestination =
    [...message.subarray(4, 8)].join(".") + ":" + message.readUInt16BE(8);
  udp.send(message, peer.port, peer.address);
});
const socks = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let phase = 0,
    buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (phase === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        phase = 1;
      } else if (phase === 1) {
        if (buffer.length < 10) return;
        if (buffer[3] !== 1)
          return socket.destroy(new Error("IPv4 probe expected"));
        const command = buffer[1];
        const destination =
          [...buffer.subarray(4, 8)].join(".") + ":" + buffer.readUInt16BE(8);
        if (command === 1) tcpDestination = destination;
        buffer = buffer.subarray(10);
        const response = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
        response.writeUInt16BE(command === 3 ? udpPort : 18082, 8);
        socket.write(response);
        phase = command === 3 ? 3 : 2;
      } else if (phase === 2) {
        if (!buffer.includes("\r\n\r\n")) return;
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nTUN TCP PASSED",
        );
        return;
      } else return;
    }
  });
});
await new Promise((resolve) => socks.listen(18082, "127.0.0.1", resolve));
const tunnel = Bun.spawn(["bun", "/run/sbox-network/transparent.js"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const errors = new Response(tunnel.stderr).text();
let result;
try {
  const reader = tunnel.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const part = await reader.read();
    if (part.done)
      throw Error("Tunnel failed to become ready: " + (await errors));
    line += Buffer.from(part.value).toString();
  }
  reader.releaseLock();
  const readiness = JSON.parse(line.trim());
  if (!readiness.ready || !readiness.ipv4) throw Error("Tunnel not ready");
  const interfaces = fs.readdirSync("/sys/class/net").sort();
  const dns = fs.readFileSync("/etc/resolv.conf", "utf8");
  const tcp = await new Promise((resolve, reject) => {
    const request = get("http://203.0.113.77:8080/", (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(Error("TCP timeout")));
  });
  const application = createSocket("udp4");
  let timer;
  let udpResponse;
  try {
    udpResponse = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error("UDP timeout")), 10_000);
      application.on("error", reject);
      application.once("message", (data) => resolve(data.toString()));
      application.send(Buffer.from("TUN UDP PASSED"), 5300, "203.0.113.88");
    });
  } finally {
    clearTimeout(timer);
    application.close();
  }
  result = {
    readiness,
    interfaces,
    dns,
    tcp,
    tcpDestination,
    udp: udpResponse,
    udpDestination,
  };
} finally {
  tunnel.stdin.end();
  const timeout = setTimeout(() => tunnel.kill("SIGKILL"), 5000);
  try {
    const code = await tunnel.exited;
    if (code !== 0) throw Error("Tunnel shutdown failed: " + (await errors));
  } finally {
    clearTimeout(timeout);
    for (const socket of sockets) socket.destroy();
    socks.close();
    udp.close();
  }
}
console.log(
  JSON.stringify({
    ...result,
    remainingInterfaces: fs.readdirSync("/sys/class/net"),
    dnsRestored: beforeDns === fs.readFileSync("/etc/resolv.conf", "utf8"),
  }),
);
