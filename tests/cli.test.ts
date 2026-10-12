import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createOptions } from "../src/cli/index.ts";
import { copyPath, uploadProgram } from "../src/cli/copy.ts";
import type { Sandbox } from "../src/index.ts";
import { describe, expect, test } from "bun:test";
import {
  parseArgs,
  flag,
  enabled,
  numberFlag,
  parseEnvFile,
  pairs,
} from "../src/cli/args.ts";
import { harnessCommand } from "../src/harnesses/index.ts";
import {
  createMcpHandler,
  sdkMcpOperations,
  mcpTools,
  type McpOperations,
} from "../src/cli/mcp.ts";
import type { CommandRecord, SandboxRecord } from "../src/types.ts";

describe("CLI argument boundaries", () => {
  test("preserves guest argv and shell metacharacters without evaluation", () => {
    const args = parseArgs([
      "--url=http://localhost:7070",
      "exec",
      "sbx_test",
      "--env",
      "TOKEN=a=b",
      "--",
      "bun",
      "--version",
      "$(touch /tmp/nope)",
      "--env",
      "UNCHANGED",
    ]);
    expect(args.positionals).toEqual(["exec", "sbx_test"]);
    expect(args.command).toEqual([
      "bun",
      "--version",
      "$(touch /tmp/nope)",
      "--env",
      "UNCHANGED",
    ]);
    expect(flag(args, "url")).toBe("http://localhost:7070");
    expect(pairs(args.flags.get("env")!, "--env")).toEqual({ TOKEN: "a=b" });
  });
  test("rejects unknown options, missing values, and invalid numbers", () => {
    expect(() => parseArgs(["--typo"])).toThrow("Unknown option");
    expect(() => parseArgs(["--url", "--json"])).toThrow("requires a value");
    expect(() =>
      numberFlag(parseArgs(["--timeout", "NaN"]), "timeout"),
    ).toThrow();
    expect(() =>
      numberFlag(parseArgs(["--timeout", "-1"]), "timeout"),
    ).toThrow();
    expect(enabled(parseArgs(["-i", "--json=false"]), "stdin")).toBe(true);
  });
  test("env files preserve literal credentials and do not expand host variables", () => {
    expect(
      parseEnvFile(
        "# comment\nexport TOKEN='$(secret)'\nURL=https://a?b=c\nEMPTY=\nVALUE=hello # comment\nQUOTED=\"a\\nb\"\n",
      ),
    ).toEqual({
      TOKEN: "$(secret)",
      URL: "https://a?b=c",
      EMPTY: "",
      VALUE: "hello",
      QUOTED: "a\nb",
    });
    expect(() => parseEnvFile("INVALID LINE")).toThrow("line 1");
    expect(() => parseEnvFile("TOKEN='unterminated")).toThrow("Unclosed quote");
    expect(() => pairs(["bad-key=value"], "--env")).toThrow(
      "Invalid environment",
    );
  });
});

describe("harness adapters", () => {
  test("Codex exec preserves prompt boundary and only explicit env", () => {
    const command = harnessCommand({
      harness: "codex",
      prompt: "--malicious-flag",
      env: { CODEX_API_KEY: "explicit" },
    });
    expect(command.cmd).toBe("codex");
    expect(command.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--",
      "--malicious-flag",
    ]);
    expect(command.env).toEqual({ CODEX_API_KEY: "explicit" });
    expect(command.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });
  test("preserves protocol stdout through actual stdio modes", () => {
    expect(harnessCommand({ harness: "codex", mode: "stdio" }).args).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(harnessCommand({ harness: "claude", mode: "stdio" }).args).toContain(
      "--input-format",
    );
    expect(harnessCommand({ harness: "opencode", mode: "acp" })).toMatchObject({
      cmd: "opencode",
      args: ["acp"],
      stdin: true,
    });
    expect(
      harnessCommand({
        harness: "generic",
        mode: "stdio",
        command: "my-mcp",
        args: ["--flag"],
      }),
    ).toMatchObject({ cmd: "my-mcp", args: ["--flag"], stdin: true });
  });
  test("rejects unsupported modes rather than inventing protocol compatibility", () => {
    expect(() => harnessCommand({ harness: "codex", mode: "acp" })).toThrow(
      "does not support",
    );
    expect(() => harnessCommand({ harness: "generic" })).toThrow(
      "requires a command",
    );
    expect(() =>
      harnessCommand({ harness: "opencode", mode: "acp", prompt: "bad" }),
    ).toThrow("stdin");
  });
});

