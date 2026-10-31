import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("streamed session replies", () => {
  it("reports Claude's text as it arrives", async () => {
    const { runSessionTurn } = await import("./claude");
    const lines = [
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "there" } } },
      { type: "result", subtype: "success", is_error: false, result: "Hello there", session_id: "s1", total_cost_usd: 0 },
    ].map((l) => JSON.stringify(l));
    const seen: string[] = [];
    let args: string[] = [];
    await runSessionTurn({ prompt: "hi", tools: [], onText: (t) => seen.push(t) }, async (_p, a, onLine) => {
      args = a;
      lines.forEach((l) => onLine?.(l));
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    });
    expect(args).toContain("--include-partial-messages");
    expect(seen.at(-1)).toBe("Hello there");
  });
});
