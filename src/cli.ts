import { invoke } from "@tauri-apps/api/core";

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (program: "claude" | "git" | "gh", args: string[], cwd?: string) => Promise<CliOutput>;

/** Runs an allowlisted program through the Rust `run_cli` command. */
export const runCli: CliRunner = (program, args, cwd) => invoke<CliOutput>("run_cli", { program, args, cwd });
