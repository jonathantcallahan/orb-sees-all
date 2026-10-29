import { runCli, type CliRunner } from "../cli";
import type { LocalRepoState, PullRequest, RepoState } from "../schema";

async function git(run: CliRunner, path: string, args: string[]) {
  const out = await run("git", ["-C", path, ...args]);
  if (out.code !== 0) throw new Error(out.stderr.trim() || `git ${args[0]} failed`);
  return out.stdout.trim();
}

async function localState(run: CliRunner, path: string): Promise<LocalRepoState> {
  try {
    const branch = await git(run, path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await git(run, path, ["status", "--porcelain"]);
    const state: LocalRepoState = { path, branch, dirty: status ? status.split("\n").length : 0 };
    try {
      const [ahead, behind] = (await git(run, path, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/);
      state.ahead = Number(ahead);
      state.behind = Number(behind);
    } catch {
      // No upstream branch; leave ahead/behind unset.
    }
    return state;
  } catch (e) {
    return { path, error: (e as Error).message };
  }
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
}

async function prs(run: CliRunner, repo: string, kind: PullRequest["kind"]): Promise<PullRequest[]> {
  const filter = kind === "mine" ? ["--author", "@me"] : ["--search", "review-requested:@me"];
  const out = await run("gh", [
    "pr", "list", "-R", repo, "--state", "open", ...filter,
    "--json", "number,title,url,isDraft,reviewDecision",
  ]);
  if (out.code !== 0) throw new Error(`gh pr list ${repo}: ${out.stderr.trim()}`);
  return (JSON.parse(out.stdout) as GhPr[]).map((pr) => ({ ...pr, repo, kind }));
}

/** Branch and dirty state of local repos, plus open PRs that involve the user. */
export async function collectRepoState(localRepos: string[], ghRepos: string[], run: CliRunner = runCli): Promise<RepoState> {
  const errors: string[] = [];
  const local = await Promise.all(localRepos.map((path) => localState(run, path)));
  const prLists = await Promise.all(
    ghRepos.flatMap((repo) =>
      (["mine", "review_requested"] as const).map((kind) =>
        prs(run, repo, kind).catch((e: Error) => {
          errors.push(e.message);
          return [];
        }),
      ),
    ),
  );
  return { local, prs: prLists.flat(), errors };
}
