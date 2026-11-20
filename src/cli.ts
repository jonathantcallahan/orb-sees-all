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
  /** Streaming runs: keep stdin open once `stdin` is written, to write to it as the run goes (see RunControl.onInput). */
  keepStdinOpen?: boolean;
}

/** A running program's stdin, for a run started with keepStdinOpen. */
export interface RunInput {
  write(text: string): Promise<void>;
  /** Closes stdin, which ends a program that reads until it's closed. */
  close(): Promise<void>;
  /** Marks the run as waiting on the user, so it isn't stopped for going quiet meanwhile. */
  waiting(on: boolean): Promise<void>;
}

/**
 * How long a run may take before Rust stops it (and everything it started): without printing a line
 * (`idleSecs`), and in all (`totalSecs`). Rust's defaults apply to what's left out: five minutes in
 * all for runCli; ten minutes quiet or an hour in all for runCliStreaming.
 */
export interface RunLimits {
  idleSecs?: number;
  totalSecs?: number;
}

/** A run's limits, and a signal that stops it when aborted (the run then rejects with "Stopped"). */
export interface RunControl {
  limits?: RunLimits;
  signal?: AbortSignal;
  /** The folder to run in, for a streaming run; otherwise the app's own work folder. */
  cwd?: string;
  /** Given the run's stdin before it starts, for a streaming run with keepStdinOpen. */
  onInput?: (io: RunInput) => void;
}

export type CliRunner = (program: "claude" | "git" | "gh", args: string[], cwd?: string, input?: CliInput, control?: RunControl) => Promise<CliOutput>;

/** Stops the run `id` when `signal` aborts; returns the cleanup. */
function stopOnAbort(id: string, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const stop = () => void invoke("cancel_run", { id }).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

/** Runs an allowlisted program through the Rust `run_cli` command. */
export const runCli: CliRunner = async (program, args, cwd, input, control) => {
  if (control?.signal?.aborted) throw new Error("Stopped");
  const id = crypto.randomUUID();
  const done = stopOnAbort(id, control?.signal);
  try {
    return await invoke<CliOutput>("run_cli", { program, args, cwd, input, id, limits: control?.limits });
  } finally {
    done();
  }
};

export type StreamingCliRunner = (
  program: "claude" | "git" | "gh",
  args: string[],
  onLine?: (line: string) => void,
  input?: CliInput,
  control?: RunControl,
) => Promise<CliOutput>;

/** Runs an allowlisted program, calling `onLine` for each stdout line as it arrives. */
export const runCliStreaming: StreamingCliRunner = async (program, args, onLine, input, control) => {
  if (control?.signal?.aborted) throw new Error("Stopped");
  const streamId = crypto.randomUUID();
  const done = stopOnAbort(streamId, control?.signal);
  control?.onInput?.({
    write: (text) => invoke("write_run_stdin", { id: streamId, text }),
    close: () => invoke<boolean>("close_run_stdin", { id: streamId }).then(() => {}),
    waiting: (on) => invoke<boolean>("set_run_waiting", { id: streamId, waiting: on }).then(() => {}),
  });
  const unlisten = onLine
    ? await listen<{ streamId: string; line: string }>("cli-line", (e) => {
        if (e.payload.streamId === streamId) onLine(e.payload.line);
      })
    : null;
  try {
    return await invoke<CliOutput>("run_cli_stream", { streamId, program, args, cwd: control?.cwd, input, limits: control?.limits });
  } finally {
    unlisten?.();
    done();
  }
};
