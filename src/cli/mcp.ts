import { Sandbox, type Command } from "../index.ts";
import type { ClientOptions } from "../sdk/client.ts";

type JsonObject = Record<string, unknown>;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: JsonObject;
}
type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};
export interface McpContext {
  signal: AbortSignal;
}
type Operation = (args: JsonObject, context: McpContext) => Promise<unknown>;
export interface McpOperations {
  create: Operation;
  list: Operation;
  get: Operation;
  exec: Operation;
  commands: Operation;
  poll: Operation;
  kill: Operation;
  read: Operation;
  write: Operation;
  stop: Operation;
  resume: Operation;
  delete: Operation;
}

const string = { type: "string", minLength: 1 };
const id = { ...string, description: "Sandbox identifier or name" };
const commandId = {
  ...string,
  description: "Command identifier returned by sandbox_exec",
};
const env = { type: "object", additionalProperties: { type: "string" } };
const page = {
  limit: { type: "integer", minimum: 1, maximum: 100 },
  cursor: string,
};
const schema = (properties: JsonObject, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const tool = (
  name: string,
  operation: keyof McpOperations,
  description: string,
  properties: JsonObject,
  required: string[],
  readOnly = false,
) => ({
  name,
  operation,
  description,
  inputSchema: schema(properties, required),
  annotations: {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    openWorldHint: true,
  },
});
const definitions = [
  tool(
    "sandbox_create",
    "create",
    "Create a Hypeman sandbox for isolated Linux code execution. Credentials must be explicit.",
    {
      name: string,
      image: string,
      timeout: { type: "integer", minimum: 1000, maximum: 86400000 },
      env,
    },
    [],
  ),
  tool(
    "sandbox_list",
    "list",
    "List sandboxes and continuation cursor. Environment secrets are omitted.",
    page,
    [],
    true,
  ),
  tool(
    "sandbox_get",
    "get",
    "Inspect sandbox state without exposing environment secrets.",
    { sandboxId: id },
    ["sandboxId"],
    true,
  ),
  tool(
    "sandbox_exec",
    "exec",
    "Execute cmd and args in the guest. Set detached=true for background work, then poll or kill its commandId. Attached output is bounded to 64 KiB. Cancellation terminates attached execution.",
    {
      sandboxId: id,
      cmd: string,
      args: { type: "array", items: { type: "string" }, maxItems: 256 },
      cwd: string,
      env,
      detached: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 },
    },
    ["sandboxId", "cmd"],
  ),
  tool(
    "sandbox_commands",
    "commands",
    "List commands and their status in a sandbox.",
    { sandboxId: id, ...page },
    ["sandboxId"],
    true,
  ),
  tool(
    "sandbox_command_poll",
    "poll",
    "Fetch up to 64 KiB of retained command output without waiting. Pass nextCursor.after and nextCursor.offset on subsequent calls. Base64 logs preserve exact bytes; stdout/stderr are text conveniences.",
    {
      sandboxId: id,
      commandId,
      after: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0, maximum: 16777216 },
    },
    ["sandboxId", "commandId"],
    true,
  ),
  tool(
    "sandbox_command_kill",
    "kill",
    "Signal a command in this sandbox; defaults to SIGTERM. SIGKILL forces termination.",
    { sandboxId: id, commandId, signal: string },
    ["sandboxId", "commandId"],
  ),
  tool(
    "sandbox_read_file",
    "read",
    "Read a UTF-8 text file in a sandbox, up to 64 KiB.",
    { sandboxId: id, path: string },
    ["sandboxId", "path"],
    true,
  ),
  tool(
    "sandbox_write_file",
    "write",
    "Write a UTF-8 text file in a sandbox, creating or replacing its contents.",
    {
      sandboxId: id,
      path: string,
      content: { type: "string", maxLength: 524288 },
    },
    ["sandboxId", "path", "content"],
  ),
  tool(
    "sandbox_stop",
    "stop",
    "Stop a sandbox and its commands, preserving files for resume.",
    { sandboxId: id },
    ["sandboxId"],
  ),
  tool(
    "sandbox_resume",
    "resume",
    "Resume a stopped sandbox.",
    { sandboxId: id },
    ["sandboxId"],
  ),
  tool(
    "sandbox_delete",
    "delete",
    "Permanently delete a sandbox and its writable filesystem.",
    { sandboxId: id },
    ["sandboxId"],
  ),
];
export const mcpTools = definitions.map(
  ({ operation: _, ...definition }) => definition,
);
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validate(name: string, args: unknown): JsonObject {
  const definition = definitions.find((tool) => tool.name === name)!;
  if (!object(args)) throw new Error("arguments must be an object");
  for (const key of Object.keys(args))
    if (!Object.hasOwn(definition.inputSchema.properties, key))
      throw new Error(`Unknown argument: ${key}`);
  for (const key of definition.inputSchema.required)
    if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const property = definition.inputSchema.properties[key] as {
      type: string;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
    };
    if (
      property.type === "string" &&
      (typeof value !== "string" ||
        value.length < (property.minLength ?? 0) ||
        value.length > (property.maxLength ?? 8192) ||
        value.includes("\0"))
    )
      throw new Error(`Invalid ${key}`);
    if (
      property.type === "integer" &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < (property.minimum ?? 0) ||
        value > (property.maximum ?? Number.MAX_SAFE_INTEGER))
    )
      throw new Error(`Invalid ${key}`);
    if (property.type === "boolean" && typeof value !== "boolean")
      throw new Error(`Invalid ${key}`);
    if (
      key === "content" &&
      typeof value === "string" &&
      Buffer.byteLength(value) > 524288
    )
      throw new Error("content exceeds the MCP 512 KiB limit");
    if (
      key === "args" &&
      (!Array.isArray(value) ||
        value.length > 256 ||
        value.some(
          (v) => typeof v !== "string" || v.length > 8192 || v.includes("\0"),
        ))
    )
      throw new Error("Invalid args");
    if (
      key === "env" &&
      (!object(value) ||
        Object.keys(value).length > 128 ||
        Object.entries(value).some(
          ([k, v]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
            typeof v !== "string" ||
            v.length > 8192 ||
            v.includes("\0"),
        ))
    )
      throw new Error("Invalid env");
  }
  return args;
}