describe("MCP JSON-RPC", () => {
  const calls: Array<{ op: string; args: unknown }> = [];
  const operations = Object.fromEntries(
    [
      "create",
      "list",
      "get",
      "exec",
      "commands",
      "poll",
      "kill",
      "read",
      "write",
      "stop",
      "resume",
      "delete",
    ].map((op) => [
      op,
      async (args: unknown) => {
        calls.push({ op, args });
        return { ok: true };
      },
    ]),
  ) as unknown as McpOperations;
  const handle = createMcpHandler(operations);
  test("initializes with negotiated protocol and lists tool schemas", async () => {
    expect(
      await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    ).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
      },
    });
    const result = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect((result?.result as { tools: unknown[] }).tools).toHaveLength(
      mcpTools.length,
    );
    expect(
      await handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
  });
  test("dispatches valid requests and preserves IDs", async () => {
    const response = await handle({
      jsonrpc: "2.0",
      id: "exec-1",
      method: "tools/call",
      params: {
        name: "sandbox_exec",
        arguments: { sandboxId: "sbx_test", cmd: "printf", args: ["hi"] },
      },
    });
    expect(response).toMatchObject({
      id: "exec-1",
      result: { content: [{ type: "text", text: '{"ok":true}' }] },
    });
    expect(calls.at(-1)).toEqual({
      op: "exec",
      args: { sandboxId: "sbx_test", cmd: "printf", args: ["hi"] },
    });
  });
  test("rejects invalid requests and bounds inputs before invoking execution", async () => {
    expect(await handle({ method: "tools/list" })).toMatchObject({
      error: { code: -32600 },
    });
    expect(
      await handle({ jsonrpc: "2.0", id: 1, method: "bogus" }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "missing" },
      }),
    ).toMatchObject({ error: { code: -32602 } });
    const count = calls.length;
    for (const args of [
      { sandboxId: "id", cmd: "sh", timeoutMs: 86400001 },
      { sandboxId: "id", cmd: "sh", host: true },
      { sandboxId: "id", cmd: "sh", args: ["\0"] },
    ]) {
      expect(
        await handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "sandbox_exec", arguments: args },
        }),
      ).toMatchObject({ result: { isError: true } });
    }
    expect(calls).toHaveLength(count);
  });
});

