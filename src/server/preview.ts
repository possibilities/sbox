import type { Execution } from "../backend.ts";
import { SboxError, invariant } from "../errors.ts";
import type { SandboxService } from "./service.ts";

/** Fetch within the VM so previews also work when Hypeman is on another machine. */
const FETCH_SCRIPT = String.raw`
const meta=JSON.parse(Buffer.from(process.argv.at(-1),'base64url').toString());
const body=await Bun.stdin.arrayBuffer();
const r=await fetch(meta.url,{method:meta.method,headers:meta.headers,body:['GET','HEAD'].includes(meta.method)?undefined:body,redirect:'manual',decompress:false});
process.stdout.write(JSON.stringify({status:r.status,headers:[...r.headers]})+'\n');
if(r.body)for await(const chunk of r.body){if(!process.stdout.write(chunk))await new Promise(resolve=>process.stdout.once('drain',resolve));}
`;
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
export async function preview(
  service: SandboxService,
  request: Request,
  sandboxId: string,
  port: number,
  stripAuthorization = false,
  externalUrl?: URL,
): Promise<Response> {
  const sandbox = service.get(sandboxId);
  invariant(
    sandbox.ports.includes(port),
    "PORT_NOT_EXPOSED",
    "This port is not exposed",
    404,
  );
  const s = await service.resume(sandboxId),
    url = externalUrl ?? new URL(request.url);
  const headers = [...request.headers].filter(
    ([name]) =>
      !HOP_HEADERS.has(name.toLowerCase()) &&
      name.toLowerCase() !== "cookie" &&
      (!stripAuthorization || name.toLowerCase() !== "authorization"),
  );
  // Keep application cookies, remove only the preview access credential.
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .filter((x) => !x.startsWith("sbox_preview="))
    .join("; ");
  if (cookie) headers.push(["cookie", cookie]);
  headers.push(
    ["host", url.host],
    ["x-forwarded-host", url.host],
    ["x-forwarded-proto", url.protocol.slice(0, -1)],
  );
  const meta = {
    url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
    method: request.method,
    headers,
  };
  const exec = await service.execute(s.instanceId!, {
    cmd: "bun",
    args: [
      "-e",
      FETCH_SCRIPT,
      "--",
      Buffer.from(JSON.stringify(meta)).toString("base64url"),
    ],
    cwd: "/vercel/sandbox",
    env: {},
    user: "sandbox",
    stdin: true,
  });
  void exec.exited.catch(() => {});
  const abort = () => {
    void exec.kill("SIGKILL").catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  void exec.exited
    .finally(() => request.signal.removeEventListener("abort", abort))
    .catch(() => {});
  try {
    if (request.signal.aborted)
      throw new SboxError(
        "CLIENT_DISCONNECTED",
        "Preview client disconnected",
        499,
      );
    const body = await request.arrayBuffer();
    invariant(
      body.byteLength <= 16 * 1024 * 1024,
      "PAYLOAD_TOO_LARGE",
      "Preview request exceeds 16 MiB",
      413,
    );
    for (let i = 0; i < body.byteLength; i += 64 * 1024)
      await exec.write(new Uint8Array(body.slice(i, i + 64 * 1024)));
    await exec.closeStdin();
    const output = exec.output[Symbol.asyncIterator]();
    let pending = Buffer.alloc(0),
      errors = "";
    let response: { status: number; headers: string[][] } | undefined;
    while (!response) {
      const next = await output.next();
      if (next.done)
        throw new SboxError(
          "PREVIEW_UNAVAILABLE",
          errors || "The guest service is not listening on the exposed port",
          502,
        );
      if (next.value.stream === "stderr") {
        errors = (errors + Buffer.from(next.value.data).toString()).slice(
          -8192,
        );
        continue;
      }
      pending = Buffer.concat([pending, Buffer.from(next.value.data)]);
      const line = pending.indexOf(10);
      invariant(
        pending.byteLength <= 1024 * 1024,
        "PREVIEW_PROTOCOL",
        "Invalid guest HTTP response",
        502,
      );
      if (line >= 0) {
        response = JSON.parse(pending.subarray(0, line).toString());
        pending = pending.subarray(line + 1);
      }
    }
    const responseHeaders = new Headers(
      response.headers.filter(
        ([key]) => key && !HOP_HEADERS.has(key.toLowerCase()),
      ) as [string, string][],
    );
    // The guest fetch body can be re-framed; let Bun choose the outgoing framing.
    responseHeaders.delete("content-length");
    const location = responseHeaders.get("location");
    if (location) {
      try {
        const redirect = new URL(location, meta.url);
        if (
          ["127.0.0.1", "localhost"].includes(redirect.hostname) &&
          redirect.port === String(port)
        ) {
          redirect.protocol = url.protocol;
          redirect.host = url.host;
          responseHeaders.set("location", redirect.toString());
        }
      } catch {}
    }
    const initial = pending;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (initial.length) controller.enqueue(initial);
      },
      async pull(controller) {
        try {
          while (true) {
            const next = await output.next();
            if (next.done) {
              const result = await exec.exited;
              if (result.exitCode !== 0)
                throw Error("Guest preview stream failed");
              controller.close();
              return;
            }
            if (next.value.stream === "stdout") {
              controller.enqueue(next.value.data);
              return;
            }
          }
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await exec.kill("SIGKILL").catch(() => {});
      },
    });
    if (
      request.method === "HEAD" ||
      [204, 205, 304].includes(response.status)
    ) {
      await stream.cancel();
      return new Response(null, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    return new Response(stream, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (e) {
    await exec.kill("SIGKILL").catch(() => {});
    throw e;
  }
}

export const WS_PROXY_SCRIPT = String.raw`
const {createInterface}=require('node:readline');
const opts=JSON.parse(Buffer.from(process.argv.at(-1),'base64url').toString());
const ws=new WebSocket(opts.url,{headers:opts.headers,protocols:opts.protocols});ws.binaryType='arraybuffer';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
ws.addEventListener('open',()=>send({type:'open',protocol:ws.protocol}));
ws.addEventListener('message',e=>send({type:'message',binary:typeof e.data!=='string',data:Buffer.from(typeof e.data==='string'?e.data:new Uint8Array(e.data)).toString('base64')}));
ws.addEventListener('error',()=>{send({type:'error'});process.exit(1)});
ws.addEventListener('close',e=>{send({type:'close',code:e.code,reason:e.reason});process.exit(0)});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='message'){const data=Buffer.from(m.data,'base64');ws.send(m.binary?data:data.toString());}else if(m.type==='close')ws.close(m.code,m.reason)});
process.stdin.on('end',()=>{ws.close();process.exit(0)});
`;
export interface PreviewSocket {
  execution: Execution;
  iterator: AsyncIterator<{ stream: "stdout" | "stderr"; data: Uint8Array }>;
  pending: string;
  decoder: TextDecoder;
  protocol: string;
}
export async function openPreviewSocket(
  service: SandboxService,
  sandboxId: string,
  port: number,
  request: Request,
  stripAuthorization = false,
  externalUrl?: URL,
): Promise<PreviewSocket> {
  const s = await service.resume(sandboxId);
  invariant(
    s.ports.includes(port),
    "PORT_NOT_EXPOSED",
    "Port is not exposed",
    404,
  );
  const url = externalUrl ?? new URL(request.url),
    headers = Object.fromEntries(
      [...request.headers].filter(
        ([key]) =>
          !HOP_HEADERS.has(key) &&
          !key.startsWith("sec-websocket-") &&
          key !== "cookie" &&
          (!stripAuthorization || key !== "authorization"),
      ),
    );
  headers.host = url.host;
  headers["x-forwarded-host"] = url.host;
  headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .filter((x) => !x.startsWith("sbox_preview="))
    .join("; ");
  if (cookie) headers.cookie = cookie;
  const protocols =
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  const execution = await service.execute(s.instanceId!, {
    cmd: "bun",
    args: [
      "-e",
      WS_PROXY_SCRIPT,
      "--",
      Buffer.from(
        JSON.stringify({
          url: `ws://127.0.0.1:${port}${url.pathname}${url.search}`,
          headers,
          protocols,
        }),
      ).toString("base64url"),
    ],
    cwd: "/vercel/sandbox",
    env: {},
    user: "sandbox",
    stdin: true,
  });
  void execution.exited.catch(() => {});
  const abort = () => {
    void execution.kill("SIGKILL").catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  const iterator = execution.output[Symbol.asyncIterator](),
    decoder = new TextDecoder();
  let pending = "";
  try {
    if (request.signal.aborted)
      throw new SboxError(
        "CLIENT_DISCONNECTED",
        "Preview client disconnected",
        499,
      );
    for (;;) {
      const event = await iterator.next();
      if (event.done)
        throw new SboxError(
          "PREVIEW_UNAVAILABLE",
          "Guest WebSocket handshake failed",
          502,
        );
      if (event.value.stream !== "stdout") continue;
      pending += decoder.decode(event.value.data, { stream: true });
      invariant(
        pending.length < 4 * 1024 * 1024,
        "FRAME_LIMIT",
        "Preview handshake is too large",
        502,
      );
      const index = pending.indexOf("\n");
      if (index < 0) continue;
      const frame = JSON.parse(pending.slice(0, index));
      pending = pending.slice(index + 1);
      invariant(
        frame.type === "open",
        "PREVIEW_UNAVAILABLE",
        "Guest WebSocket handshake failed",
        502,
      );
      return {
        execution,
        iterator,
        pending,
        decoder,
        protocol: frame.protocol ?? "",
      };
    }
  } catch (error) {
    await execution.kill("SIGKILL").catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
