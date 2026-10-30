/**
 * A project's tracking feed: its Jira epics and, for its GitHub repos, recent pull requests and open
 * branches, each with its status, newest activity first. GitHub is read locally with the gh CLI (no
 * Claude call); epics come from project refreshes, which search Jira.
 */
import { runCli, type CliRunner } from "../cli";
import type { ProjectEpic } from "../schema";

export interface TrackedItem {
  /** "pr:owner/repo#12", "branch:owner/repo:name" or "epic:KEY". */
  id: string;
  kind: "pr" | "branch" | "epic";
  title: string;
  url: string;
  repo?: string;
  /** PR: open, draft, merged or closed. Branch: open. Epic: its Jira status. */
  state: string;
  checks?: "passing" | "failing" | "pending" | null;
  review?: "approved" | "changes" | "needed" | null;
  /** A short line under the title, e.g. "2 ahead, 5 behind main" or "7 of 12 done". */
  detail?: string | null;
  /** When it last changed, ISO 8601. */
  updatedAt: string | null;
  /** When Orb last looked. */
  checkedAt: string;
}

export interface ProjectTracking {
  items: TrackedItem[];
  /** The epics the last project refresh found, kept so the feed can be rebuilt without one. */
  epics: ProjectEpic[];
  /** GitHub repos it covers, "owner/name". */
  repos: string[];
  checkedAt: string;
  errors: string[];
}

/** "owner/name" from any github.com link to a repo, PR or file. */
export function repoFromUrl(url: string): string | null {
  const m = url.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A project's repos: the ones set in Settings plus GitHub links found in its profile and updates. */
export function projectRepos(configured: string[], links: (string | null | undefined)[]): string[] {
  const found = links.map((l) => (l ? repoFromUrl(l) : null)).filter((r): r is string => !!r);
  return [...new Set([...configured, ...found].map((r) => r.toLowerCase()))];
}

const CHECKS: Record<string, TrackedItem["checks"]> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};
const REVIEW: Record<string, TrackedItem["review"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "needed" };

interface GqlPr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface GqlRef {
  name: string;
  target: { committedDate: string; url: string; statusCheckRollup: { state: string } | null };
  associatedPullRequests: { nodes: { number: number; state: string }[] };
  compare: { aheadBy: number; behindBy: number } | null;
}

const PR_FIELDS = "number title url state isDraft updatedAt headRefName reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}";
const REF_FIELDS = (base: string) =>
  `name target{... on Commit{committedDate url statusCheckRollup{state}}} associatedPullRequests(first:1){nodes{number state}} compare(headRef:"${base}"){aheadBy behindBy}`;

