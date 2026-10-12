import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { APIError } from "../errors.ts";
import type { CommandRecord, ExecOptions, LogRecord } from "../types.ts";
import { Client, type SignalOptions } from "./client.ts";

export interface RunCommandParams extends Omit<ExecOptions, "stdin"> {
  stdin?: boolean | Readable;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
}
export interface CommandOutput {
  stdout: string;
  stderr: string;
}
export interface CommandPollResult {
  command: CommandRecord;
  logs: Array<Omit<LogRecord, "data"> & { data: Buffer }>;
  nextCursor: number;
  hasMore: boolean;
  lastSequence?: number;
}

export class Command {
  protected record: CommandRecord;
  private outputCache?: Promise<CommandOutput & { both: string }>;
  private stdinQueue: Promise<void> = Promise.resolve();
  private stdinError?: unknown;
  private stdinClosed = false;
  /** @internal */ ioCompletion?: Promise<void>;
  /** @internal */ ioFailure?: Promise<never>;
  /** @internal */ stopInput?: () => void;
  constructor(
    protected readonly client: Client,
    record: CommandRecord,
  ) {
    this.record = record;
  }
  get cmdId() {
    return this.record.commandId;
  }
  get commandId() {
    return this.record.commandId;
  }
  get sandboxId() {
    return this.record.sandboxId;
  }
  get sessionId() {
    return this.record.sessionId;
  }
  get cwd() {
    return this.record.cwd;
  }
  get startedAt() {
    return this.record.startedAt;
  }
  get exitCode(): number | null {
    return this.record.exitCode;
  }
  get durationMs() {
    return this.record.finishedAt === undefined
      ? undefined
      : this.record.finishedAt - this.record.startedAt;
  }
  get truncated() {
    return this.record.truncated ?? false;
  }
  toJSON(): CommandRecord {
    return { ...this.record };
  }

  async *logs(
    options: SignalOptions & { after?: number } = {},
  ): AsyncGenerator<LogRecord> {
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const latest: Partial<Record<"stdout" | "stderr", LogRecord>> = {};
    for await (const log of this.rawLogs(options)) {
      const data = decoders[log.stream].write(log.data);
      latest[log.stream] = { ...log, data };
      yield { ...log, data };
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const data = decoders[stream].end();
      const previous = latest[stream];
      if (data && previous) yield { ...previous, data };
    }
  }

  /** Byte-preserving output for stdio protocols and binary tools. */
  async *rawLogs(
    options: SignalOptions & { after?: number } = {},
  ): AsyncGenerator<Omit<LogRecord, "data"> & { data: Buffer }> {
    for await (const event of this.client.logs(this.cmdId, options)) {
      if ("type" in event) {
        this.record = event.command;
        this.assertSucceededTransport();
      } else yield { ...event, data: Buffer.from(event.data, "base64") };
    }
  }

  /** Fetch retained output without waiting for a running command to finish. */
  async poll(
    options: SignalOptions & { after?: number; limit?: number } = {},
  ): Promise<CommandPollResult> {
    const result = await this.client.rpc<{
      command: CommandRecord;
      logs: LogRecord[];
      nextCursor: number;
      hasMore: boolean;
      lastSequence?: number;
    }>(
      "command.poll",
      { id: this.cmdId, after: options.after, limit: options.limit },
      options,
    );
    this.record = result.command;
    return {
      ...result,
      logs: result.logs.map((log) => ({
        ...log,
        data: Buffer.from(log.data, "base64"),
      })),
    };
  }

  async wait(options: SignalOptions = {}): Promise<CommandFinished> {
    const waiting = this.client.rpc<CommandRecord>(
      "command.wait",
      { id: this.cmdId },
      options,
    );
    this.record = this.ioFailure
      ? await Promise.race([waiting, this.ioFailure])
      : await waiting;
    this.stopInput?.();
    this.assertSucceededTransport();
    if (this.record.exitCode === null)
      throw new APIError(
        "INVALID_RESPONSE",
        "Command wait returned without an exit code",
        502,
      );
    await this.ioCompletion;
    return new CommandFinished(this.client, this.record);
  }

  protected assertSucceededTransport(): void {
    if (this.record.error)
      throw new APIError(
        this.record.error.code,
        this.record.error.message,
        500,
      );
    if (this.record.status === "failed")
      throw new APIError("COMMAND_FAILED", "Command execution failed", 500);
  }

  async output(
    stream: "stdout" | "stderr" | "both" = "both",
    options: SignalOptions = {},
  ): Promise<string> {
    if (!this.outputCache) {
      this.outputCache = (async () => {
        const output = { stdout: "", stderr: "", both: "" };
        for await (const log of this.logs(options)) {
          output[log.stream] += log.data;
          output.both += log.data;
        }
        return output;
      })();
      this.outputCache.catch(() => {
        this.outputCache = undefined;
      });
    }
    options.signal?.throwIfAborted();
    return (await this.outputCache)[stream];
  }
  stdout(options?: SignalOptions) {
    return this.output("stdout", options);
  }
  stderr(options?: SignalOptions) {
    return this.output("stderr", options);
  }
  async kill(
    signal: string | number = "SIGTERM",
    options: { abortSignal?: AbortSignal; signal?: AbortSignal } = {},
  ): Promise<void> {
    const names: Record<number, string> = {
      1: "SIGHUP",
      2: "SIGINT",
      3: "SIGQUIT",
      9: "SIGKILL",
      10: "SIGUSR1",
      12: "SIGUSR2",
      15: "SIGTERM",
      18: "SIGCONT",
      19: "SIGSTOP",
    };
    const resolved =
      typeof signal === "number"
        ? names[signal]
        : signal.startsWith("SIG")
          ? signal
          : `SIG${signal}`;
    if (!resolved) throw new TypeError("Unsupported signal number");
    await this.client.rpc(
      "command.kill",
      { id: this.cmdId, signal: resolved },
      { signal: options.abortSignal ?? options.signal },
    );
  }

