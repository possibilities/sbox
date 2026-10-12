import type { Writable } from "node:stream";
import type { Command } from "../index.ts";

export async function writeOutput(
  destination: Writable,
  data: string | Uint8Array,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    destination.once("error", failed);
    try {
      destination.write(data, (error) => {
        if (error) reject(error);
        else {
          destination.off("error", failed);
          resolve();
        }
      });
    } catch (error) {
      destination.off("error", failed);
      reject(error);
    }
  });
}

/** Observation commands cancel their local request without signaling the guest. */
export async function observe(
  work: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let code = 130;
  const interrupt = () => {
    code = 130;
    controller.abort();
  };
  const terminate = () => {
    code = 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return code;
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

export async function printLogs(
  command: Command,
  options: { after?: number; follow?: boolean; signal?: AbortSignal },
): Promise<void> {
  if (options.follow) {
    for await (const log of command.rawLogs({
      after: options.after,
      signal: options.signal,
    }))
      await writeOutput(
        log.stream === "stdout" ? process.stdout : process.stderr,
        log.data,
      );
    return;
  }
  let after = options.after ?? 0;
  // Capture a finite view: concurrent output should not make `logs` follow forever.
  const first = await command.poll({
    after,
    limit: 128,
    signal: options.signal,
  });
  let page = first;
  const end = first.lastSequence;
  for (;;) {
    for (const log of page.logs) {
      if (end !== undefined && log.sequence > end) return;
      await writeOutput(
        log.stream === "stdout" ? process.stdout : process.stderr,
        log.data,
      );
      after = log.sequence;
    }
    if (!page.hasMore || (end !== undefined && after >= end)) return;
    if (page.nextCursor <= after && !page.logs.length)
      throw new Error("Command log cursor did not advance");
    after = page.nextCursor;
    page = await command.poll({ after, limit: 128, signal: options.signal });
  }
}