async function graphql<T>(run: CliRunner, query: string, vars: Record<string, string>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
  const out = await run("gh", args);
  if (out.code !== 0) throw new Error(out.stderr.trim() || "gh api graphql failed");
  const json = JSON.parse(out.stdout);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

const now = () => new Date().toISOString();

export function prItem(repo: string, pr: GqlPr): TrackedItem {
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  return {
    id: `pr:${repo}#${pr.number}`,
    kind: "pr",
    title: `#${pr.number} ${pr.title}`,
    url: pr.url,
    repo,
    state,
    checks: state === "open" || state === "draft" ? (CHECKS[pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ""] ?? null) : null,
    review: state === "open" ? (REVIEW[pr.reviewDecision ?? ""] ?? null) : null,
    detail: pr.headRefName,
    updatedAt: pr.updatedAt,
    checkedAt: now(),
  };
}

export function branchItem(repo: string, base: string, ref: GqlRef): TrackedItem {
  const ahead = ref.compare?.behindBy ?? 0;
  const behind = ref.compare?.aheadBy ?? 0;
  const pr = ref.associatedPullRequests.nodes[0];
  return {
    id: `branch:${repo}:${ref.name}`,
    kind: "branch",
    title: ref.name,
    url: `https://github.com/${repo}/tree/${encodeURIComponent(ref.name)}`,
    repo,
    state: "open",
    checks: CHECKS[ref.target.statusCheckRollup?.state ?? ""] ?? null,
    detail: [`${ahead} ahead, ${behind} behind ${base}`, pr ? `PR #${pr.number}` : "no PR"].join(" · "),
    updatedAt: ref.target.committedDate,
    checkedAt: now(),
  };
}

/** Recent pull requests (any state) and open branches (not the default, not merged or closed) in a repo. */
async function repoItems(run: CliRunner, repo: string): Promise<TrackedItem[]> {
  const [owner, name] = repo.split("/");
  const { repository: head } = await graphql<{ repository: { defaultBranchRef: { name: string } | null } }>(
    run,
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}",
    { owner, name },
  );
  const base = head.defaultBranchRef?.name ?? "main";
  const { repository } = await graphql<{ repository: { pullRequests: { nodes: GqlPr[] }; refs: { nodes: GqlRef[] } } }>(
    run,
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:8,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}} refs(refPrefix:"refs/heads/",first:12,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{${REF_FIELDS(base)}}}}}`,
    { owner, name },
  );
  const prs = repository.pullRequests.nodes.map((pr) => prItem(repo, pr));
  const branches = repository.refs.nodes
    .filter((ref) => ref.name !== base && !["MERGED", "CLOSED"].includes(ref.associatedPullRequests.nodes[0]?.state ?? ""))
    .slice(0, 6)
    .map((ref) => branchItem(repo, base, ref));
  return [...prs, ...branches];
}

export function epicItem(e: ProjectEpic): TrackedItem {
  return {
    id: `epic:${e.key}`,
    kind: "epic",
    title: `${e.key} ${e.title}`,
    url: e.link,
    state: e.status,
    detail: e.total ? `${e.done} of ${e.total} done` : null,
    updatedAt: e.updated ?? null,
    checkedAt: now(),
  };
}

/** Newest activity first; items with no date last. */
export const byRecency = (a: TrackedItem, b: TrackedItem) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/** Builds a project's whole feed: its epics, plus every repo's PRs and branches. */
export async function collectTracking(repos: string[], epics: ProjectEpic[], run: CliRunner = runCli): Promise<ProjectTracking> {
  const errors: string[] = [];
  const lists = await Promise.all(
    repos.map((repo) =>
      repoItems(run, repo).catch((e: Error) => {
        errors.push(`${repo}: ${e.message}`);
        return [];
      }),
    ),
  );
  return { items: [...epics.map(epicItem), ...lists.flat()].sort(byRecency), epics, repos, checkedAt: now(), errors };
}

/** Looks at one PR or branch again. (Epics are rechecked through Jira; see recheckEpic in jobs.) */
export async function recheckGithubItem(item: TrackedItem, run: CliRunner = runCli): Promise<TrackedItem | null> {
  if (!item.repo) return null;
  const [owner, name] = item.repo.split("/");
  if (item.kind === "pr") {
    const { repository } = await graphqlPr(run, owner, name, Number(item.id.split("#")[1]));
    return prItem(item.repo, repository.pullRequest);
  }
  if (item.kind === "branch") {
    const branch = item.id.slice(`branch:${item.repo}:`.length);
    const base = item.detail?.match(/behind (\S+)/)?.[1] ?? "main";
    const { repository } = await graphql<{ repository: { ref: GqlRef | null } }>(
      run,
      `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){${REF_FIELDS(base)}}}}`,
      { owner, name, ref: `refs/heads/${branch}` },
    );
    return repository.ref ? branchItem(item.repo, base, repository.ref) : null;
  }
  return null;
}

/** One pull request; its number goes as an Int (-F), which -f's strings can't do. */
async function graphqlPr(run: CliRunner, owner: string, name: string, n: number) {
  const query = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){${PR_FIELDS}}}}`;
  const out = await run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${n}`]);
  if (out.code !== 0) throw new Error(out.stderr.trim() || "gh api graphql failed");
  return JSON.parse(out.stdout).data as { repository: { pullRequest: GqlPr } };
}
