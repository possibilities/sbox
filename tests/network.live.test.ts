/** Opt-in real Hypeman transport; all created VMs are deleted in finally. */
import { expect, test } from "bun:test";
import { createServer } from "node:https";
import { createServer as createTCPServer } from "node:net";
import { createSocket } from "node:dgram";
import { HypemanBackend } from "../src/hypeman/index.ts";
import {
  MediatedNetwork,
  createNetworkAuthority,
  NetworkCertificates,
  type NetworkConfiguration,
  type NetworkSession,
} from "../src/network/index.ts";

test.skipIf(process.env.SBOX_LIVE_TEST !== "1")(
  "real NIC-less guest: transparent HTTP/TLS/TCP/UDP, host-only credentials, WebSocket, rotation and live revocation",
  async () => {
    if (!process.env.HYPEMAN_BASE_URL)
      throw new Error("Live network tests require HYPEMAN_BASE_URL");
    const backend = new HypemanBackend({
      baseUrl: process.env.HYPEMAN_BASE_URL,
      apiKey: process.env.HYPEMAN_API_KEY,
    });
    const authority = await createNetworkAuthority(),
      certificates = new NetworkCertificates(authority);
    let received = "",
      transformed = "";
    const material = await certificates.issue("api.example.test");
    const server = createServer(material, (request, response) => {
      received = request.headers.authorization ?? "";
      transformed = String(request.headers["x-host-only"] ?? "");
      if (request.url === "/echo") request.pipe(response);
      else response.end("accepted");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const tcp = createTCPServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const tcpPort = (tcp.address() as { port: number }).port;
    const udp = createSocket("udp4");
    udp.on("message", (bytes, peer) =>
      udp.send(bytes, peer.port, peer.address),
    );
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const ws = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: material,
      fetch(request, server) {
        received = request.headers.get("authorization") ?? "";
        if (server.upgrade(request)) return;
        return new Response("Upgrade required", { status: 400 });
      },
      websocket: {
        message(socket, data) {
          socket.send(data);
        },
      },
    });
    const mediated = new MediatedNetwork({
      authority,
      upstreamCA: authority.cert,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const config: NetworkConfiguration = {
      policy: {
        allow: {
          "api.example.test": [
            { transform: [{ headers: { "x-host-only": "host-transform" } }] },
          ],
          "tcp.example.test": [],
          "udp.example.test": [],
        },
        subnets: { allow: ["127.0.0.0/8"] },
      },
      credentials: {
        API_KEY: {
          source: { env: "HOST_SECRET" },
          inject: [
            {
              hosts: ["api.example.test"],
              as: { header: "Authorization", format: "Bearer ${value}" },
            },
          ],
        },
      },
      credentialSecrets: { HOST_SECRET: "synthetic-host-only-one" },
    };
    let id: string | undefined, session: NetworkSession | undefined;
    async function run(script: string) {
      const command = await backend.exec(id!, {
        cmd: "bun",
        args: ["-e", script],
        cwd: "/",
        env: session!.environment({}),
        user: "sandbox",
        timeoutMs: 20000,
      });
      let output = "",
        error = "";
      for await (const chunk of command.output) {
        if (chunk.stream === "stdout") output += Buffer.from(chunk.data);
        else error += Buffer.from(chunk.data);
      }
      expect((await command.exited).exitCode, error).toBe(0);
      return JSON.parse(output);
    }
    try {
      id = (
        await backend.create({
          name: `network-live-${crypto.randomUUID().slice(0, 8)}`,
          image: process.env.SBOX_LIVE_IMAGE ?? "oven/bun:1-debian",
          resources: { vcpus: 1, memoryMb: 512, diskMb: 1024 },
          env: {},
          mounts: [],
          networkPolicy: "deny-all",
          deadline: Date.now() + 300000,
        })
      ).id;
      session = await mediated.attach(backend, id, config);
      const environment = await run(
        `console.log(JSON.stringify({interfaces:Object.keys(require('node:os').networkInterfaces()),key:process.env.API_KEY,source:process.env.HOST_SECRET,files:require('node:fs').readdirSync('/etc/sbox')}))`,
      );
      expect(environment.interfaces.sort()).toEqual(["lo", "sboxtun0"]);
      expect(environment.key).toBe("mock-API_KEY");
      expect(environment.source).toBeUndefined();
      expect(
        environment.files.some((name: string) => name.includes("key")),
      ).toBe(false);
      const request = `console.log(JSON.stringify(await (await fetch('https://api.example.test:${port}/')).text()))`;
      expect(await run(request)).toBe("accepted");
      expect(received).toBe("Bearer synthetic-host-only-one");
      expect(transformed).toBe("host-transform");
      expect(
        await run(
          `const b=crypto.getRandomValues(new Uint8Array(65536));const response=await fetch('https://api.example.test:${port}/echo',{method:'POST',body:b});const out=new Uint8Array(await response.arrayBuffer());console.log(JSON.stringify(out.length===b.length&&out.every((v,i)=>v===b[i])))`,
        ),
      ).toBe(true);
      expect(
        await run(
          `require('node:https').get('https://api.example.test:${port}/',r=>{let body='';r.on('data',d=>body+=d);r.on('end',()=>console.log(JSON.stringify(body)))}).on('error',e=>{console.error(e);process.exit(1)})`,
        ),
      ).toBe("accepted");
      expect(received).toBe("Bearer synthetic-host-only-one");
      expect(
        await run(
          `const s=require('node:net').connect(${tcpPort},'tcp.example.test',()=>s.write(Buffer.from([0,255,128,42])));s.on('data',data=>{console.log(JSON.stringify([...data]));s.destroy()});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000).unref()`,
        ),
      ).toEqual([0, 255, 128, 42]);
      expect(
        await run(
          `const s=require('node:dgram').createSocket('udp4');s.on('message',data=>{console.log(JSON.stringify([...data]));s.close()});s.on('error',()=>process.exit(1));s.send(Buffer.from([0,255,128,43]),${udp.address().port},'udp.example.test');setTimeout(()=>process.exit(1),3000).unref()`,
        ),
      ).toEqual([0, 255, 128, 43]);
      expect(
        await run(
          `const socket=new WebSocket('wss://api.example.test:${ws.port}/socket');socket.binaryType='arraybuffer';let text=false;socket.onopen=()=>socket.send('hello');socket.onmessage=event=>{if(typeof event.data==='string'){text=event.data==='hello';socket.send(new Uint8Array([0,255,128,44]))}else{console.log(JSON.stringify({text,binary:[...new Uint8Array(event.data)]}));socket.close()}};socket.onerror=()=>process.exit(1);setTimeout(()=>process.exit(1),5000).unref()`,
        ),
      ).toEqual({ text: true, binary: [0, 255, 128, 44] });
      expect(received).toBe("Bearer synthetic-host-only-one");
      session.update({
        ...config,
        credentialSecrets: { HOST_SECRET: "synthetic-host-only-two" },
      });
      expect(await run(request)).toBe("accepted");
      expect(received).toBe("Bearer synthetic-host-only-two");
      session.update({ ...config, policy: "deny-all" });
      expect(
        await run(
          `try{const r=await fetch('https://api.example.test:${port}/',{signal:AbortSignal.timeout(3000)});console.log(JSON.stringify(!r.ok))}catch{console.log('true')}`,
        ),
      ).toBe(true);
      expect(
        await run(
          `try{await fetch('https://example.com',{proxy:null,signal:AbortSignal.timeout(2000)});console.log('false')}catch{console.log('true')}`,
        ),
      ).toBe(true);
    } finally {
      await session?.close();
      if (id) await backend.delete(id);
      ws.stop(true);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tcp.close();
      udp.close();
    }
  },
  180000,
);
