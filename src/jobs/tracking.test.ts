import { describe, expect, it, vi } from "vitest";
import type { CliRunner } from "../cli";
import { collectTracking, projectRepos, recheckGithubItem, repoFromUrl } from "./tracking";

describe("project repos", () => {
  it("reads owner/name from GitHub links and merges them with configured repos", () => {
    expect(repoFromUrl("https://github.com/acme/shop-web/pull/42")).toBe("acme/shop-web");
    expect(repoFromUrl("https://github.com/a/b.git")).toBe("a/b");
    expect(repoFromUrl("https://example.slack.com/archives/C1")).toBeNull();
    expect(projectRepos(["Acme/Shop-Web"], ["https://github.com/acme/shop-web/tree/main", "https://github.com/x/y/pull/1", null])).toEqual([
      "acme/shop-web",
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

const arg = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";

// The repo's pull requests in full, by number; `merged` ones are merged since.
const PRS: Record<number, [string, object]> = {
  1: ["MERGED", { title: "Bump deps" }],
  2: ["OPEN", { headRefName: "pay-4-copy" }],
  3: ["OPEN", { title: "PAY-3 Wire the refund form" }],
  5: ["CLOSED", { title: "PAY-5 Old approach" }],
  7: ["OPEN", {}],
};

const fakeGh = (merged: number[] = []): CliRunner => async (_program, args) => {
  const query = arg(args, "query");
  const out = (data: object) => ({ code: 0, stderr: "", stdout: JSON.stringify({ data }) });
  if (query.includes("defaultBranchRef")) return out({ repository: { defaultBranchRef: { name: "main" } } });
  if (query.includes("pullRequest(number")) {
    const n = Number(arg(args, "n"));
    const [state, extra] = PRS[n];
    return out({ repository: { pullRequest: pr(n, merged.includes(n) ? "MERGED" : state, { ...extra, url: `https://github.com/${arg(args, "owner")}/${arg(args, "name")}/pull/${n}` }) } });
  }
  if (query.includes("ref(qualifiedName")) return out({ repository: { ref: ref(arg(args, "ref").replace("refs/heads/", ""), "2026-10-27T00:00:00Z") } });
  // An older pull request only the search of titles finds, and an issue, which comes back empty.
  if (query.includes("search(")) return out({ search: { nodes: [{ number: 5, title: "PAY-5 Old approach", headRefName: "old" }, {}] } });
  return out({
    repository: {
      pullRequests: { nodes: [{ number: 3, title: "PAY-3 Wire the refund form", headRefName: "feature-3" }, { number: 1, title: "Bump deps", headRefName: "deps" }, { number: 2, title: "Copy", headRefName: "pay-4-copy" }] },
      refs: { nodes: [ref("main", ""), ref("feature-pay-3", "", "OPEN"), ref("pay-4-spike", ""), ref("someone-elses-work", "")] },
    },
  });
};

describe("tracking feed", () => {
  const scope = { keys: ["PAY-3", "PAY-4", "PAY-5"], links: [] };

  it("lists epics and only the pull requests and branches that name the project's keys, newest first", async () => {
    const epic = { key: "PAY-1", title: "Refunds", status: "In Progress", done: 7, total: 12, link: "https://x.atlassian.net/browse/PAY-1", updated: "2026-10-30T12:00:00Z" };
    const t = await collectTracking(["a/b"], [epic], scope, fakeGh());
    // Not the dependency bump or someone else's branch; the branch with a pull request shows as its pull request.
    expect(t.items.map((i) => i.id)).toEqual(["epic:PAY-1", "branch:a/b:pay-4-spike", "pr:a/b#5", "pr:a/b#3", "pr:a/b#2"]);
    const open = t.items.find((i) => i.id === "pr:a/b#3")!;
    expect(open).toMatchObject({ state: "open", checks: "failing", review: "needed" });
    expect(t.items.find((i) => i.id === "pr:a/b#5")).toMatchObject({ state: "closed", checks: null, review: null });
    expect(t.items.find((i) => i.id === "branch:a/b:pay-4-spike")!.detail).toBe("2 ahead, 5 behind main · no PR");
    expect(t.items.find((i) => i.id === "epic:PAY-1")!.detail).toBe("7 of 12 done");
  });

  it("reads what the plan links, wherever it is, once", async () => {
    const links = ["https://github.com/x/y/pull/7/files", "https://github.com/a/b/pull/3", "https://github.com/x/y/tree/topic", "https://example.com/doc"];
    const t = await collectTracking(["a/b"], [], { keys: ["PAY-3"], links }, fakeGh());
    expect(t.items.map((i) => i.id).sort()).toEqual(["branch:x/y:topic", "pr:a/b#3", "pr:x/y#7"]);
    // Found in the repo already: not read again.
    expect(t.items.find((i) => i.id === "pr:a/b#3")!.state).toBe("open");
  });

  it("reads nothing of a repo when the project has no keys", async () => {
    const run = vi.fn<CliRunner>(fakeGh());
    const t = await collectTracking(["a/b"], [], { keys: [], links: [] }, run);
    expect(t.items).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a repo it couldn't read without dropping the rest", async () => {
    const failing: CliRunner = async () => ({ code: 1, stdout: "", stderr: "Could not resolve to a Repository" });
    const t = await collectTracking(["gone/repo"], [], scope, failing);
    expect(t.items).toEqual([]);
    expect(t.errors[0]).toContain("gone/repo");
  });

  it("rechecks a single pull request", async () => {
    const t = await collectTracking(["a/b"], [], scope, fakeGh());
    const fresh = await recheckGithubItem(t.items.find((i) => i.id === "pr:a/b#3")!, fakeGh([3]));
    expect(fresh).toMatchObject({ id: "pr:a/b#3", state: "merged" });
  });
});