describe("CLI process integration", () => {
  test("snapshot creation inherits configuration instead of sending empty overrides", async () => {
    let params: unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        params = ((await request.json()) as { params: unknown }).params;
        return Response.json({ result: { sandboxId: "sbx_restored" } });
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--url",
        server.url.toString(),
        "create",
        "--snapshot",
        "snap_test",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("sbx_restored\n");
      expect(params).toEqual({
        source: { type: "snapshot", snapshotId: "snap_test" },
      });
    } finally {
      child.kill();
      server.stop(true);
    }
  });

  test("remote execution preserves argv, streams, auth, stdin EOF, and exit codes", async () => {
    const sandbox = {
      sandboxId: "sbx_remote",
      name: "remote",
      status: "running",
      sessionId: "ses_remote",
      persistent: false,
    } as SandboxRecord;
    const command: CommandRecord = {
      commandId: "cmd_remote",
      sandboxId: sandbox.sandboxId,
      sessionId: "ses_remote",
      cmd: "guest-only",
      args: [],
      cwd: "/vercel/sandbox",
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    let stdin = "";
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== "Bearer test-secret")
          return new Response("Unauthorized", { status: 401 });
        if (new URL(request.url).pathname.endsWith("/logs")) {
          return new Response(
            new ReadableStream({
              async start(controller) {
                await complete;
                for (const event of [
                  {
                    sequence: 1,
                    timestamp: Date.now(),
                    stream: "stdout",
                    data: Buffer.from(stdin).toString("base64"),
                  },
                  {
                    sequence: 2,
                    timestamp: Date.now(),
                    stream: "stderr",
                    data: Buffer.from("guest stderr\n").toString("base64"),
                  },
                  { type: "done", command },
                ])
                  controller.enqueue(
                    new TextEncoder().encode(`${JSON.stringify(event)}\n`),
                  );
                controller.close();
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        }
        const body = (await request.json()) as {
          method: string;
          params: Record<string, unknown>;
        };
        calls.push(body);
        switch (body.method) {
          case "sandbox.get":
            return Response.json({ result: sandbox });
          case "command.run":
            return Response.json({ result: command });
          case "command.stdin":
            stdin += Buffer.from(
              body.params.data as string,
              "base64",
            ).toString();
            return Response.json({ result: null });
          case "command.closeStdin":
            command.status = "exited";
            command.exitCode = 7;
            finish();
            return Response.json({ result: null });
          case "command.wait":
            await complete;
            return Response.json({ result: command });
          default:
            return Response.json(
              { error: { message: `Unexpected ${body.method}` } },
              { status: 400 },
            );
        }
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--url",
        server.url.toString(),
        "--token",
        "test-secret",
        "exec",
        "sbx_remote",
        "--stdin",
        "--",
        "guest-only",
        "--unknown-guest-flag",
        "$(do-not-run)",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      child.stdin.write("input sent into guest\n");
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(7);
      expect(stdout).toBe("input sent into guest\n");
      expect(stderr).toBe("guest stderr\n");
      expect(
        calls.find((call) => call.method === "command.run")?.params,
      ).toMatchObject({
        cmd: "guest-only",
        args: ["--unknown-guest-flag", "$(do-not-run)"],
        stdin: true,
        detached: true,
      });
    } finally {
      child.kill();
      server.stop(true);
    }
  }, 10_000);

  test("MCP stdout contains only protocol messages, including parse errors", async () => {
    const child = Bun.spawn([process.execPath, "src/cli/index.ts", "mcp"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\ninvalid-json\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    );
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const responses = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(responses).toHaveLength(3);
    expect(
      responses.find((response) => response.id === 1)?.result.serverInfo.name,
    ).toBe("sbox");
    expect(responses.find((response) => response.id === null)?.error.code).toBe(
      -32700,
    );
    expect(
      responses.find((response) => response.id === 2)?.result.tools,
    ).toHaveLength(mcpTools.length);
  });

  test("an early guest exit does not hang stdin forwarding or turn EOF into a CLI error", async () => {
    const command = {
      commandId: "cmd_early",
      sandboxId: "sbx_early",
      status: "exited",
      exitCode: 0,
    };
    const calls: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/logs")) {
          await Bun.sleep(15);
          return new Response(`${JSON.stringify({ type: "done", command })}\n`);
        }
        const body = (await request.json()) as { method: string };
        calls.push(body.method);
        if (body.method === "sandbox.get")
          return Response.json({
            result: { sandboxId: "sbx_early", status: "running" },
          });
        if (body.method === "command.run" || body.method === "command.wait")
          return Response.json({ result: command });
        return Response.json(
          {
            error: {
              code: "COMMAND_ENDED",
              message: "Command is no longer running",
            },
          },
          { status: 409 },
        );
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--url",
        server.url.toString(),
        "exec",
        "sbx_early",
        "--stdin",
        "--",
        "true",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write("ignored after guest exit");
    child.stdin.end();
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(calls).toContain("command.stdin");
      expect(calls).not.toContain("command.kill");
    } finally {
      child.kill();
      server.stop(true);
    }
  });

  test("PTY preserves binary output and process exit status when local stdin ends", async () => {
    const output = Buffer.from([0, 255, 195, 169, 10]);
    let sentEof = false;
    let start: unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        if (new URL(request.url).pathname === "/terminal") {
          if (server.upgrade(request)) return;
          return new Response("Upgrade required", { status: 426 });
        }
        const body = (await request.json()) as { method: string };
        if (body.method === "sandbox.get")
          return Response.json({
            result: { sandboxId: "sbx_pty", status: "running" },
          });
        if (body.method === "sandbox.openInteractive")
          return Response.json({
            result: {
              url: `ws://127.0.0.1:${server.port}/terminal`,
              token: "ticket",
            },
          });
        return new Response("Unexpected method", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message === "string") {
            start = JSON.parse(message);
            socket.send(output);
            setTimeout(() => {
              socket.send(JSON.stringify({ type: "exit", code: 23 }));
              socket.close(1000);
            }, 25);
          } else sentEof ||= Buffer.from(message).equals(Buffer.from([4]));
        },
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "--url",
        server.url.toString(),
        "connect",
        "sbx_pty",
        "--",
        "bash",
        "-l",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.end();
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(23);
      expect(stderr).toBe("");
      expect(Buffer.from(stdout)).toEqual(output);
      expect(start).toMatchObject({ type: "start", cols: 80, rows: 24 });
      expect(sentEof).toBe(true);
    } finally {
      child.kill();
      server.stop(true);
    }
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const rpc = (
  id: string | number,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("MCP command ownership and cancellation", () => {
  test("cancelling during command creation kills the accepted remote command before returning", async () => {
    const accepted = deferred(),
      release = deferred();
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(body.method);
        if (body.method === "sandbox.get")
          return Response.json({
            result: { sandboxId: "sbx-race", status: "running" },
          });
        if (body.method === "command.run") {
          accepted.resolve();
          await release.promise;
          return Response.json({
            result: {
              commandId: "cmd-race",
              sandboxId: "sbx-race",
              status: "running",
              exitCode: null,
            },
          });
        }
        if (body.method === "command.kill") {
          expect(body.params.signal).toBe("SIGKILL");
          return Response.json({ result: null });
        }
        throw new Error(`Unexpected ${body.method}`);
      },
    });
    const handle = createMcpHandler(
      sdkMcpOperations({ baseUrl: server.url.toString() }),
    );
    try {
      const running = handle(
        rpc("work", "sandbox_exec", {
          sandboxId: "sbx-race",
          cmd: "sleep",
          args: ["60"],
        }),
      );
      await accepted.promise;
      expect(
        await handle({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "work" },
        }),
      ).toBeUndefined();
      release.resolve();
      expect(await running).toBeUndefined();
      expect(methods.slice(-2)).toEqual(["command.run", "command.kill"]);
    } finally {
      release.resolve();
      handle.close();
      server.stop(true);
    }
  });

  test("transport close cancels attached work while completed detached jobs survive", async () => {
    const started = deferred();
    let aborted = false;
    const handle = createMcpHandler({
      exec: async (_args, { signal }) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { completed: true };
      },
    } as McpOperations);
    const pending = handle(
      rpc(1, "sandbox_exec", { sandboxId: "sbx-job", cmd: "sleep" }),
    );
    await started.promise;
    expect(
      await handle(
        rpc(1, "sandbox_exec", { sandboxId: "sbx-job", cmd: "sleep" }),
      ),
    ).toMatchObject({ error: { code: -32600 } });
    handle.close();
    expect(await pending).toBeUndefined();
    expect(aborted).toBe(true);

    let detachedSignal: AbortSignal | undefined;
    const detached = createMcpHandler({
      exec: async (_args, { signal }) => {
        detachedSignal = signal;
        return { commandId: "cmd-durable" };
      },
    } as McpOperations);
    expect(
      await detached(
        rpc(2, "sandbox_exec", {
          sandboxId: "sbx-job",
          cmd: "sleep",
          detached: true,
        }),
      ),
    ).toMatchObject({
      result: { content: [{ text: '{"commandId":"cmd-durable"}' }] },
    });
    detached.close();
    expect(detachedSignal?.aborted).toBe(false);
  });

  test("polling resumes within a large binary log without loss, and lifecycle listings omit secrets", async () => {
    const output = Buffer.alloc(160_001);
    for (let i = 0; i < output.length; i++) output[i] = i % 256;
    const sandbox = {
      sandboxId: "sbx-poll",
      status: "running",
      env: { PRIVATE: "never-return" },
    };
    const command = {
      commandId: "cmd-poll",
      sandboxId: "sbx-poll",
      status: "exited",
      exitCode: 0,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { method, params } = (await request.json()) as {
          method: string;
          params: Record<string, unknown>;
        };
        if (method === "sandbox.get")
          return Response.json({
            result: { ...sandbox, sandboxId: params.id },
          });
        if (method === "sandbox.list")
          return Response.json({
            result: { items: [sandbox], nextCursor: "next" },
          });
        if (method === "command.get") return Response.json({ result: command });
        if (method === "command.poll")
          return Response.json({
            result: {
              command,
              logs:
                Number(params.after ?? 0) < 1
                  ? [
                      {
                        sequence: 1,
                        stream: "stdout",
                        data: output.toString("base64"),
                        timestamp: 0,
                      },
                    ]
                  : [],
              nextCursor: 1,
              hasMore: false,
              lastSequence: 1,
            },
          });
        throw new Error(`Unexpected ${method}`);
      },
    });
    const ops = sdkMcpOperations({ baseUrl: server.url.toString() });
    const context = { signal: new AbortController().signal };
    try {
      let cursor = { after: 0, offset: 0 };
      const chunks: Buffer[] = [];
      for (let i = 0; i < 3; i++) {
        const response = (await ops.poll(
          { sandboxId: "sbx-poll", commandId: "cmd-poll", ...cursor },
          context,
        )) as {
          logs: Array<{ data: string }>;
          nextCursor: typeof cursor;
          hasMore: boolean;
        };
        const data = Buffer.concat(
          response.logs.map((log) => Buffer.from(log.data, "base64")),
        );
        expect(data.length).toBeLessThanOrEqual(65536);
        chunks.push(data);
        cursor = response.nextCursor;
        expect(response.hasMore).toBe(i !== 2);
      }
      expect(Buffer.concat(chunks)).toEqual(output);
      expect(cursor).toEqual({ after: 1, offset: 0 });
      expect(JSON.stringify(await ops.list({}, context))).not.toContain(
        "never-return",
      );
      expect(
        JSON.stringify(await ops.get({ sandboxId: "sbx-poll" }, context)),
      ).not.toContain("PRIVATE");
      await expect(
        ops.poll({ sandboxId: "sbx-other", commandId: "cmd-poll" }, context),
      ).rejects.toThrow("does not belong");
    } finally {
      server.stop(true);
    }
  });
});

