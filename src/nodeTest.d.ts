// The two Node APIs the chat guard tests use to run its hook (see claude.test.ts). The app runs in
// a webview and has no Node types; adding @types/node would change globals like setTimeout for it.
declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: string[],
    options: { input: string; encoding: "utf8" },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
}
