/**
 * A project's tracking feed: its Jira epics and its pull requests and branches, each with its status,
 * newest activity first. Its code is only what's tied to its work: the pull requests and branches in
 * its repos that name one of its tickets, and the ones its plan links (see CodeScope). GitHub is read
 * locally with the gh CLI (no Claude call); epics come from project refreshes, which search Jira.
 */
import { runCli, type CliRunner } from "../cli";
import { codeLink, keysIn } from "../plan";
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
  /** Epic: how many child issues Jira counted. */
  total?: number;
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

/**
 * What a project's code is: the Jira keys of its work (a pull request or branch naming one is its
 * code) and the pull request and branch links its plan has (see PathItem.code and suggested_code).
 */
export interface CodeScope {
  keys: string[];
  links: string[];
}

/** How many of a repo's latest pull requests and branches are looked through for the project's keys. */
const LATEST = 100;
/** Keys per GitHub search: its queries take at most five ORs. */
const SEARCH_KEYS = 5;

async function defaultBranch(run: CliRunner, owner: string, name: string): Promise<string> {
  const { repository } = await graphql<{ repository: { defaultBranchRef: { name: string } | null } }>(
    run,
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}",
    { owner, name },
  );
  return repository.defaultBranchRef?.name ?? "main";
}

async function branchRef(run: CliRunner, owner: string, name: string, base: string, branch: string): Promise<GqlRef | null> {
  const { repository } = await graphql<{ repository: { ref: GqlRef | null } }>(
    run,
    `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){${REF_FIELDS(base)}}}}`,
    { owner, name, ref: `refs/heads/${branch}` },
  );
  return repository.ref;
}

/**
 * A repo's pull requests (any state) and its branches with none (not the default) that name one of
 * `keys`: in its latest ones, in its title or branch name, and in a search of its pull request titles
 * for older ones.
 */
async function repoItems(run: CliRunner, repo: string, keys: Set<string>): Promise<TrackedItem[]> {
  if (!keys.size) return [];
  const [owner, name] = repo.split("/");
  const names = (text: string) => keysIn(text).some((k) => keys.has(k));
  const base = await defaultBranch(run, owner, name);
  // Light lists first (GitHub times out on full details of this many); full details only for the ones that match.
  type Light = { number: number; title: string; headRefName: string };
  const { repository } = await graphql<{ repository: { pullRequests: { nodes: Light[] }; refs: { nodes: Pick<GqlRef, "name" | "associatedPullRequests">[] } } }>(
    run,
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:${LATEST},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title headRefName}} refs(refPrefix:"refs/heads/",first:${LATEST},orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name associatedPullRequests(first:1){nodes{number state}}}}}}`,
    { owner, name },
  );
  const numbers = new Set(repository.pullRequests.nodes.filter((pr) => names(`${pr.title} ${pr.headRefName}`)).map((pr) => pr.number));
  const all = [...keys];
  for (let i = 0; i < all.length; i += SEARCH_KEYS) {
    const q = `repo:${repo} is:pr in:title ${all.slice(i, i + SEARCH_KEYS).join(" OR ")}`;
    // Issues match too, and come back empty. A search GitHub refuses (it limits how many run a minute) leaves the latest ones.
    const { search } = await graphql<{ search: { nodes: Partial<Light>[] } }>(run, `query($q:String!){search(query:$q,type:ISSUE,first:20){nodes{... on PullRequest{number title headRefName}}}}`, { q }).catch(
      () => ({ search: { nodes: [] } }),
    );
    for (const pr of search.nodes) if (typeof pr.number === "number" && names(`${pr.title} ${pr.headRefName}`)) numbers.add(pr.number);
  }
  // A branch with a pull request shows as its pull request.
  const named = repository.refs.nodes.filter((ref) => ref.name !== base && names(ref.name) && !ref.associatedPullRequests.nodes.length);
  const [prs, branches] = await Promise.all([
    Promise.all([...numbers].map(async (n) => prItem(repo, (await graphqlPr(run, owner, name, n)).repository.pullRequest))),
    Promise.all(named.map((ref) => branchRef(run, owner, name, base, ref.name))),
  ]);
  return [...prs, ...branches.flatMap((ref) => (ref ? [branchItem(repo, base, ref)] : []))];
}

/** A pull request or branch the plan links, read on its own. */
async function linkedItem(run: CliRunner, url: string): Promise<TrackedItem | null> {
  const l = codeLink(url);
  if (!l) return null;
  const [owner, name] = l.repo.split("/");
  if (l.kind === "pr") return prItem(l.repo, (await graphqlPr(run, owner, name, Number(l.name.slice(1)))).repository.pullRequest);
  const base = await defaultBranch(run, owner, name);
  const ref = await branchRef(run, owner, name, base, l.name);
  return ref ? branchItem(l.repo, base, ref) : null;
}

export function epicItem(e: ProjectEpic): TrackedItem {
  return {
    id: `epic:${e.key}`,
    kind: "epic",
    title: `${e.key} ${e.title}`,
    url: e.link,
    state: e.status,
    detail: e.total ? `${e.done} of ${e.total} done` : null,
    total: e.total ?? undefined,
    updatedAt: e.updated ?? null,
    checkedAt: now(),
  };
}

/** Newest activity first; items with no date last. */
export const byRecency = (a: TrackedItem, b: TrackedItem) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/**
 * Builds a project's whole feed: its epics, plus its code (see CodeScope): what names its keys in
 * its repos, and what its plan links, wherever that is. Nothing else in its repos.
 */
export async function collectTracking(repos: string[], epics: ProjectEpic[], scope: CodeScope, run: CliRunner = runCli): Promise<ProjectTracking> {
  const errors: string[] = [];
  const keys = new Set([...scope.keys, ...epics.flatMap((e) => [e.key, ...(e.issues ?? [])])].map((k) => k.trim().toUpperCase()).filter(Boolean));
  const lists = await Promise.all(
    repos.map((repo) =>
      repoItems(run, repo, keys).catch((e: Error) => {
        errors.push(`${repo}: ${e.message}`);
        return [];
      }),
    ),
  );
  const found = new Map(lists.flat().map((i) => [i.id, i]));
  const links = [...new Map(scope.links.flatMap((url) => { const l = codeLink(url); return l && !found.has(l.id) ? [[l.id, url] as const] : []; })).values()];
  const linked = await Promise.all(
    links.map((url) =>
      linkedItem(run, url).catch((e: Error) => {
        errors.push(`${url}: ${e.message}`);
        return null;
      }),
    ),
  );
  for (const i of linked) if (i) found.set(i.id, i);
  return { items: [...epics.map(epicItem), ...found.values()].sort(byRecency), epics, repos, checkedAt: now(), errors };
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
    const ref = await branchRef(run, owner, name, base, branch);
    return ref ? branchItem(item.repo, base, ref) : null;
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
