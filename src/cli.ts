import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Text for a program that doesn't go on its command line, which Windows caps at about 32k
 * characters: what it reads on stdin, and (for claude) a system prompt to append, which Rust
 * passes as a temp file with --append-system-prompt-file.
 */
export interface CliInput {
  stdin?: string;
  appendSystemPrompt?: string;
}

export type CliRunner = (program: "claude" | "git" | "gh", args: string[], cwd?: string, input?: CliInput) => Promise<CliOutput>;

/** Runs an allowlisted program through the Rust `run_cli` command. */
export const runCli: CliRunner = (program, args, cwd, input) => invoke<CliOutput>("run_cli", { program, args, cwd, input });

export type StreamingCliRunner = (
  program: "claude" | "git" | "gh",
  args: string[],
  onLine?: (line: string) => void,
  input?: CliInput,
) => Promise<CliOutput>;

/** Runs an allowlisted program, calling `onLine` for each stdout line as it arrives. */
export const runCliStreaming: StreamingCliRunner = async (program, args, onLine, input) => {
  const streamId = crypto.randomUUID();
  const unlisten = onLine
    ? await listen<{ streamId: string; line: string }>("cli-line", (e) => {
        if (e.payload.streamId === streamId) onLine(e.payload.line);
      })
    : null;
  try {
    return await invoke<CliOutput>("run_cli_stream", { streamId, program, args, input });
  } finally {
    unlisten?.();
  }
};