describe("detached CLI lifecycle", () => {
  test("list, finite log replay, wait, signals, and attach never re-execute a job", async () => {
    const methods: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const command = {
      commandId: "cmd-background",
      sandboxId: "sbx-background",
      cmd: "original",
      args: [],
      status: "running",
      exitCode: null,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/logs")) {
          expect(url.searchParams.get("after")).toBe("1");
          return new Response(
            `${JSON.stringify({ sequence: 2, stream: "stdout", data: Buffer.from("attached\n").toString("base64"), timestamp: 0 })}\n${JSON.stringify({ type: "done", command: { ...command, status: "exited", exitCode: 9 } })}\n`,
          );
        }
        const body = (await request.json()) as {
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(body);
        switch (body.method) {
          case "sandbox.get":
            return Response.json({
              result: { sandboxId: "sbx-background", status: "stopped" },
            });
          case "command.list":
            return Response.json({
              result: { items: [command], nextCursor: null },
            });
          case "command.get":
            return Response.json({ result: command });
          case "command.poll":
            return Response.json({
              result: {
                command,
                logs: [
                  {
                    sequence: Number(body.params.after) + 1,
                    stream: "stdout",
                    data: Buffer.from(
                      `log${Number(body.params.after) + 1}\n`,
                    ).toString("base64"),
                    timestamp: 0,
                  },
                ],
                nextCursor: Number(body.params.after) + 1,
                hasMore: true,
                lastSequence: Number(body.params.after) ? 999 : 2,
              },
            });
          case "command.wait":
            return Response.json({
              result: { ...command, status: "exited", exitCode: 9 },
            });
          case "command.kill":
            return Response.json({ result: null });
          default:
            throw new Error(`Unexpected ${body.method}`);
        }
      },
    });
    const run = async (...args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/cli/index.ts",
          "--url",
          server.url.toString(),
          ...args,
        ],
        {
          cwd: new URL("..", import.meta.url).pathname,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      return { stdout, code };
    };
    try {
      expect(
        (await run("commands", "sbx-background", "--json")).stdout,
      ).toContain("cmd-background");
      expect(await run("logs", "sbx-background", "cmd-background")).toEqual({
        stdout: "log1\nlog2\n",
        code: 0,
      });
      expect(await run("wait", "sbx-background", "cmd-background")).toEqual({
        stdout: "",
        code: 9,
      });
      expect(
        await run(
          "kill",
          "sbx-background",
          "cmd-background",
          "--signal",
          "SIGINT",
        ),
      ).toEqual({ stdout: "", code: 0 });
      expect(
        methods.find((call) => call.method === "command.kill")?.params,
      ).toMatchObject({ id: "cmd-background", signal: "SIGINT" });
      expect(
        await run("attach", "sbx-background", "cmd-background", "--after", "1"),
      ).toEqual({ stdout: "attached\n", code: 9 });
      expect(methods.some((call) => call.method === "command.run")).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("streamed workspace copies", () => {
  // A filesystem fixture stands in for the guest. Only the fixed upload helper
  // runs here; no supplied command or archive entry is evaluated on the host.
  const guest = (cwd: string) =>
    ({
      cwd,
      fs,
      async readFile({ path }: { path: string }) {
        return createReadStream(path);
      },
      async runCommand(options: {
        cmd: string;
        args: string[];
        stdin: Readable;
      }) {
        expect(options.args[1]).toBe(uploadProgram);
        const child = Bun.spawn([process.execPath, ...options.args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = new Response(child.stderr).text();
        const pump = (async () => {
          for await (const chunk of options.stdin) {
            child.stdin.write(chunk);
            await child.stdin.flush();
          }
          child.stdin.end();
        })();
        return {
          async wait() {
            await pump;
            return { exitCode: await child.exited, stderr: () => stderr };
          },
          async kill() {
            child.kill();
          },
        };
      },
    }) as unknown as Sandbox;

  test("round-trips a large binary tree, executable mode, empty directory, and internal symlink", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "sbox-copy-test-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote"),
        result = join(root, "result");
      await fs.mkdir(join(source, "empty"), { recursive: true });
      await fs.mkdir(remote);
      const data = Buffer.alloc(20 * 1024 * 1024 + 7);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      await fs.writeFile(join(source, "binary.bin"), data);
      await fs.writeFile(join(source, "executable"), "#!/bin/sh\necho test\n", {
        mode: 0o751,
      });
      await fs.symlink("binary.bin", join(source, "link"));
      const sandbox = guest(remote);
      await copyPath(sandbox, "upload", source, join(remote, "tree"), {
        recursive: true,
      });
      await copyPath(sandbox, "download", join(remote, "tree"), result, {
        recursive: true,
      });
      expect(await fs.readFile(join(result, "binary.bin"))).toEqual(data);
      expect((await fs.stat(join(result, "executable"))).mode & 0o777).toBe(
        0o751,
      );
      expect((await fs.stat(join(result, "empty"))).isDirectory()).toBe(true);
      expect(await fs.readlink(join(result, "link"))).toBe("binary.bin");
      expect(
        (await fs.readdir(result)).some((name) => name.startsWith(".sbox-")),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects escaping links and existing destination symlinks without touching outside files", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "sbox-copy-test-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote"),
        outside = join(root, "outside");
      await fs.mkdir(source);
      await fs.mkdir(remote);
      await fs.writeFile(outside, "untouched");
      await fs.symlink("../outside", join(source, "escape"));
      await expect(
        copyPath(guest(remote), "upload", source, "tree", { recursive: true }),
      ).rejects.toThrow("outside");
      await fs.unlink(join(source, "escape"));
      await fs.writeFile(join(source, "safe"), "replacement");
      const destination = join(root, "destination");
      await fs.mkdir(destination);
      await fs.symlink(outside, join(destination, "safe"));
      await expect(
        copyPath(guest(remote), "download", source, destination, {
          recursive: true,
        }),
      ).rejects.toThrow("symlink");
      expect(await fs.readFile(outside, "utf8")).toBe("untouched");
      await expect(
        copyPath(guest(remote), "upload", source, "tree"),
      ).rejects.toThrow("--recursive");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a truncated download preserves the previous file and removes its temporary file", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "sbox-copy-test-"));
    try {
      const source = join(root, "source"),
        destination = join(root, "destination");
      await fs.writeFile(source, "long original data");
      await fs.writeFile(destination, "previous");
      const sandbox = guest(root);
      sandbox.readFile = async () => Readable.from([Buffer.from("short")]);
      await expect(
        copyPath(sandbox, "download", source, destination),
      ).rejects.toThrow("changed during download");
      expect(await fs.readFile(destination, "utf8")).toBe("previous");
      expect((await fs.readdir(root)).sort()).toEqual([
        "destination",
        "source",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("MCP stdin EOF terminates an attached guest command and finishes cleanup", async () => {
  const streaming = deferred();
  let killed = false;
  const command = {
    commandId: "cmd-eof",
    sandboxId: "sbx-eof",
    status: "running",
    exitCode: null,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/logs")) {
        streaming.resolve();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ sequence: 1, stream: "stdout", data: "", timestamp: 0 })}\n`,
                ),
              );
            },
          }),
        );
      }
      const { method } = (await request.json()) as { method: string };
      if (method === "sandbox.get")
        return Response.json({
          result: { sandboxId: "sbx-eof", status: "running" },
        });
      if (method === "command.run") return Response.json({ result: command });
      if (method === "command.kill") {
        killed = true;
        return Response.json({ result: null });
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "src/cli/index.ts",
      "--url",
      server.url.toString(),
      "mcp",
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    child.stdin.write(
      `${JSON.stringify(rpc(1, "sandbox_exec", { sandboxId: "sbx-eof", cmd: "long-task" }))}\n`,
    );
    await streaming.promise;
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(killed).toBe(true);
  } finally {
    child.kill();
    server.stop(true);
  }
}, 10_000);

test("internal lease worker failures never print private configuration", async () => {
  const child = Bun.spawn(
    [process.execPath, "src/cli/index.ts", "__lease-worker"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write('{"apiKey":"private-config-test",malformed');
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("MCP enforces the text-write byte limit for multibyte content", async () => {
  let written = false;
  const handler = createMcpHandler({
    write: async () => {
      written = true;
      return {};
    },
  } as unknown as McpOperations);
  const result = await handler(
    rpc(1, "sandbox_write_file", {
      sandboxId: "sbx-bounds",
      path: "/file",
      content: "界".repeat(200000),
    }),
  );
  expect(result).toMatchObject({ result: { isError: true } });
  expect(written).toBe(false);
});

test("compiled CLI starts its private lease worker without bun on PATH", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "sbox-compiled-cli-"));
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json([]);
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const binary = join(root, "sbox");
  let canonicalBinary = binary;
  // The detached worker deliberately outlives `serve`. Keep its SQLite/WAL files
  // until it observes the released owner marker and exits normally.
  const ownedWorkers = async (): Promise<number[]> => {
    const listing = Bun.spawn(["ps", "-axo", "pid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, code] = await Promise.all([
      new Response(listing.stdout).text(),
      listing.exited,
    ]);
    await new Response(listing.stderr).text();
    if (code !== 0)
      throw new Error("Unable to inspect owned compiled test workers");
    return output.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (
        !match ||
        ![
          `${binary} __lease-worker`,
          `${canonicalBinary} __lease-worker`,
        ].includes(match[2]!)
      )
        return [];
      return [Number(match[1])];
    });
  };
  const waitForWorkers = async (timeoutMs: number): Promise<number[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = await ownedWorkers();
      if (!remaining.length || Date.now() >= deadline) return remaining;
      await Bun.sleep(50);
    }
  };
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "src/cli/index.ts",
        "--compile",
        "--outfile",
        binary,
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [buildOut, buildError, buildCode] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(buildCode, buildOut + buildError).toBe(0);
    canonicalBinary = await fs.realpath(binary);
    child = Bun.spawn(
      [
        binary,
        "serve",
        "--port",
        "0",
        "--data-dir",
        join(root, "state"),
        "--hypeman-url",
        native.url.toString(),
      ],
      {
        cwd: root,
        env: { PATH: "/nonexistent" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const running = child;
    let startup = "";
    const timeout = setTimeout(() => running.kill("SIGKILL"), 10000);
    try {
      for await (const chunk of Readable.fromWeb(
        running.stderr as unknown as Parameters<typeof Readable.fromWeb>[0],
      )) {
        startup += Buffer.from(chunk).toString();
        if (startup.includes("sbox listening on ")) break;
      }
      expect(startup).toContain("sbox listening on ");
      const url = /sbox listening on (\S+)/.exec(startup)?.[1];
      expect((await fetch(new URL("/health", url))).status).toBe(200);
      expect(await ownedWorkers()).toHaveLength(1);
    } finally {
      clearTimeout(timeout);
    }
    running.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    expect(await waitForWorkers(5000)).toEqual([]);
  } finally {
    child?.kill("SIGKILL");
    if (child) await child.exited;
    // Failed assertions must not leak a worker either. Match this exact unique
    // executable again immediately before signaling; never sweep other workers.
    for (const pid of await ownedWorkers()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    for (const pid of await waitForWorkers(1000)) {
      if ((await ownedWorkers()).includes(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    const remaining = await waitForWorkers(1000);
    await native.stop(true);
    // Leave the database available if an unexpected worker could not be stopped.
    if (!remaining.length) await fs.rm(root, { recursive: true, force: true });
    expect(remaining).toEqual([]);
  }
}, 30000);

describe("full CLI configuration", () => {
  async function withFiles(run: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(join(tmpdir(), "sbox-cli-config-"));
    try {
      await run(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  test("only explicit flags override configuration and maps merge at their entry boundary", async () => {
    await withFiles(async (directory) => {
      const config = join(directory, "sandbox.json");
      const secrets = join(directory, "secrets.json");
      const env = join(directory, "guest.env");
      const policy = {
        allow: {
          "api.example.com": [
            {
              match: { path: { startsWith: "/v1/" } },
              transform: [{ headers: { "x-client": "sbox" } }],
            },
          ],
        },
      };
      await fs.writeFile(
        config,
        JSON.stringify({
          name: "configured",
          resources: { vcpus: 2, memoryMb: 1024, diskMb: 4096 },
          env: {
            KEEP: "literal $(never-expand)",
            CHANGE: "config",
            PATH_VALUE: "/host/path-is-not-read",
          },
          tags: { team: "tools", replace: "old" },
          mounts: {
            "/work": { drive: "repo", mode: "snapshot" },
            "/cache": { driveId: "drv-old", readOnly: false },
          },
          persistent: true,
          networkPolicy: policy,
          ports: [3000],
          keepLastSnapshots: { count: 3 },
          source: {
            type: "git",
            url: "https://example.com/repo",
            revision: "main",
          },
          credentialSecrets: { PROVIDER_KEY: "old", OTHER_KEY: "unchanged" },
          credentials: {
            API_KEY: {
              source: { env: "PROVIDER_KEY" },
              inject: [
                {
                  hosts: ["api.example.com"],
                  as: { header: "authorization", format: "Bearer ${value}" },
                },
              ],
            },
          },
        }),
      );
      await fs.writeFile(
        secrets,
        JSON.stringify({ PROVIDER_KEY: "explicit-file-secret" }),
        { mode: 0o600 },
      );
      await fs.writeFile(env, "CHANGE=file\nFROM_FILE=literal\n");
      const result = await createOptions(
        parseArgs([
          "create",
          "--config",
          config,
          "--secrets-file",
          secrets,
          "--cpu",
          "4",
          "--env-file",
          env,
          "--env",
          "CHANGE=flag",
          "--tag",
          "replace=new",
          "--mount",
          "/cache=drv-new:ro",
          "--persistent=false",
          "--ports",
          "8080",
          "--revision",
          "feature",
        ]),
      );
      expect(result.resources).toEqual({
        vcpus: 4,
        memoryMb: 1024,
        diskMb: 4096,
      });
      expect(result.env).toEqual({
        KEEP: "literal $(never-expand)",
        CHANGE: "flag",
        PATH_VALUE: "/host/path-is-not-read",
        FROM_FILE: "literal",
      });
      expect(result.tags).toEqual({ team: "tools", replace: "new" });
      expect(result.mounts).toEqual({
        "/work": { drive: "repo", mode: "snapshot" },
        "/cache": { driveId: "drv-new", readOnly: true },
      });
      expect(result.networkPolicy).toEqual(policy);
      expect(result.persistent).toBe(false);
      expect(result.ports).toEqual([8080]);
      expect(result.source).toEqual({
        type: "git",
        url: "https://example.com/repo",
        revision: "feature",
      });
      expect(result.credentialSecrets).toEqual({
        PROVIDER_KEY: "explicit-file-secret",
        OTHER_KEY: "unchanged",
      });
      expect(result.keepLastSnapshots).toEqual({ count: 3 });
      expect(
        (
          await createOptions(
            parseArgs(["create", "--config", config, "--network", "deny-all"]),
          )
        ).networkPolicy,
      ).toBe("deny-all");
    });
  });

  test("rejects connection injection, malformed files, repeated configs, and unsupported updates without leaking values", async () => {
    await withFiles(async (directory) => {
      const config = join(directory, "config.json");
      const args = () => parseArgs(["create", "--config", config]);
      for (const contents of [
        '{"token":"secret"}',
        '{"baseUrl":"https://untrusted"}',
        '{"env":[]}',
        "[]",
        "null",
      ]) {
        await fs.writeFile(config, contents);
        await expect(createOptions(args())).rejects.toThrow();
      }
      await fs.writeFile(
        config,
        '{"credentialSecrets":{"TOKEN":"do-not-print-this"},BROKEN',
      );
      let message = "";
      try {
        await createOptions(args());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("--config contains invalid JSON");
      expect(message).not.toContain("do-not-print-this");
      await fs.writeFile(config, JSON.stringify({ name: "cannot-rename" }));
      await expect(createOptions(args(), true)).rejects.toThrow(
        "Unsupported update",
      );
      await expect(
        createOptions(parseArgs(["update", "id", "--image", "new"]), true),
      ).rejects.toThrow("cannot update");
      await expect(
        createOptions(parseArgs(["update", "id"]), true),
      ).rejects.toThrow("requires");
      await expect(
        createOptions(
          parseArgs(["create", "--config", config, "--config", config]),
        ),
      ).rejects.toThrow("only once");
      await fs.writeFile(config, " ".repeat(1024 * 1024 + 1));
      await expect(createOptions(args())).rejects.toThrow("at most 1 MiB");
    });
  });

  test("real CLI forwards full create/update options and uses the drive fork API", async () => {
    await withFiles(async (directory) => {
      const createPath = join(directory, "create.json");
      const updatePath = join(directory, "update.json");
      const secretPath = join(directory, "secrets.json");
      const credential = {
        source: { env: "MODEL_KEY" },
        inject: [
          {
            hosts: ["api.example.com"],
            as: { header: "authorization", format: "Bearer ${value}" },
          },
        ],
      };
      await fs.writeFile(
        createPath,
        JSON.stringify({
          networkPolicy: { allow: ["api.example.com"] },
          credentials: { TOKEN: credential },
          mounts: {
            "/work": {
              driveId: "drv-source",
              mode: "snapshot",
              readOnly: true,
              overlay: true,
            },
          },
        }),
      );
      await fs.writeFile(
        updatePath,
        JSON.stringify({
          currentSnapshotId: "snap-restored",
          keepLastSnapshots: null,
          env: {},
          networkPolicy: "deny-all",
        }),
      );
      await fs.writeFile(
        secretPath,
        JSON.stringify({ MODEL_KEY: "explicit-file-secret" }),
        { mode: 0o600 },
      );
      const calls: Array<{ method: string; params: Record<string, unknown> }> =
        [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            method: string;
            params: Record<string, unknown>;
          };
          calls.push(body);
          const result =
            body.method === "drive.get"
              ? { driveId: "drv-source", name: "source", sizeBytes: 1024 }
              : body.method === "drive.fork"
                ? {
                    driveId: "drv-fork",
                    name: body.params.name,
                    sizeBytes: 1024,
                  }
                : {
                    sandboxId: "sbx-config",
                    name: "config",
                    status: "running",
                  };
          return Response.json({ result });
        },
      });
      const invoke = async (args: string[]) => {
        const child = Bun.spawn(
          [
            process.execPath,
            "src/cli/index.ts",
            "--url",
            server.url.toString(),
            ...args,
          ],
          {
            cwd: new URL("..", import.meta.url).pathname,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, stderr).toBe(0);
        expect(stderr).toBe("");
        return stdout;
      };
      try {
        expect(
          await invoke([
            "create",
            "--config",
            createPath,
            "--secrets-file",
            secretPath,
          ]),
        ).toBe("sbx-config\n");
        expect(calls[0]).toMatchObject({
          method: "sandbox.create",
          params: {
            networkPolicy: { allow: ["api.example.com"] },
            credentials: { TOKEN: credential },
            credentialSecrets: { MODEL_KEY: "explicit-file-secret" },
            mounts: {
              "/work": {
                driveId: "drv-source",
                mode: "snapshot",
                overlay: true,
              },
            },
          },
        });
        expect(
          await invoke(["update", "sbx-config", "--config", updatePath]),
        ).toBe("sbx-config\n");
        expect(
          calls.find((call) => call.method === "sandbox.update")?.params,
        ).toEqual({
          id: "sbx-config",
          currentSnapshotId: "snap-restored",
          keepLastSnapshots: null,
          env: {},
          networkPolicy: "deny-all",
        });
        expect(
          await invoke([
            "drives",
            "fork",
            "drv-source",
            "--name",
            "independent",
          ]),
        ).toBe("drv-fork\n");
        expect(calls.at(-1)).toEqual({
          method: "drive.fork",
          params: { id: "drv-source", name: "independent" },
        });
      } finally {
        await server.stop(true);
      }
    });
  });
});
