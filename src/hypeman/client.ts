import { SboxError } from "../errors.ts";

export class HypemanError extends SboxError {
  constructor(message: string, status: number, code = "HYPEMAN_ERROR") {
    super(code, message, status);
    this.name = "HypemanError";
  }
}

export interface HypemanClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Optional authenticated storage companion running beside Hypeman. */
  storageUrl?: string;
  storageToken?: string;
}

export interface NativeExecOptions {
  command: string[];
  tty?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  wait_for_agent?: number;
  rows?: number;
  cols?: number;
}

export interface NativeExecSession {
  completion: Promise<number>;
  write(data: Uint8Array): void;
  resize(rows: number, cols: number): void;
  close(): void;
}

interface TransferHeader {
  type: "header";
  path: string;
  mode: number;
  is_dir: boolean;
  is_symlink?: boolean;
  size: number;
}

/** Thin native transport. No access tokens are ever put in URLs. */
export class HypemanClient {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly storageUrl?: string;
  private readonly storageToken?: string;

  get storageConfigured(): boolean {
    return this.storageUrl !== undefined;
  }

  constructor(options: HypemanClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Hypeman base URL must be an HTTP(S) URL without embedded credentials, query, or fragment",
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.headers = options.apiKey
      ? { Authorization: `Bearer ${options.apiKey}` }
      : {};
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (options.storageUrl !== undefined) {
      const storage = new URL(options.storageUrl);
      if (
        !["http:", "https:"].includes(storage.protocol) ||
        storage.username ||
        storage.password ||
        storage.search ||
        storage.hash
      )
        throw new Error(
          "Storage companion URL must be HTTP(S) without embedded credentials, query, or fragment",
        );
      if (!options.storageToken || options.storageToken.length < 16)
        throw new Error(
          "Storage companion requires a token of at least 16 characters",
        );
      this.storageUrl = storage.toString().replace(/\/$/, "");
      this.storageToken = options.storageToken;
    } else if (options.storageToken !== undefined) {
      throw new Error("Storage companion token requires storageUrl");
    }
  }

