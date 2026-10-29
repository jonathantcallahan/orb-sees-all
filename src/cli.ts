import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (program: "claude" | "git" | "gh", args: string[], cwd?: string) => Promise<CliOutput>;

/** Runs an allowlisted program through the Rust `run_cli` command. */
export const runCli: CliRunner = (program, args, cwd) => invoke<CliOutput>("run_cli", { program, args, cwd });

export type StreamingCliRunner = (
  program: "claude" | "git" | "gh",
  args: string[],
  onLine?: (line: string) => void,
) => Promise<CliOutput>;

/** Runs an allowlisted program, calling `onLine` for each stdout line as it arrives. */
export const runCliStreaming: StreamingCliRunner = async (program, args, onLine) => {
  const streamId = crypto.randomUUID();
  const unlisten = onLine
    ? await listen<{ streamId: string; line: string }>("cli-line", (e) => {
        if (e.payload.streamId === streamId) onLine(e.payload.line);
      })
    : null;
  try {
    return await invoke<CliOutput>("run_cli_stream", { streamId, program, args });
  } finally {
    unlisten?.();
  }
};
