import type { ExecOptions } from "../types.ts";

export type HarnessName = "codex" | "claude" | "opencode" | "generic";
export type HarnessMode = "run" | "stdio" | "acp";
export interface HarnessOptions {
  harness: HarnessName;
  mode?: HarnessMode;
  prompt?: string;
  model?: string;
  args?: string[];
  /** Explicit values only. No host credentials or environment are copied. */
  env?: Record<string, string>;
  cwd?: string;
  /** Required for the generic adapter; never interpreted as a shell string. */
  command?: string;
}

export const harnesses = {
  codex: {
    package: "@openai/codex",
    executable: "codex",
    modes: ["run", "stdio"],
    docs: "https://developers.openai.com/codex/cli/reference",
  },
  claude: {
    package: "@anthropic-ai/claude-code",
    executable: "claude",
    modes: ["run", "stdio"],
    docs: "https://code.claude.com/docs/en/cli-reference",
  },
  opencode: {
    package: "opencode-ai",
    executable: "opencode",
    modes: ["run", "acp"],
    docs: "https://opencode.ai/docs/cli/",
  },
  generic: {
    executable: undefined,
    modes: ["run", "stdio", "acp"],
    docs: "https://modelcontextprotocol.io/specification/latest/basic/transports",
  },
} as const;

/** Constructs an argv vector for execution inside an existing sandbox. */
export function harnessCommand(options: HarnessOptions): ExecOptions {
  const mode = options.mode ?? "run";
  const preset = harnesses[options.harness];
  if (!preset) throw new TypeError(`Unknown harness: ${options.harness}`);
  if (!(preset.modes as readonly string[]).includes(mode))
    throw new TypeError(
      `${options.harness} does not support ${mode}; use a generic adapter for third-party protocol bridges`,
    );
  let args: string[];
  if (options.harness === "codex")
    args =
      mode === "stdio"
        ? ["app-server", "--listen", "stdio://"]
        : ["exec", "--json", "--skip-git-repo-check"];
  else if (options.harness === "claude")
    args =
      mode === "stdio"
        ? [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
          ]
        : ["--print", "--output-format", "stream-json", "--verbose"];
  else if (options.harness === "opencode")
    args = [mode === "acp" ? "acp" : "run"];
  else args = [];
  if (options.model) {
    if (mode !== "run")
      throw new TypeError(
        "Set the model through the harness protocol in stdio/ACP mode",
      );
    args.push("--model", options.model);
  }
  args.push(...(options.args ?? []));
  if (options.prompt !== undefined) {
    if (mode !== "run")
      throw new TypeError("Prompts for stdio/ACP mode must be sent over stdin");
    // Delimit the prompt so strings beginning with -- remain prompt text.
    args.push("--", options.prompt);
  }
  const cmd =
    options.harness === "generic" ? options.command : preset.executable;
  if (!cmd) throw new TypeError("The generic harness requires a command");
  if (cmd.includes("\0") || args.some((arg) => arg.includes("\0")))
    throw new TypeError("Commands and arguments must not contain NUL");
  return {
    cmd,
    args,
    env: { ...options.env },
    cwd: options.cwd ?? "/vercel/sandbox",
    stdin: mode !== "run",
    detached: true,
  };
}