  async storageRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.storageUrl)
      throw new SboxError(
        "storage_unavailable",
        "Storage companion is not configured",
        422,
      );
    let response: Response;
    try {
      response = await this.fetcher(this.storageUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.storageToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new SboxError(
        "storage_unreachable",
        `Storage companion request failed (${method} ${path})`,
        502,
      );
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new SboxError(
        detail.error?.code ?? "storage_failed",
        detail.error?.message ??
          `Storage companion returned HTTP ${response.status}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method,
        headers: {
          ...this.headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: "error",
      });
    } catch (error) {
      throw new HypemanError(
        `Hypeman request failed (${method} ${path}): ${error instanceof Error ? error.message : "connection failed"}`,
        502,
        "hypeman_unreachable",
      );
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 4096);
      let detail: { message?: string; code?: string } = {};
      try {
        detail = JSON.parse(text);
      } catch {
        /* Non-JSON gateway error. */
      }
      throw new HypemanError(
        detail.message ?? `Hypeman returned HTTP ${response.status}`,
        response.status,
        detail.code,
      );
    }
    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    )
      return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async socket(path: string): Promise<WebSocket> {
    const url = new URL(this.baseUrl + path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // lib.dom's constructor hides Bun's documented options overload when both
    // types are loaded. The runtime supports authenticated WebSockets natively.
    const BunWebSocket = WebSocket as unknown as {
      new (url: URL, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(url, { headers: this.headers });
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          socket.close();
          reject(
            new HypemanError(
              "Timed out connecting to Hypeman WebSocket",
              504,
              "hypeman_timeout",
            ),
          );
        },
        Math.min(this.timeoutMs, 30_000),
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(
            new HypemanError(
              "Hypeman WebSocket connection failed; check the server URL and API key",
              502,
              "hypeman_unreachable",
            ),
          );
        },
        { once: true },
      );
    });
    return socket;
  }

  async exec(
    id: string,
    options: NativeExecOptions,
    onData: (data: Uint8Array) => void,
  ): Promise<NativeExecSession> {
    const socket = await this.socket(
      `/instances/${encodeURIComponent(id)}/exec`,
    );
    let settled = false;
    const completion = new Promise<number>((resolve, reject) => {
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        socket.close();
      };
      socket.addEventListener("message", (event) => {
        if (settled) return;
        try {
          if (typeof event.data === "string") {
            const control = JSON.parse(event.data) as {
              error?: string;
              exitCode?: number;
            };
            if (control.error)
              fail(new HypemanError(control.error, 500, "hypeman_exec_failed"));
            else if (typeof control.exitCode === "number") {
              settled = true;
              resolve(control.exitCode);
              socket.close();
            }
          } else onData(new Uint8Array(event.data as ArrayBuffer));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("error", () =>
        fail(
          new HypemanError(
            "Hypeman command stream failed",
            502,
            "hypeman_stream_failed",
          ),
        ),
      );
      socket.addEventListener("close", () => {
        if (!settled)
          fail(
            new HypemanError(
              "Hypeman command stream closed before an exit status was received",
              502,
              "hypeman_stream_closed",
            ),
          );
      });
    });
    // Callers may attach completion handlers on the next tick after this method returns.
    void completion.catch(() => {});
    socket.send(JSON.stringify(options));
    return {
      completion,
      write(data) {
        if (socket.readyState !== WebSocket.OPEN)
          throw new Error("Command input is closed");
        socket.send(data);
      },
      resize(rows, cols) {
        if (!options.tty) throw new Error("Only PTY commands can be resized");
        if (socket.readyState !== WebSocket.OPEN)
          throw new Error("Command input is closed");
        socket.send(JSON.stringify({ resize: { rows, cols } }));
      },
      close() {
        socket.close();
      },
    };
  }

  async writeFile(
    id: string,
    path: string,
    data: Uint8Array,
    mode = 0o644,
  ): Promise<void> {
    const socket = await this.socket(`/instances/${encodeURIComponent(id)}/cp`);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(
        () => finish(new HypemanError("File upload timed out", 504)),
        this.timeoutMs,
      );
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string")
            throw new Error("Unexpected binary upload response");
          const message = JSON.parse(event.data) as {
            type: string;
            success?: boolean;
            error?: string;
            message?: string;
          };
          if (message.type === "result")
            finish(
              message.success
                ? undefined
                : new HypemanError(message.error ?? "File upload failed", 500),
            );
          else if (message.type === "error")
            finish(
              new HypemanError(message.message ?? "File upload failed", 500),
            );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("error", () =>
        finish(new HypemanError("File upload connection failed", 502)),
      );
      socket.addEventListener("close", () => {
        if (!finished)
          finish(
            new HypemanError(
              "File upload connection closed before acknowledgement",
              502,
            ),
          );
      });
      socket.send(
        JSON.stringify({
          direction: "to",
          guest_path: path,
          is_dir: false,
          mode,
        }),
      );
      void (async () => {
        try {
          for (
            let offset = 0;
            offset < data.length && !finished;
            offset += 64 * 1024
          ) {
            while (socket.bufferedAmount > 1024 * 1024 && !finished)
              await new Promise((resolve) => setTimeout(resolve, 5));
            if (!finished)
              socket.send(data.subarray(offset, offset + 64 * 1024));
          }
          if (!finished) socket.send(JSON.stringify({ type: "end" }));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  async readFile(
    id: string,
    path: string,
    maxBytes = 256 * 1024 * 1024,
  ): Promise<Uint8Array> {
    const socket = await this.socket(`/instances/${encodeURIComponent(id)}/cp`);
    return new Promise<Uint8Array>((resolve, reject) => {
      let finished = false;
      let header: TransferHeader | undefined;
      const chunks: Uint8Array[] = [];
      let length = 0;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks, length));
      };
      const timeout = setTimeout(
        () => finish(new HypemanError("File download timed out", 504)),
        this.timeoutMs,
      );
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data === "string") {
            const message = JSON.parse(event.data) as
              | TransferHeader
              | { type: "end"; final: boolean }
              | { type: "error"; message: string };
            if (message.type === "header") {
              if (header || message.is_dir || message.is_symlink)
                throw new Error("readFile requires a regular file");
              if (message.size > maxBytes)
                throw new Error(
                  `File exceeds the ${maxBytes}-byte transfer limit`,
                );
              header = message;
            } else if (message.type === "error")
              finish(new HypemanError(message.message, 404));
            else if (message.type === "end" && message.final) {
              if (!header)
                throw new Error(
                  "File transfer completed without a file header",
                );
              if (length !== header.size)
                throw new Error("File transfer size did not match its header");
              finish();
            }
          } else {
            if (!header) throw new Error("File data arrived before its header");
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            length += bytes.length;
            if (length > maxBytes)
              throw new Error(
                `File exceeds the ${maxBytes}-byte transfer limit`,
              );
            chunks.push(bytes);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("error", () =>
        finish(new HypemanError("File download connection failed", 502)),
      );
      socket.addEventListener("close", () => {
        if (!finished)
          finish(
            new HypemanError("File download closed before completion", 502),
          );
      });
      socket.send(
        JSON.stringify({
          direction: "from",
          guest_path: path,
          follow_links: true,
        }),
      );
    });
  }
}