  writeStdin(
    data: string | Uint8Array,
    options: { abortSignal?: AbortSignal; signal?: AbortSignal } = {},
  ): Promise<void> {
    // Copy immediately: callers may reuse a mutable Buffer before queued writes run.
    const buffer =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    return this.queueStdin(async () => {
      if (this.stdinClosed)
        throw new APIError(
          "STDIN_CLOSED",
          "Command stdin has already been closed",
          409,
        );
      const signal = options.abortSignal ?? options.signal;
      for (let offset = 0; offset < buffer.length; offset += 384 * 1024) {
        signal?.throwIfAborted();
        await this.client.rpc(
          "command.stdin",
          {
            id: this.cmdId,
            data: buffer
              .subarray(offset, offset + 384 * 1024)
              .toString("base64"),
          },
          { signal },
        );
      }
    });
  }
  closeStdin(
    options: { abortSignal?: AbortSignal; signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.queueStdin(async () => {
      if (this.stdinClosed) return;
      await this.client.rpc(
        "command.closeStdin",
        { id: this.cmdId },
        { signal: options.abortSignal ?? options.signal },
      );
      this.stdinClosed = true;
    });
  }
  private queueStdin(write: () => Promise<void>): Promise<void> {
    const pending = this.stdinQueue.then(async () => {
      if (this.stdinError) throw this.stdinError;
      try {
        await write();
      } catch (error) {
        this.stdinError = error;
        throw error;
      }
    });
    // Do not retry a failed stdin write: delivery might have already happened.
    this.stdinQueue = pending.catch(() => {});
    return pending;
  }
}

export class CommandFinished extends Command {
  override get exitCode(): number {
    return this.record.exitCode!;
  }
  override async wait(options: SignalOptions = {}): Promise<CommandFinished> {
    options.signal?.throwIfAborted();
    return this;
  }
  override async writeStdin(): Promise<never> {
    throw new APIError(
      "COMMAND_FINISHED",
      "Cannot write to a completed command",
      409,
    );
  }
  override async closeStdin(): Promise<never> {
    throw new APIError(
      "COMMAND_FINISHED",
      "Cannot write to a completed command",
      409,
    );
  }
}

/** Pipe without ending caller-owned streams. Writable callbacks honor backpressure. */
export async function pipeOutput(
  command: Command,
  stdout?: Writable,
  stderr?: Writable,
  signal?: AbortSignal,
): Promise<void> {
  for await (const log of command.rawLogs({ signal })) {
    const destination = log.stream === "stdout" ? stdout : stderr;
    if (destination)
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          destination.off("error", onError);
          reject(error);
        };
        destination.once("error", onError);
        try {
          destination.write(log.data, (error) => {
            // Node emits 'error' after invoking a failed write's callback. Keep
            // the once-listener until then, so a caller-owned stream cannot
            // turn this handled rejection into an uncaught process error.
            if (error) reject(error);
            else {
              destination.off("error", onError);
              resolve();
            }
          });
        } catch (error) {
          destination.off("error", onError);
          reject(error);
        }
      });
  }
}

/** Stop on process exit without destroying the caller's input stream. */
export function pipeInput(
  command: Command,
  source: Readable,
  signal?: AbortSignal,
): { done: Promise<void>; stop(): void } {
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  const done = (async () => {
    while (!stopped) {
      signal?.throwIfAborted();
      if (source.errored) throw source.errored;
      const data = source.read();
      if (data !== null) {
        try {
          await command.writeStdin(
            typeof data === "string" ? data : Buffer.from(data),
            { signal },
          );
        } catch (error) {
          // EOF from the remote process may beat the independent wait
          // response. Its final status, rather than a stale stdin request,
          // determines whether a process that exits early succeeded.
          if (
            stopped ||
            (error instanceof APIError && error.code === "COMMAND_ENDED")
          )
            return;
          throw error;
        }
        continue;
      }
      if (source.readableEnded || source.destroyed) {
        try {
          await command.closeStdin({ signal });
        } catch (error) {
          if (
            !stopped &&
            !(error instanceof APIError && error.code === "COMMAND_ENDED")
          )
            throw error;
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          source.off("readable", ready);
          source.off("end", ready);
          source.off("close", ready);
          source.off("error", failed);
          signal?.removeEventListener("abort", aborted);
          wake = undefined;
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const aborted = () => {
          cleanup();
          reject(signal?.reason);
        };
        wake = ready;
        source.once("readable", ready);
        source.once("end", ready);
        source.once("close", ready);
        source.once("error", failed);
        signal?.addEventListener("abort", aborted, { once: true });
        if (stopped || source.readableEnded || source.destroyed) ready();
        else if (signal?.aborted) aborted();
      });
    }
  })();
  return { done, stop };
}
