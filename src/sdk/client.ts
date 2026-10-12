import { APIError } from "../errors.ts";
import type { CommandRecord, LogRecord, Page } from "../types.ts";

export interface ClientOptions {
  /** URL of the sbox control plane, locally or remotely. */
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}
export interface SignalOptions {
  signal?: AbortSignal;
}

export class Client {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.SBOX_URL ??
      "http://127.0.0.1:7070"
    ).replace(/\/+$/, "");
    const url = new URL(this.baseUrl);
    if (!["http:", "https:"].includes(url.protocol))
      throw new TypeError("baseUrl must use HTTP or HTTPS");
    if (url.username || url.password || url.search || url.hash)
      throw new TypeError(
        "baseUrl must not contain credentials, query parameters, or a fragment",
      );
    this.token = options.token ?? process.env.SBOX_TOKEN;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async rpc<T>(
    method: string,
    params: unknown = {},
    options: SignalOptions = {},
  ): Promise<T> {
    const response = await this.request("/v1/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params }),
      signal: options.signal,
      headers: { "content-type": "application/json" },
    });
    const envelope = (await response.json()) as {
      result?: T;
      error?: { code?: string; message?: string; details?: unknown };
      requestId?: string;
    };
    if (envelope.error)
      throw new APIError(
        envelope.error.code ?? "API_ERROR",
        envelope.error.message ?? "Sandbox request failed",
        response.status,
        envelope.error.details,
      );
    if (!response.ok)
      throw new APIError(
        "HTTP_ERROR",
        `Sandbox API returned HTTP ${response.status}`,
        response.status,
      );
    if (!("result" in envelope))
      throw new APIError(
        "INVALID_RESPONSE",
        "Sandbox API response is missing result",
        502,
      );
    return envelope.result as T;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    return this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
    });
  }

  /** The response body remains a stream; its consumer owns cancellation. */
  async readFile(
    id: string,
    path: string,
    options: SignalOptions & { sessionId?: string; user?: string } = {},
  ): Promise<ReadableStream<Uint8Array> | null> {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({ path });
    if (options.sessionId) query.set("sessionId", options.sessionId);
    if (options.user) query.set("user", options.user);
    const response = await this.request(
      `/v1/sandboxes/${encodeURIComponent(id)}/files?${query}`,
      {
        signal: options.signal,
        headers: { accept: "application/octet-stream" },
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      if (response.status === 404 && body?.error?.code === "ENOENT")
        return null;
      throw new APIError(
        body?.error?.code ?? "FILE_READ_FAILED",
        body?.error?.message ?? `File read returned HTTP ${response.status}`,
        response.status,
        body?.error?.details,
      );
    }
    if (!response.body)
      throw new APIError("EMPTY_STREAM", "File response has no body", 502);
    return response.body;
  }

  /** Upload bytes directly; filenames stay in query data rather than executable source. */
  async writeFile(
    id: string,
    path: string,
    content: Uint8Array,
    options: SignalOptions & {
      sessionId?: string;
      user?: string;
      mode?: number;
    } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({ path });
    if (options.sessionId) query.set("sessionId", options.sessionId);
    if (options.user) query.set("user", options.user);
    if (options.mode !== undefined) query.set("mode", String(options.mode));
    const response = await this.request(
      `/v1/sandboxes/${encodeURIComponent(id)}/files?${query}`,
      {
        method: "PUT",
        body: content as BodyInit,
        signal: options.signal,
        headers: { "content-type": "application/octet-stream" },
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      throw new APIError(
        body?.error?.code ?? "FILE_WRITE_FAILED",
        body?.error?.message ?? `File write returned HTTP ${response.status}`,
        response.status,
        body?.error?.details,
      );
    }
    await response.body?.cancel();
  }

  /** Replay cursors recover interrupted streams without re-executing commands. */
  async *logs(
    id: string,
    options: SignalOptions & { after?: number } = {},
  ): AsyncGenerator<LogRecord | { type: "done"; command: CommandRecord }> {
    let after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TypeError("after must be a nonnegative safe integer");
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let terminalError = false;
      try {
        const response = await this.request(
          `/v1/commands/${encodeURIComponent(id)}/logs?after=${after}`,
          { signal: options.signal },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string; details?: unknown };
          } | null;
          throw new APIError(
            body?.error?.code ?? "LOG_STREAM_ERROR",
            body?.error?.message ??
              `Log stream returned HTTP ${response.status}`,
            response.status,
            body?.error?.details,
          );
        }
        if (!response.body)
          throw new APIError(
            "EMPTY_STREAM",
            "Log stream has no response body",
            502,
          );
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const { value, done } = await reader.read();
          pending += done
            ? decoder.decode()
            : decoder.decode(value, { stream: true });
          if (pending.length > 16 * 1024 * 1024)
            throw new APIError(
              "INVALID_STREAM",
              "Log record exceeds 16 MiB",
              502,
            );
          let end: number;
          while ((end = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            if (!line) continue;
            const event = JSON.parse(line) as
              | LogRecord
              | { type: "done"; command: CommandRecord }
              | {
                  type: "error";
                  error: {
                    code: string;
                    message: string;
                    status?: number;
                    details?: unknown;
                  };
                };
            if ("type" in event && event.type === "error") {
              terminalError = true;
              throw new APIError(
                event.error.code,
                event.error.message,
                event.error.status ?? 500,
                event.error.details,
              );
            }
            if ("type" in event && event.type === "done") {
              yield event;
              return;
            }
            const log = event as LogRecord;
            if (
              !Number.isSafeInteger(log.sequence) ||
              typeof log.data !== "string" ||
              !["stdout", "stderr"].includes(log.stream)
            )
              throw new APIError(
                "INVALID_STREAM",
                "Malformed command log record",
                502,
              );
            if (log.sequence <= after) continue;
            after = log.sequence;
            yield log;
          }
          if (done) break;
        }
        // A partial final JSON line or missing done frame means reconnect using the cursor.
        throw new APIError(
          "STREAM_INTERRUPTED",
          "Command log stream ended before completion",
          502,
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          terminalError ||
          attempt >= 3 ||
          (error instanceof APIError && error.status < 500)
        )
          throw error;
        await delay(100 * 2 ** attempt, options.signal);
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type ListResult<T, K extends string> = Page<T> &
  Record<K, T[]> &
  AsyncIterable<T> & {
    pagination: { count: number; next: string | null };
    pages(): AsyncIterable<ListResult<T, K>>;
    toArray(): Promise<T[]>;
  };

export function paginate<T, K extends string>(
  first: Page<T>,
  key: K,
  next: (cursor: string) => Promise<Page<T>>,
  signal?: AbortSignal,
): ListResult<T, K> {
  async function* pages(start: Page<T>): AsyncGenerator<ListResult<T, K>> {
    let page = start;
    const seen = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      yield decorate(page);
      if (page.nextCursor === null) return;
      if (seen.has(page.nextCursor))
        throw new APIError(
          "INVALID_PAGINATION",
          "API repeated a pagination cursor",
          502,
        );
      seen.add(page.nextCursor);
      page = await next(page.nextCursor);
    }
  }
  async function* items(start: Page<T>) {
    for await (const page of pages(start))
      for (const item of page.items) {
        signal?.throwIfAborted();
        yield item;
      }
  }
  function decorate(page: Page<T>): ListResult<T, K> {
    return Object.assign(
      {},
      page,
      { [key]: page.items },
      {
        pagination: { count: page.items.length, next: page.nextCursor },
        pages: () => pages(page),
        [Symbol.asyncIterator]: () => items(page),
        toArray: async () => {
          const all: T[] = [];
          for await (const item of items(page)) all.push(item);
          return all;
        },
      },
    ) as ListResult<T, K>;
  }
  return decorate(first);
}
