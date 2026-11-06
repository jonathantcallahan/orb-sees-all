import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { runCli, runCliStreaming } = await import("./cli");

describe("stopping a run", () => {
  beforeEach(() => invoke.mockReset());

  it("never starts a run whose signal has already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(runCliStreaming("claude", ["-p"], undefined, undefined, { signal: stop.signal })).rejects.toThrow("Stopped");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels the very run it started when the signal aborts", async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) => (cmd === "run_cli_stream" ? new Promise((r) => (finish = r)) : Promise.resolve(true)));
    const stop = new AbortController();
    const running = runCliStreaming("claude", ["-p"], () => {}, undefined, { signal: stop.signal, limits: { idleSecs: 600 } });
    await Promise.resolve();
    await Promise.resolve();
    stop.abort();
    const started = invoke.mock.calls.find(([cmd]) => cmd === "run_cli_stream")![1] as { streamId: string; limits: object };
    expect(started.limits).toEqual({ idleSecs: 600 });
    expect(invoke).toHaveBeenCalledWith("cancel_run", { id: started.streamId });
    finish({ code: 0, stdout: "", stderr: "" });
    await running;
  });

  it("gives a quick run its own id and passes its limits", async () => {
    invoke.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await runCli("gh", ["api", "x"], undefined, undefined, { limits: { totalSecs: 60 } });
    const [cmd, args] = invoke.mock.calls[0] as [string, { id: string; limits: object }];
    expect(cmd).toBe("run_cli");
    expect(args.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.limits).toEqual({ totalSecs: 60 });
  });
});
