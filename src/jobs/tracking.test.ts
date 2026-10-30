import { describe, expect, it } from "vitest";
import type { CliRunner } from "../cli";
import { collectTracking, projectRepos, recheckGithubItem, repoFromUrl } from "./tracking";

describe("project repos", () => {
  it("reads owner/name from GitHub links and merges them with configured repos", () => {
    expect(repoFromUrl("https://github.com/Unity/asset-store-web/pull/42")).toBe("Unity/asset-store-web");
    expect(repoFromUrl("https://github.com/a/b.git")).toBe("a/b");
    expect(repoFromUrl("https://unity.slack.com/archives/C1")).toBeNull();
    expect(projectRepos(["Unity/Asset-Store-Web"], ["https://github.com/unity/asset-store-web/tree/main", "https://github.com/x/y/pull/1", null])).toEqual([
      "unity/asset-store-web",
      "x/y",
    ]);
  });
});

const pr = (n: number, state: string, extra: object = {}) => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/a/b/pull/${n}`,
  state,
  isDraft: false,
  updatedAt: `2026-10-${20 + n}T10:00:00Z`,
  headRefName: `feature-${n}`,
  reviewDecision: "REVIEW_REQUIRED",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...extra,
});

const ref = (name: string, date: string, prState?: string) => ({
  name,
  target: { committedDate: date, url: "", statusCheckRollup: { state: "SUCCESS" } },
  associatedPullRequests: { nodes: prState ? [{ number: 9, state: prState }] : [] },
  compare: { aheadBy: 5, behindBy: 2 },
});

const fakeGh = (): CliRunner => async (_program, args) => {
  const query = args[args.indexOf("-f") + 1];
  if (query.includes("defaultBranchRef")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" } } } }) };
  if (query.includes("pullRequest(number")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: pr(3, "MERGED") } } }) };
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequests: { nodes: [pr(3, "OPEN"), pr(1, "MERGED")] },
          refs: { nodes: [ref("main", "2026-10-30T00:00:00Z"), ref("feature-3", "2026-10-29T00:00:00Z", "OPEN"), ref("old", "2026-10-01T00:00:00Z", "MERGED"), ref("spike", "2026-10-28T00:00:00Z")] },
        },
      },
    }),
  };
};

describe("tracking feed", () => {
  it("lists epics, recent PRs and open branches, newest first, with their status", async () => {
    const epic = { key: "CPS-1", title: "Refunds", status: "In Progress", done: 7, total: 12, link: "https://x.atlassian.net/browse/CPS-1", updated: "2026-10-30T12:00:00Z" };
    const t = await collectTracking(["a/b"], [epic], fakeGh());
    expect(t.items.map((i) => i.id)).toEqual(["epic:CPS-1", "branch:a/b:feature-3", "branch:a/b:spike", "pr:a/b#3", "pr:a/b#1"]);
    const open = t.items.find((i) => i.id === "pr:a/b#3")!;
    expect(open).toMatchObject({ state: "open", checks: "failing", review: "needed" });
    expect(t.items.find((i) => i.id === "pr:a/b#1")).toMatchObject({ state: "merged", checks: null, review: null });
    // Branches show how far they are from main; merged branches and main itself are left out.
    expect(t.items.find((i) => i.id === "branch:a/b:spike")!.detail).toBe("2 ahead, 5 behind main · no PR");
    expect(t.items.find((i) => i.id === "epic:CPS-1")!.detail).toBe("7 of 12 done");
  });

  it("reports a repo it couldn't read without dropping the rest", async () => {
    const failing: CliRunner = async () => ({ code: 1, stdout: "", stderr: "Could not resolve to a Repository" });
    const t = await collectTracking(["gone/repo"], [], failing);
    expect(t.items).toEqual([]);
    expect(t.errors[0]).toContain("gone/repo");
  });

  it("rechecks a single pull request", async () => {
    const t = await collectTracking(["a/b"], [], fakeGh());
    const fresh = await recheckGithubItem(t.items.find((i) => i.id === "pr:a/b#3")!, fakeGh());
    expect(fresh).toMatchObject({ id: "pr:a/b#3", state: "merged" });
  });
});