export interface McpHandler {
  (input: unknown): Promise<RpcResponse | undefined>;
  close(): void;
}
export function createMcpHandler(operations: McpOperations): McpHandler {
  const active = new Map<string | number | null, AbortController>();
  let closed = false;
  const handle = async (input: unknown): Promise<RpcResponse | undefined> => {
    if (
      !object(input) ||
      input.jsonrpc !== "2.0" ||
      typeof input.method !== "string" ||
      (input.id !== undefined &&
        input.id !== null &&
        typeof input.id !== "string" &&
        (typeof input.id !== "number" || !Number.isFinite(input.id))) ||
      (input.params !== undefined && !object(input.params))
    )
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    const request = input as unknown as RpcRequest;
    if (
      request.method === "notifications/cancelled" &&
      request.id === undefined
    ) {
      const id = request.params?.requestId;
      if (typeof id === "string" || typeof id === "number")
        active.get(id)?.abort(new Error("MCP request cancelled"));
      return;
    }
    if (request.id === undefined) return;
    const response = (result: unknown): RpcResponse => ({
      jsonrpc: "2.0",
      id: request.id!,
      result,
    });
    const errorResponse = (code: number, message: string): RpcResponse => ({
      jsonrpc: "2.0",
      id: request.id!,
      error: { code, message },
    });
    if (closed) return errorResponse(-32000, "Server is closing");
    if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      return response({
        protocolVersion:
          typeof requested === "string" && versions.includes(requested)
            ? requested
            : versions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sbox", version: "0.1.0" },
        instructions:
          "Run commands only in sandboxes. Supply credentials explicitly. Use detached execution and polling for long tasks; cancel attached tool requests to terminate their remote commands.",
      });
    }
    if (request.method === "ping") return response({});
    if (request.method === "tools/list") return response({ tools: mcpTools });
    if (request.method !== "tools/call")
      return errorResponse(-32601, "Method not found");
    const name = request.params?.name;
    if (typeof name !== "string")
      return errorResponse(-32602, "Tool name is required");
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) return errorResponse(-32602, `Unknown tool: ${name}`);
    if (active.has(request.id))
      return errorResponse(-32600, "Request ID is already active");
    if (active.size >= 32)
      return errorResponse(-32000, "Too many concurrent tool calls");
    const controller = new AbortController();
    active.set(request.id, controller);
    try {
      const args = validate(name, request.params?.arguments ?? {});
      const result = await operations[definition.operation](args, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        return response({
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
    } catch (error) {
      if (!controller.signal.aborted)
        return response({
          content: [
            {
              type: "text",
              text: (error instanceof Error
                ? error.message
                : "Tool failed"
              ).slice(0, 2048),
            },
          ],
          isError: true,
        });
    } finally {
      active.delete(request.id);
    }
  };
  return Object.assign(handle, {
    close() {
      closed = true;
      for (const controller of active.values())
        controller.abort(new Error("MCP transport closed"));
    },
  });
}

const metadata = (sandbox: Sandbox | JsonObject) => {
  const data = sandbox instanceof Sandbox ? sandbox.toJSON() : sandbox;
  // Select the public operational fields; never return persisted environment values.
  return Object.fromEntries(
    [
      "sandboxId",
      "name",
      "status",
      "image",
      "resources",
      "createdAt",
      "deadline",
      "persistent",
      "ports",
    ]
      .filter((key) => key in data)
      .map((key) => [key, (data as unknown as JsonObject)[key]]),
  );
};
async function cancelCommand(
  command: Command,
  signal: AbortSignal,
  work: () => Promise<unknown>,
) {
  let killing: Promise<void> | undefined;
  const kill = () => {
    killing ??= command
      .kill("SIGKILL", { signal: AbortSignal.timeout(10000) })
      .catch(() => {});
  };
  signal.addEventListener("abort", kill, { once: true });
  try {
    signal.throwIfAborted();
    return await work();
  } catch (error) {
    kill();
    await killing;
    throw error;
  } finally {
    signal.removeEventListener("abort", kill);
    if (signal.aborted) {
      kill();
      await killing;
    }
  }
}

export function sdkMcpOperations(connection: ClientOptions): McpOperations {
  const get = (args: JsonObject, context: McpContext) =>
    Sandbox.get({
      ...connection,
      sandboxId: args.sandboxId as string,
      signal: context.signal,
    });
  const command = async (args: JsonObject, context: McpContext) =>
    (await get(args, context)).getCommand(args.commandId as string, context);
  return {
    async create(args, { signal }) {
      signal.throwIfAborted();
      // Keep the response handle for cleanup if cancellation races creation.
      const sandbox = await Sandbox.create({
        ...connection,
        name: args.name as string | undefined,
        image: args.image as string | undefined,
        timeout: args.timeout as number | undefined,
        env: args.env as Record<string, string> | undefined,
      });
      if (signal.aborted) {
        await sandbox.delete();
        signal.throwIfAborted();
      }
      return metadata(sandbox);
    },
    async list(args, context) {
      const result = await Sandbox.list({
        ...connection,
        ...context,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      });
      return {
        items: result.items.map((item) =>
          metadata(item as unknown as JsonObject),
        ),
        nextCursor: result.nextCursor,
      };
    },
    async get(args, context) {
      return metadata(await get(args, context));
    },
    async exec(args, context) {
      const sandbox = await get(args, context);
      context.signal.throwIfAborted();
      const detached = args.detached === true;
      const timeoutMs =
        (args.timeoutMs as number | undefined) ??
        (detached ? undefined : 60000);
      if (!detached && timeoutMs! > 300000)
        throw new Error(
          "Attached commands are limited to five minutes; use detached=true and poll for longer tasks",
        );
      const command = await sandbox.runCommand({
        cmd: args.cmd as string,
        args: args.args as string[] | undefined,
        cwd: args.cwd as string | undefined,
        env: args.env as Record<string, string> | undefined,
        timeoutMs,
        detached: true,
      });
      return cancelCommand(command, context.signal, async () => {
        if (detached)
          return {
            commandId: command.commandId,
            sandboxId: sandbox.sandboxId,
            status: command.toJSON().status,
            detached: true,
          };
        const output: Record<"stdout" | "stderr", Buffer[]> = {
          stdout: [],
          stderr: [],
        };
        let used = 0,
          truncated = false;
        for await (const log of command.rawLogs(context)) {
          const data = log.data.subarray(0, Math.max(0, 65536 - used));
          used += data.length;
          truncated ||= data.length !== log.data.length;
          if (data.length) output[log.stream].push(Buffer.from(data));
        }
        const completed = await command.wait(context);
        return {
          commandId: command.commandId,
          exitCode: completed.exitCode,
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
          truncated: truncated || command.truncated,
        };
      });
    },
    async commands(args, context) {
      return (await get(args, context)).listCommands({
        ...context,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      });
    },
    async poll(args, context) {
      const cmd = await command(args, context);
      let after = (args.after as number | undefined) ?? 0;
      let offset = (args.offset as number | undefined) ?? 0;
      const result = await cmd.poll({ ...context, after, limit: 128 });
      const logs: Array<{
        sequence: number;
        stream: string;
        data: string;
        encoding: "base64";
      }> = [];
      const output: Record<"stdout" | "stderr", Buffer[]> = {
        stdout: [],
        stderr: [],
      };
      let remaining = 65536,
        consumed = 0;
      for (const log of result.logs) {
        if (offset > log.data.length)
          throw new Error("Cursor offset exceeds the next log event");
        const data = log.data.subarray(offset, offset + remaining);
        output[log.stream].push(data);
        logs.push({
          sequence: log.sequence,
          stream: log.stream,
          data: data.toString("base64"),
          encoding: "base64",
        });
        remaining -= data.length;
        if (offset + data.length < log.data.length) {
          offset += data.length;
          break;
        }
        after = log.sequence;
        offset = 0;
        consumed++;
        if (!remaining) break;
      }
      if (!result.logs.length && offset)
        throw new Error("Cursor offset has no corresponding log event");
      return {
        commandId: cmd.commandId,
        status: result.command.status,
        exitCode: result.command.exitCode,
        error: result.command.error,
        logs,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        nextCursor: { after, offset },
        hasMore: result.hasMore || consumed < result.logs.length,
        truncated: result.command.truncated ?? false,
      };
    },
    async kill(args, context) {
      const cmd = await command(args, context);
      await cmd.kill((args.signal as string | undefined) ?? "SIGTERM", context);
      return { commandId: cmd.commandId, signalled: true };
    },
    async read(args, context) {
      const sandbox = await get(args, context);
      const stat = await sandbox.fs.stat(args.path as string, context);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      if (stat.size > 65536)
        throw new Error(
          "File exceeds the MCP 64 KiB limit; use the SDK or CLI to download it",
        );
      const file = await sandbox.readFile(
        { path: args.path as string },
        context,
      );
      if (!file) throw new Error("File not found");
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of file) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > 65536)
            throw new Error("File exceeds the MCP 64 KiB limit");
          chunks.push(bytes);
        }
      } finally {
        file.destroy();
      }
      return {
        path: args.path,
        content: Buffer.concat(chunks).toString("utf8"),
      };
    },
    async write(args, context) {
      await (
        await get(args, context)
      ).writeFiles(
        [{ path: args.path as string, content: args.content as string }],
        context,
      );
      return { written: true, path: args.path };
    },
    async stop(args, context) {
      const sandbox = await get(args, context);
      await sandbox.stop(context);
      return metadata(sandbox);
    },
    async resume(args, context) {
      const sandbox = await get(args, context);
      await sandbox.resume(context);
      return metadata(sandbox);
    },
    async delete(args, context) {
      const sandbox = await get(args, context);
      await sandbox.delete(context);
      return { sandboxId: sandbox.sandboxId, deleted: true };
    },
  };
}

/** Newline JSON-RPC. Cancellation notifications remain serviceable at capacity. */
export async function serveMcp(connection: ClientOptions): Promise<void> {
  const handle = createMcpHandler(sdkMcpOperations(connection));
  const pending = new Set<Promise<void>>();
  let buffer = "";
  const decoder = new TextDecoder();
  const write = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  const accept = async (line: string) => {
    if (!line.trim()) return;
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    const output = await handle(input);
    if (output) write(output);
  };
  const submit = (line: string) => {
    if (line.length > 1024 * 1024) throw new Error("MCP request exceeds 1 MiB");
    const task = accept(line).finally(() => pending.delete(task));
    pending.add(task);
  };
  const terminate = () => {
    handle.close();
    process.stdin.destroy();
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    for await (const chunk of process.stdin) {
      buffer +=
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        submit(line);
      }
      if (buffer.length > 1024 * 1024)
        throw new Error("MCP request exceeds 1 MiB");
    }
    buffer += decoder.decode();
    if (buffer.trim()) submit(buffer);
  } finally {
    handle.close();
    await Promise.allSettled(pending);
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}
